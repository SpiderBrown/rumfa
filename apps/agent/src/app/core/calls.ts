import { Injectable, computed, inject, signal } from '@angular/core';
import { ActionSheetController } from '@ionic/angular';
import { Api, type CallOptions } from './api';
import { Ui } from './ui';

export type CallMode = keyof CallOptions;
export interface Callee { id: string; full_name: string; role: string }

const MODE_TEXT: Record<CallMode, string> = {
  phone: 'Phone call (your airtime)',
  bridged: 'Rumfa call (we ring you first, free)',
  webrtc: 'Internet call (uses data)',
};

/**
 * Calls from the app, in the ways the organisation allows:
 *  - phone: the phone's own dialler
 *  - bridged: Rumfa rings this phone first, then connects the other person
 *  - webrtc: speak over mobile data; the other person gets a normal phone call (Africa's Talking client)
 */
@Injectable({ providedIn: 'root' })
export class Calls {
  private api = inject(Api);
  private ui = inject(Ui);
  private sheets = inject(ActionSheetController);
  private client: any = null;
  readonly active = signal<{ label: string } | null>(null);
  /** Internet calls also need the call client set up in this app's config. */
  readonly modes = computed(() => (['bridged', 'webrtc', 'phone'] as CallMode[])
    .filter((m) => this.api.callOptions()[m] && (m !== 'webrtc' || !!window.RUMFA_CONFIG.atWebrtcScript)));

  /** Pick who and how, then call. */
  async fromChat(channelId: string, people: Callee[]) {
    if (!people.length) { await this.ui.error('No one to call in this chat yet'); return; }
    if (!this.modes().length) { await this.ui.error('Calling is turned off for your organisation'); return; }
    const who = people.length === 1 ? people[0]
      : await this.choose('Call', people.map((p) => ({ text: `${p.full_name} (${p.role.replace('_', ' ')})`, value: p })));
    if (!who) return;
    const mode = this.modes().length === 1 ? this.modes()[0]
      : await this.choose(`Call ${who.full_name}`, this.modes().map((m) => ({ text: MODE_TEXT[m], value: m })));
    if (!mode) return;
    await this.start(channelId, who, mode);
  }

  async start(channelId: string, who: Callee, mode: CallMode) {
    try {
      // the call client loads first, so a number is only registered when the call can really start
      const client = mode === 'webrtc' ? await this.loadClient() : null;
      const r = await this.api.post<{ phone?: string }>(`/channels/${channelId}/call`, { personId: who.id, mode });
      if (mode === 'phone') window.location.href = `tel:${r.phone}`;
      else if (mode === 'bridged') await this.ui.toast(`Your phone will ring first, then we connect ${who.full_name}`);
      else { client.call(r.phone); this.active.set({ label: who.full_name }); }
    } catch (e) { await this.ui.error(e); }
  }

  hangup() { this.client?.hangup?.(); this.active.set(null); }

  private async loadClient(): Promise<any> {
    if (this.client) return this.client;
    const src = window.RUMFA_CONFIG.atWebrtcScript;
    if (!src) throw new Error('Internet calls are not set up in this app');
    if (!(window as any).Africastalking) {
      await new Promise<void>((res, rej) => {
        const s = document.createElement('script'); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error('Could not load the call client. Check your internet.'));
        document.head.appendChild(s);
      });
    }
    const { token } = await this.api.post<{ token: string }>('/calls/token');
    const client = new (window as any).Africastalking.Client(token);
    client.on('hangup', () => this.active.set(null));
    await new Promise<void>((res, rej) => { client.on('ready', () => res()); client.on('notready', () => rej(new Error('Internet call could not start'))); });
    this.client = client;
    return client;
  }

  private async choose<T>(header: string, options: { text: string; value: T }[]): Promise<T | null> {
    const sheet = await this.sheets.create({ header, buttons: [
      ...options.map((o, i) => ({ text: o.text, data: i })), { text: 'Cancel', role: 'cancel' }] });
    await sheet.present();
    const { data, role } = await sheet.onDidDismiss();
    return role === 'cancel' || typeof data !== 'number' ? null : options[data].value;
  }
}
