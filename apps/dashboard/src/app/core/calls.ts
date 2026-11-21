import { Injectable, inject, signal } from '@angular/core';
import { Api } from './api';
import { Ui } from './ui';
import { VoiceRoom } from './voice-room';

/**
 * Calls from the dashboard.
 *  - Phone network: with the Africa's Talking WebRTC client configured, the operator speaks through the
 *    browser and the other person gets a normal phone call. Without it, the platform rings the operator's
 *    own phone first and then connects the other person (bridged call).
 *  - App call (when the organisation turns it on): free, over the internet, to someone using a Rumfa app.
 *    It rings in their app; people can also app-call the dashboard, which rings here.
 */
export interface ActiveCall {
  callId: string;
  label: string;
  via: 'browser' | 'phone' | 'app';
  /** App calls: calling (ringing them), incoming (ringing me), connected */
  phase: 'calling' | 'incoming' | 'connected';
  muted?: boolean;
}
const ENDED: Record<string, string> = { completed: 'Call ended', no_answer: 'No answer', busy: 'They could not take the call', failed: 'Call failed' };

@Injectable({ providedIn: 'root' })
export class Calls {
  private api = inject(Api);
  private ui = inject(Ui);
  readonly active = signal<ActiveCall | null>(null);
  private client: any = null;
  private voice: VoiceRoom | null = null;
  private ringTimer: any = null;
  private ringer: { stop: () => void } | null = null;

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

  private dialled = false;
  /**
   * Call a volunteer or authority contact, optionally from a case. Volunteers can also get a free app call.
   * Resolves true when a call was actually placed (or the number handed to the phone), false when cancelled or failed.
   */
  async call(target: 'volunteer' | 'contact', id: string, label: string, caseId?: string, reason?: string): Promise<boolean> {
    this.dialled = false;
    await this.place(target, id, label, caseId, reason);
    return !!this.active() || this.dialled;
  }
  private async place(target: 'volunteer' | 'contact', id: string, label: string, caseId?: string, reason?: string) {
    if (this.active()) { this.ui.error('You are already on a call. Hang up first.'); return; }
    if (target === 'volunteer' && this.api.callOptions().inapp) {
      const how = await this.ui.choose(`Call ${label}`, '', [
        { label: 'App call', hint: 'Free, over the internet. Rings in their Rumfa app; they need data.', value: 'app' as const },
        { label: 'Phone call', hint: 'Through the phone network. Works on weak signal; costs per minute.', value: 'phone' as const },
      ]);
      if (!how) return;
      if (how === 'app') { await this.callApp(id, label, caseId, reason); return; }
    }
    await this.ui.run(async () => {
      const client = await this.loadClient().catch(() => null);
      if (client) {
        const { callId, phone } = await this.api.post<{ callId: string; phone: string }>('/calls/prepare', { target, id, caseId, reason });
        client.call(phone);
        this.active.set({ callId, label, via: 'browser', phase: 'connected' });
      } else if (target === 'volunteer') {
        try {
          const { callId } = await this.api.post<{ callId: string }>('/calls/bridge', { volunteerId: id, caseId, reason });
          this.active.set({ callId, label, via: 'phone', phase: 'connected' });
          this.ui.toast('Your phone will ring first, then we connect ' + label);
        } catch (e) {
          // Rumfa couldn't place the call (phone provider not reachable or not set up): offer the person's number instead
          const { phone } = await this.api.post<{ callId: string; phone: string }>('/calls/prepare', { target, id, caseId, reason: (reason ?? 'call') + ' (dialled directly)' });
          const go = await this.ui.choose(`Call ${label}`, `Rumfa couldn't connect the call (${e instanceof Error ? e.message : 'provider error'}). Call them from your own phone instead:`, [
            { label: `Dial ${phone}`, hint: 'Opens your phone or calling app with the number', value: 'dial' as const },
            { label: 'Copy the number', hint: phone, value: 'copy' as const },
          ]);
          if (go === 'dial') { this.dialled = true; window.location.href = `tel:${phone}`; }
          if (go === 'copy') { this.dialled = true; await navigator.clipboard?.writeText(phone).catch(() => undefined); this.ui.toast('Number copied'); }
        }
      } else {
        // Authority contacts: register the call, then dial from the operator's phone
        const { phone } = await this.api.post<{ callId: string; phone: string }>('/calls/prepare', { target, id, caseId, reason });
        this.dialled = true;
        window.location.href = `tel:${phone}`;
      }
    });
  }

  hangup() {
    const a = this.active();
    if (a?.via === 'app') { void this.endApp(a.callId, a.phase === 'incoming' ? 'declined' : 'hangup'); return; }
    this.client?.hangup?.(); this.active.set(null);
  }

  toggleMute() {
    const a = this.active();
    if (a?.via !== 'app') return;
    this.voice?.setMuted(!a.muted);
    this.active.set({ ...a, muted: !a.muted });
  }

  // ---- App calls -------------------------------------------------------------------------------------
  async callApp(volunteerId: string, label: string, caseId?: string, reason?: string) {
    try { await VoiceRoom.checkMic(); } catch (e) { this.ui.error(e); return; }
    try {
      const r = await this.api.post<{ callId: string; url: string; token: string; ringSeconds: number }>('/calls/app', { volunteerId, caseId, reason });
      this.active.set({ callId: r.callId, label, via: 'app', phase: 'calling' });
      this.ringTimer = setTimeout(() => void this.endApp(r.callId, 'timeout'), (r.ringSeconds ?? 45) * 1000);
      await this.joinVoice(r.url, r.token, r.callId);
    } catch (e) {
      const a = this.active();
      if (a?.via === 'app') await this.endApp(a.callId, 'hangup');
      this.ui.error(e);
    }
  }

  /** Someone is app-calling me (live update, or found when the dashboard opens). */
  async incoming(callId: string) {
    const cur = this.active();
    if (cur?.callId === callId) return;
    const c = await this.api.get<{ status: string; me: string; caller: { full_name: string } }>(`/calls/app/${callId}`).catch(() => null);
    if (!c || c.status !== 'ringing' || c.me !== 'callee') return;
    if (cur) { void this.api.post(`/calls/app/${callId}/end`, { reason: 'declined' }).catch(() => undefined); return; } // already on a call
    this.active.set({ callId, label: c.caller.full_name, via: 'app', phase: 'incoming' });
    this.ringer = ring();
  }

  async answer() {
    const a = this.active();
    if (a?.via !== 'app' || a.phase !== 'incoming') return;
    // Keeps ringing if the microphone is blocked, so they can allow it and answer
    try { await VoiceRoom.checkMic(); } catch (e) { this.ui.error(e); return; }
    this.stopRinging();
    try {
      const r = await this.api.post<{ url: string; token: string }>(`/calls/app/${a.callId}/answer`);
      await this.joinVoice(r.url, r.token, a.callId);
      this.active.set({ ...a, phase: 'connected' });
    } catch (e) { this.reset(); this.ui.error(e); }
  }

  /** Live updates about app calls I am in. */
  onCallChange(c: { id?: string; op: string; status?: string }) {
    if (!c.id) return;
    const a = this.active();
    if (c.status === 'ringing' && c.op === 'insert') { void this.incoming(c.id); return; }
    if (a?.callId !== c.id) return;
    if (c.status === 'answered' && a.phase === 'calling') { clearTimeout(this.ringTimer); this.active.set({ ...a, phase: 'connected' }); }
    else if (c.status && ENDED[c.status]) { this.reset(); this.ui.toast(ENDED[c.status]); }
  }

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
    if (reason === 'timeout') this.ui.toast('No answer');
    else if (r?.status === 'completed') this.ui.toast('Call ended');
  }

  private stopRinging() { this.ringer?.stop(); this.ringer = null; }

  private reset() {
    clearTimeout(this.ringTimer); this.stopRinging();
    void this.voice?.leave(); this.voice = null;
    this.active.set(null);
  }
}

/** A soft two-tone ring in the browser until stopped. */
function ring(): { stop: () => void } {
  let ctx: AudioContext | null = null;
  try { ctx = new AudioContext(); } catch { return { stop: () => undefined }; }
  const beep = () => {
    for (const [f, at] of [[880, 0], [660, 0.25]] as const) {
      const o = ctx!.createOscillator(), g = ctx!.createGain();
      o.frequency.value = f; g.gain.value = 0.08;
      o.connect(g).connect(ctx!.destination);
      o.start(ctx!.currentTime + at); o.stop(ctx!.currentTime + at + 0.2);
    }
  };
  beep();
  const t = setInterval(beep, 2000);
  return { stop: () => { clearInterval(t); void ctx?.close(); } };
}
