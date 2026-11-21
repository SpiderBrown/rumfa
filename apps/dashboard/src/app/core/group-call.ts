import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';
import { Ui } from './ui';
import { VoiceRoom } from './voice-room';

export interface GroupPerson { id: string; full_name: string; role: string; area_code: string; app: string | null; phone: string | null }
export interface GroupState { id: string; title: string; status: 'active' | 'ended'; canPhone: boolean; people: GroupPerson[] }

/**
 * One group call at a time from this dashboard (My field team): everyone chosen is rung in the app into one
 * room; I'm in it at once. Whoever doesn't pick up can be phoned in, only after I confirm (minutes cost money).
 */
@Injectable({ providedIn: 'root' })
export class GroupCall {
  private api = inject(Api);
  private ui = inject(Ui);
  private voice: VoiceRoom | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private askedPhone = false;
  readonly state = signal<GroupState | null>(null);
  readonly muted = signal(false);
  readonly startedAt = signal(0);

  readonly joined = computed(() => (this.state()?.people ?? []).filter((p) => p.app === 'answered' || p.phone === 'answered'));
  readonly ringing = computed(() => (this.state()?.people ?? []).filter((p) => p.app === 'ringing' || p.phone === 'ringing'));
  /** Didn't pick up in the app and not on the phone either */
  readonly missed = computed(() => (this.state()?.people ?? []).filter((p) => p.app !== 'answered' && p.app !== 'ringing' && !['answered', 'ringing'].includes(p.phone ?? '')));

  async start(area: string, roles: string[], title: string): Promise<boolean> {
    if (this.state()) { this.ui.error('You are already on a group call'); return false; }
    try { await VoiceRoom.checkMic(); } catch (e) { this.ui.error(e); return false; }
    const r = await this.ui.run(() => this.api.post<{ groupId: string; url: string; token: string; ringSeconds: number; canPhone: boolean }>(
      '/calls/group', { area, roles, title }));
    if (!r) return false;
    this.askedPhone = false;
    this.startedAt.set(Date.now());
    this.state.set({ id: r.groupId, title, status: 'active', canPhone: r.canPhone, people: [] });
    try {
      this.voice = new VoiceRoom();
      await this.voice.join(r.url, r.token, () => { if (this.state()?.id === r.groupId) void this.end(); });
    } catch (e) { this.ui.error(e); await this.end(); return false; }
    await this.refresh();
    this.poll = setInterval(() => void this.refresh(), 3000);
    // After the ring time, offer to phone whoever didn't answer in the app
    setTimeout(() => void this.offerPhone(), ((r.ringSeconds ?? 45) + 2) * 1000);
    return true;
  }

  async refresh() {
    const s = this.state(); if (!s) return;
    const g = await this.api.get<GroupState>(`/calls/group/${s.id}`).catch(() => null);
    if (g && this.state()?.id === g.id) this.state.set(g);
  }

  /** Asks once whether to phone the people who didn't answer in the app */
  async offerPhone() {
    const s = this.state();
    if (!s || this.askedPhone || !this.missed().length) return;
    this.askedPhone = true;
    await this.phoneMissed();
  }
  async phoneMissed() {
    const s = this.state(), missed = this.missed();
    if (!s || !missed.length) return;
    if (!s.canPhone) {
      this.ui.toast(`${missed.length} didn't answer in the app. Phoning them in isn't set up yet (Africa's Talking voice and LiveKit SIP).`);
      return;
    }
    const names = missed.slice(0, 4).map((p) => p.full_name).join(', ') + (missed.length > 4 ? ` and ${missed.length - 4} more` : '');
    const ok = await this.ui.confirm(`Phone ${missed.length} ${missed.length === 1 ? 'person' : 'people'} into the call?`,
      `${names} didn't answer in the app. Rumfa will ring their phones and join them to this call when they pick up. Each call uses paid minutes.`, 'Phone them');
    if (!ok) return;
    const r = await this.ui.run(() => this.api.post<{ placed: number }>(`/calls/group/${s.id}/phone`, { people: missed.map((p) => p.id) }));
    if (r) this.ui.toast(`Ringing ${r.placed} ${r.placed === 1 ? 'phone' : 'phones'}`);
    await this.refresh();
  }

  toggleMute() { this.muted.update((m) => !m); this.voice?.setMuted(this.muted()); }

  async end() {
    const s = this.state();
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    const v = this.voice; this.voice = null;
    this.state.set(null); this.muted.set(false);
    await v?.leave();
    if (s) await this.api.post(`/calls/group/${s.id}/end`).catch(() => undefined);
  }
}
