import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, ApiError } from './api';

/**
 * Live count during ballot sorting. Each tap adds one to a party (or invalid) on the phone at once;
 * the running totals go to the API a moment later, in the background, as one small message with a
 * sequence number, so a lost, repeated or late message can never count twice. The count is kept on
 * the phone (per person and unit), so closing the app or losing signal loses nothing.
 */
export interface CountState {
  pu: string;
  counts: Record<string, number>;
  invalid: number;
  /** Increases on every change; the server keeps only the newest */
  seq: number;
  /** Newest seq the server has confirmed */
  sentSeq: number;
  done: boolean;
  /** Recent taps, newest last, for undo */
  history: string[];
  startedAt: number;
}

export const INVALID = 'INVALID';
const SEND_DELAY_MS = 1200;
const RETRY_MS = 4000;

@Injectable({ providedIn: 'root' })
export class LiveCount {
  private api = inject(Api);
  readonly state = signal<CountState | null>(null);
  /** sent: server has the latest; sending; waiting: saved on the phone, no signal yet */
  readonly link = signal<'sent' | 'sending' | 'waiting'>('sent');
  readonly lastSentAt = signal<number | null>(null);
  /** The server refused the count (not a connection problem); shown to the agent */
  readonly error = signal<string | null>(null);
  readonly total = computed(() => { const s = this.state(); return s ? Object.values(s.counts).reduce((a, b) => a + b, 0) + s.invalid : 0; });
  private timer: any = null;
  private sending = false;

  private key(): string | null {
    const me = this.api.me();
    return me ? `rumfa.livecount.${me.id}.${me.area_code}` : null;
  }

  /** Load this person's count for their unit: from the phone, else from the server (e.g. after reinstalling). */
  async open() {
    const me = this.api.me();
    const k = this.key();
    if (!me || !k) return;
    let s: CountState | null = null;
    try { s = JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { s = null; }
    if (!s) {
      const srv = await this.api.get<any>('/live-counts/mine').catch(() => null);
      s = srv
        ? { pu: me.area_code, counts: srv.counts ?? {}, invalid: srv.invalid ?? 0, seq: srv.seq, sentSeq: srv.seq, done: srv.status === 'done', history: [], startedAt: Date.parse(srv.started_at) || Date.now() }
        : { pu: me.area_code, counts: {}, invalid: 0, seq: 0, sentSeq: 0, done: false, history: [], startedAt: Date.now() };
    }
    this.state.set(s);
    this.save();
    if (s.seq > s.sentSeq) this.schedule(0);
  }

  tap(party: string) { this.change((s) => { this.bump(s, party, +1); s.history = [...s.history.slice(-199), party]; }); }

  undo(): string | null {
    const last = this.state()?.history.at(-1) ?? null;
    if (last) this.change((s) => { this.bump(s, last, -1); s.history = s.history.slice(0, -1); });
    return last;
  }

  /** Correct a number by hand (missed calls, or joining after sorting started). */
  setCount(party: string, n: number) {
    const v = Math.max(0, Math.min(5000, Math.floor(n || 0)));
    this.change((s) => { if (party === INVALID) s.invalid = v; else if (v) s.counts[party] = v; else delete s.counts[party]; });
  }

  finish() { this.change((s) => { s.done = true; }, 0); }
  reopen() { this.change((s) => { s.done = false; }, 0); }

  private bump(s: CountState, party: string, by: number) {
    if (party === INVALID) s.invalid = Math.max(0, s.invalid + by);
    else { const n = Math.max(0, (s.counts[party] ?? 0) + by); if (n) s.counts[party] = n; else delete s.counts[party]; }
  }

  private change(fn: (s: CountState) => void, delay = SEND_DELAY_MS) {
    const cur = this.state();
    if (!cur) return;
    const s: CountState = { ...cur, counts: { ...cur.counts }, history: [...cur.history] };
    fn(s);
    s.seq++;
    this.state.set(s);
    this.save();
    this.schedule(delay);
  }

  private save() {
    const k = this.key(), s = this.state();
    if (!k || !s) return;
    try { localStorage.setItem(k, JSON.stringify(s)); } catch { /* storage full or blocked: still sent */ }
  }

  private schedule(delay: number) {
    if (this.timer && delay > 0) return; // a send is already due soon; it will carry this change
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }

  /** Send the newest totals; on failure keep them and try again shortly. */
  private async flush() {
    const s = this.state();
    if (!s || s.seq <= s.sentSeq) { this.link.set('sent'); return; }
    if (this.sending) { this.schedule(SEND_DELAY_MS); return; }
    this.sending = true;
    this.link.set('sending');
    const seq = s.seq;
    try {
      const r = await this.api.post<{ seq: number }>('/live-counts', { pu: s.pu, seq, counts: s.counts, invalid: s.invalid, done: s.done });
      const now = this.state();
      if (now) { this.state.set({ ...now, sentSeq: Math.max(now.sentSeq, seq, r.seq ?? 0) }); this.save(); }
      this.lastSentAt.set(Date.now());
      this.link.set(this.state()!.seq > this.state()!.sentSeq ? 'sending' : 'sent');
      this.error.set(null);
    } catch (e) {
      this.link.set('waiting');
      // A refused count (e.g. not this person's unit) will not fix itself: show it and stop; connection problems retry
      if (e instanceof ApiError && !e.network && e.status !== 401) { this.error.set(e.message); return; }
    } finally { this.sending = false; }
    if ((this.state()?.seq ?? 0) > (this.state()?.sentSeq ?? 0)) this.schedule(this.link() === 'waiting' ? RETRY_MS : SEND_DELAY_MS);
  }
}
