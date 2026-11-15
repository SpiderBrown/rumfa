import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AppConfig } from '../config/configuration';

/** Outbound calls to Africa's Talking voice and LiveKit tokens. */
@Injectable()
export class ProvidersService {
  constructor(private readonly config: ConfigService, private readonly jwt: JwtService) {}

  private get at() { return this.config.get<AppConfig['at']>('at')!; }
  private get lk() { return this.config.get<AppConfig['livekit']>('livekit')!; }

  /** Rings `to` from our voice number; when answered, the voice webhook connects the second leg. */
  async atMakeCall(to: string, clientRequestId: string): Promise<string | null> {
    const base = this.at.username === 'sandbox' ? 'https://voice.sandbox.africastalking.com' : 'https://voice.africastalking.com';
    const res = await fetch(`${base}/call`, {
      method: 'POST',
      headers: { apiKey: this.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.at.username, from: this.at.voiceNumber, to, clientRequestId }),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Call failed (${res.status})`);
    const entry = (await res.json())?.entries?.[0];
    if (entry?.status !== 'Queued') throw new ServiceUnavailableException('Call was not queued');
    return entry.sessionId ?? null;
  }

  /** WebRTC capability token for a browser operator (outgoing calls only). */
  async atCapabilityToken(clientName: string): Promise<{ token: string; lifeTimeSec: string }> {
    const res = await fetch('https://webrtc.africastalking.com/capability-token/request', {
      method: 'POST',
      headers: { apiKey: this.at.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.at.username, clientName, phoneNumber: this.at.voiceNumber, incoming: 'false', outgoing: 'true', expire: '3600s' }),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Calling token failed (${res.status})`);
    return res.json() as any;
  }

  livekitUrl() { return this.lk.url; }

  livekitToken(identity: string, name: string, room: string, canPublish: boolean, ttlSec = 1800): string {
    return this.jwt.sign(
      { name, video: { room, roomJoin: true, canPublish, canSubscribe: !canPublish, canPublishData: false, canPublishSources: canPublish ? ['camera', 'microphone'] : [] } },
      { secret: this.lk.apiSecret, issuer: this.lk.apiKey, subject: identity, expiresIn: ttlSec, notBefore: -10, algorithm: 'HS256' },
    );
  }

  verifyLivekitWebhook(authHeader: string | undefined): any {
    return this.jwt.verify(authHeader ?? '', { secret: this.lk.apiSecret, issuer: this.lk.apiKey, algorithms: ['HS256'] });
  }
}
