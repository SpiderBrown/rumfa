import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';
import { Ui } from './ui';

/**
 * Click-to-call. With the Africa's Talking WebRTC client configured, the
 * operator speaks through the browser and the other person gets a normal
 * phone call. Without it, the platform rings the operator's own phone first
 * and then connects the other person (bridged call).
 */
@Injectable({ providedIn: 'root' })
export class Calls {
  private api = inject(Api);
  private ui = inject(Ui);
  readonly active = signal<{ callId: string; label: string; via: 'browser' | 'phone' } | null>(null);
  private client: any = null;

  private async loadClient(): Promise<any> {
    if (this.client) return this.client;
    const src = window.RUMFA_CONFIG.atWebrtcScript;
    if (!src) return null;
    await new Promise<void>((res, rej) => {
      const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load call client'));
      document.head.appendChild(s);
    });
    const { token } = await this.api.post<{ token: string }>('/calls/token');
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
        const { callId, phone } = await this.api.post<{ callId: string; phone: string }>('/calls/prepare', { target, id, caseId, reason });
        client.call(phone);
        this.active.set({ callId, label, via: 'browser' });
      } else if (target === 'volunteer') {
        const { callId } = await this.api.post<{ callId: string }>('/calls/bridge', { volunteerId: id, caseId, reason });
        this.active.set({ callId, label, via: 'phone' });
        this.ui.toast('Your phone will ring first, then we connect ' + label);
      } else {
        // Authority contacts: register the call, then dial from the operator's phone
        const { phone } = await this.api.post<{ callId: string; phone: string }>('/calls/prepare', { target, id, caseId, reason });
        window.location.href = `tel:${phone}`;
      }
    });
  }

  hangup() { this.client?.hangup?.(); this.active.set(null); }
}
