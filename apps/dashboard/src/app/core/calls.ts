import { Injectable, inject, signal } from '@angular/core';
import { Supa } from './supabase';
import { Ui } from './ui';

/**
 * Click-to-call. With the Africa's Talking WebRTC client configured, the
 * operator speaks through the browser and the other person gets a normal
 * phone call. Without it, the platform rings the operator's own phone first
 * and then connects the other person (bridged call).
 */
@Injectable({ providedIn: 'root' })
export class Calls {
  private supa = inject(Supa);
  private ui = inject(Ui);
  readonly active = signal<{ callId: string; label: string; via: 'browser' | 'phone' } | null>(null);
  private client: any = null;

  private async loadClient(): Promise<any> {
    if (this.client) return this.client;
    const src = window.ALAWA_CONFIG.atWebrtcScript;
    if (!src) return null;
    await new Promise<void>((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load call client'));
      document.head.appendChild(s);
    });
    const { token } = await this.supa.fn<{ token: string }>('calls', { action: 'token' });
    const AT = (window as any).Africastalking;
    this.client = new AT.Client(token);
    this.client.on('hangup', () => this.active.set(null));
    await new Promise((r) => this.client.on('ready', r));
    return this.client;
  }

  /** Call a volunteer or authority contact, optionally from a case. */
  async call(target: 'volunteer' | 'contact', id: string, label: string, caseId?: string, reason?: string) {
    await this.ui.run(async () => {
      const client = await this.loadClient().catch(() => null);
      if (client) {
        const { call_id, phone } = await this.supa.fn<{ call_id: string; phone: string }>('calls',
          { action: 'prepare', target, id, case_id: caseId ?? null, reason: reason ?? null });
        client.call(phone);
        this.active.set({ callId: call_id, label, via: 'browser' });
      } else if (target === 'volunteer') {
        const { call_id } = await this.supa.fn<{ call_id: string }>('calls', { action: 'bridge', volunteer_id: id, case_id: caseId ?? null, reason });
        this.active.set({ callId: call_id, label, via: 'phone' });
        this.ui.toast('Your phone will ring first, then we connect ' + label);
      } else {
        // Authority contacts: register the call, then dial from the operator's phone
        const { phone } = await this.supa.fn<{ call_id: string; phone: string }>('calls',
          { action: 'prepare', target, id, case_id: caseId ?? null, reason: reason ?? null });
        window.location.href = `tel:${phone}`;
      }
    });
  }

  hangup() { this.client?.hangup?.(); this.active.set(null); }
}
