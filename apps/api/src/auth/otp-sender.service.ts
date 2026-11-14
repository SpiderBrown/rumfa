import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';

/** Delivers one-time codes. OTP_MODE=console prints them; fixed sends nothing (the code is FIXED_OTP). */
@Injectable()
export class OtpSender {
  private readonly log = new Logger('OtpSender');
  constructor(private readonly config: ConfigService) {}

  async send(phone: string, channel: 'sms' | 'whatsapp', code: string, brand: string, minutes: number): Promise<void> {
    const mode = this.config.get<AppConfig['auth']>('auth')!.otpMode;
    const text = `${brand}: your sign-in code is ${code}. It expires in ${minutes} minutes. Do not share it.`;
    if (mode === 'console') { this.log.warn(`[OTP_MODE=console] ${channel} to ${phone}: ${text}`); return; }
    if (mode === 'fixed') return;
    try {
      if (channel === 'sms') await this.sms(phone, text);
      else await this.whatsapp(phone, code);
    } catch (e) {
      this.log.error(`Could not send ${channel} code to ${phone}: ${(e as Error).message}`);
      throw new ServiceUnavailableException('Could not send the code. Try again, or ask your coordinator for an activation code.');
    }
  }

  private async sms(to: string, message: string): Promise<void> {
    const at = this.config.get<AppConfig['at']>('at')!;
    const host = at.username === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
    const body = new URLSearchParams({ username: at.username, to, message, ...(at.senderId ? { from: at.senderId } : {}) });
    const res = await fetch(`https://${host}/version1/messaging`, {
      method: 'POST', headers: { apiKey: at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!res.ok) throw new Error(`Africa's Talking ${res.status}`);
    const j: any = await res.json();
    const r = j?.SMSMessageData?.Recipients?.[0];
    if (!r || !['Success', 'Sent'].includes(r.status)) throw new Error(`SMS not accepted: ${r?.status ?? 'no recipient'}`);
  }

  private async whatsapp(to: string, code: string): Promise<void> {
    const wa = this.config.get<AppConfig['whatsapp']>('whatsapp')!;
    const res = await fetch(`https://graph.facebook.com/v21.0/${wa.phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${wa.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'template',
        template: { name: wa.codeTemplate, language: { code: 'en' },
          components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp ${res.status}`);
  }
}
