import { Injectable, computed, inject, signal } from '@angular/core';
import { ActionSheetController } from '@ionic/angular';
import { Api, type CallOptions } from './api';
import { Ui } from './ui';
import { VoiceRoom } from './voice-room';

export type CallMode = keyof CallOptions;
export interface Callee { id: string; full_name: string; role: string }

const MODE_TEXT: Record<CallMode, string> = {
  inapp: 'App call (free, uses data)',
  phone: 'Phone call (your airtime)',
  bridged: 'Rumfa call (we ring you first, free)',
  webrtc: 'Internet call (uses data)',
};

/**
 * Calls from the app, in the ways the organisation allows:
 *  - phone: the phone's own dialler
 *  - bridged: Rumfa rings this phone first, then connects the other person
 *  - webrtc: speak over mobile data; the other person gets a normal phone call (Africa's Talking client)
 *  - inapp: free app call over the internet to someone using a Rumfa app (LiveKit); rings in their app
 */
export interface ActiveCall {
  label: string;
  kind: 'webrtc' | 'app';
  /** calling: ringing the other person; incoming: they are ringing me; connected: talking */
  phase: 'calling' | 'incoming' | 'connected';
  callId?: string;
  muted?: boolean;
}
const ENDED: Record<string, string> = { completed: 'Call ended', no_answer: 'No answer', busy: 'They could not take the call', failed: 'Call failed' };

@Injectable({ providedIn: 'root' })
export class Calls {
  private api = inject(Api);
  private ui = inject(Ui);
  private sheets = inject(ActionSheetController);
  private client: any = null;
  private voice: VoiceRoom | null = null;
  private ringTimer: any = null;
  private vibrateTimer: any = null;
  private ringer: { stop: () => void } | null = null;
  readonly active = signal<ActiveCall | null>(null);
  /** Internet calls also need the call client set up in this app's config. */
  readonly modes = computed(() => (['inapp', 'bridged', 'webrtc', 'phone'] as CallMode[])
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
      if (this.active()) { await this.ui.error('You are already on a call'); return; }
      if (mode === 'inapp') await VoiceRoom.checkMic();
      const client = mode === 'webrtc' ? await this.loadClient() : null;
      const r = await this.api.post<{ phone?: string; callId?: string; url?: string; token?: string; ringSeconds?: number }>(
        `/channels/${channelId}/call`, { personId: who.id, mode });
      if (mode === 'inapp') { await this.ringOut(r.callId!, who.full_name, r.url!, r.token!, r.ringSeconds ?? 45); return; }
      if (mode === 'phone') window.location.href = `tel:${r.phone}`;
      else if (mode === 'bridged') await this.ui.toast(`Your phone will ring first, then we connect ${who.full_name}`);
      else { client.call(r.phone); this.active.set({ label: who.full_name, kind: 'webrtc', phase: 'connected' }); }
    } catch (e) { await this.ui.error(e); }
  }

  hangup() {
    const a = this.active();
    if (a?.kind === 'app' && a.callId) { void this.endApp(a.callId, a.phase === 'incoming' ? 'declined' : 'hangup'); return; }
    this.client?.hangup?.(); this.active.set(null);
  }

  toggleMute() {
    const a = this.active();
    if (!a || a.kind !== 'app') return;
    this.voice?.setMuted(!a.muted);
    this.active.set({ ...a, muted: !a.muted });
  }

  // ---- App calls -------------------------------------------------------------------------------------
  /** Join the call room straight away and ring; gives up after the ring time. */
  private async ringOut(callId: string, label: string, url: string, token: string, ringSeconds: number) {
    this.active.set({ label, kind: 'app', phase: 'calling', callId });
    this.ringTimer = setTimeout(() => void this.endApp(callId, 'timeout'), ringSeconds * 1000);
    try { await this.joinVoice(url, token, callId); } catch (e) { await this.endApp(callId, 'hangup'); throw e; }
  }

  /** A call ringing for me (from a live update, a push notification, or when the app opens). */
  async incoming(callId: string) {
    const cur = this.active();
    if (cur?.callId === callId) return;
    const c = await this.api.get<{ status: string; me: string; caller: { full_name: string } }>(`/calls/app/${callId}`).catch(() => null);
    if (!c || c.status !== 'ringing' || c.me !== 'callee') return;
    if (cur) { void this.api.post(`/calls/app/${callId}/end`, { reason: 'declined' }).catch(() => undefined); return; } // already on a call
    this.active.set({ label: c.caller.full_name, kind: 'app', phase: 'incoming', callId });
    navigator.vibrate?.([600, 400, 600]);
    this.vibrateTimer = setInterval(() => navigator.vibrate?.([600, 400, 600]), 2000);
    this.ringer = ring();
  }

  async answer() {
    const a = this.active();
    if (a?.kind !== 'app' || a.phase !== 'incoming' || !a.callId) return;
    // Keeps ringing if the microphone is blocked, so they can allow it and answer
    try { await VoiceRoom.checkMic(); } catch (e) { await this.ui.error(e); return; }
    this.stopRinging();
    try {
      const r = await this.api.post<{ url: string; token: string }>(`/calls/app/${a.callId}/answer`);
      await this.joinVoice(r.url, r.token, a.callId);
      this.active.set({ ...a, phase: 'connected' });
    } catch (e) { this.reset(); await this.ui.error(e); }
  }

  /** Live updates about app calls I am in. */
  onCallChange(c: { id?: string; op: string; status?: string }) {
    if (!c.id) return;
    const a = this.active();
    if (c.status === 'ringing' && c.op === 'insert') { void this.incoming(c.id); return; }
    if (a?.callId !== c.id) return;
    if (c.status === 'answered' && a.phase === 'calling') { clearTimeout(this.ringTimer); this.active.set({ ...a, phase: 'connected' }); }
    else if (c.status && ENDED[c.status]) { this.reset(); void this.ui.toast(ENDED[c.status], 'medium'); }
  }

  /** On app start or reconnect: anything ringing for me. */
  async checkIncoming() {
    const list = await this.api.get<{ id: string }[]>('/calls/app/incoming').catch(() => []);
    if (list[0]) await this.incoming(list[0].id);
  }

  private async joinVoice(url: string, token: string, callId: string) {
    this.voice = new VoiceRoom();
    await this.voice.join(url, token, () => { if (this.active()?.callId === callId) void this.endApp(callId, 'hangup'); });
  }

  private async endApp(callId: string, reason: 'hangup' | 'declined' | 'timeout') {
    const r = await this.api.post<{ status: string }>(`/calls/app/${callId}/end`, { reason }).catch(() => null);
    if (this.active()?.callId !== callId) return;
    this.reset();
    if (reason === 'timeout') await this.ui.toast('No answer', 'medium');
    else if (r?.status === 'completed') await this.ui.toast('Call ended', 'medium');
  }

  private stopRinging() { clearInterval(this.vibrateTimer); this.vibrateTimer = null; navigator.vibrate?.(0); this.ringer?.stop(); this.ringer = null; }

  private reset() {
    clearTimeout(this.ringTimer); this.stopRinging();
    void this.voice?.leave(); this.voice = null;
    this.active.set(null);
  }

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

/** A two-tone ring while a call comes in (the phone also vibrates). Same sound as the dashboard. */
function ring(): { stop: () => void } {
  let ctx: AudioContext | null = null;
  try { ctx = new AudioContext(); } catch { return { stop: () => undefined }; }
  const beep = () => {
    for (const [f, at] of [[880, 0], [660, 0.25]] as const) {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      o.frequency.value = f; g.gain.value = 0.15;
      o.connect(g).connect(ctx!.destination);
      o.start(ctx!.currentTime + at); o.stop(ctx!.currentTime + at + 0.2);
    }
  };
  beep();
  const t = setInterval(beep, 2000);
  return { stop: () => { clearInterval(t); void ctx?.close(); } };
}
