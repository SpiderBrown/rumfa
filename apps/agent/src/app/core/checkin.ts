import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { CheckinFence } from '@rumfa/shared';
import { Api } from './api';
import { Outbox } from './outbox';

export interface CheckinWindow { opensAt: string; closesAt: string; electionDate: string; anyDay: boolean; open: boolean }
interface State {
  first: string | null; last: string | null; count: number; window: CheckinWindow | null;
  /** First check-in not known to be outside the agent's area */
  arrival?: string | null;
  /** How the latest check-in was judged: inside the area, outside it, or not known (no location / no outline) */
  lastInside?: boolean | null;
  /** The area to check against (ward, unit, LGA or state), kept so the phone can warn with no signal */
  fence?: CheckinFence | null;
}

/**
 * The signed-in person's check-in for the live election. The first check-in is their arrival time;
 * the server decides when check-in is open (election day from the organisation's opening time).
 * Cached on the phone per person, so it shows offline and never leaks between people on one phone.
 */
@Injectable({ providedIn: 'root' })
export class Checkin {
  private api = inject(Api);
  private outbox = inject(Outbox);
  readonly state = signal<State>({ first: null, last: null, count: 0, window: null });
  readonly checkedIn = computed(() => !!this.state().first);
  /** Checked in, but only from outside their area so far: they should check in again when they get there */
  readonly onlyOutside = computed(() => !!this.state().first && this.state().lastInside === false && !this.state().arrival);
  private key = () => { const me = this.api.me(); return me ? `rumfa.checkin.${me.tenant_id}.${me.id}` : null; };

  constructor() {
    // Show the cached state for whoever is signed in, then refresh from the server
    effect(() => {
      const k = this.key();
      if (!k) return;
      try { this.state.set(JSON.parse(localStorage.getItem(k) ?? 'null') ?? { first: null, last: null, count: 0, window: null }); } catch { /* ignore */ }
      void this.load();
    });
  }

  async load() {
    try {
      const s = await this.api.get<State>('/checkins/mine');
      // The server is the record, except for a check-in still waiting in this phone's outbox (newer than the server's)
      const cur = this.state();
      const pending = this.outbox.items().some((i) => i.kind === 'checkin' && i.status === 'waiting');
      this.save(pending
        ? { ...s, first: s.first ?? cur.first, last: cur.last, count: Math.max(s.count, cur.count), arrival: s.arrival ?? cur.arrival ?? null,
            lastInside: cur.lastInside, fence: s.fence ?? cur.fence ?? null }
        : s);
    } catch { /* offline: keep the cache */ }
  }

  /** Is check-in open right now? 'unknown' when the phone has never heard from the server. */
  openNow(): 'open' | 'early' | 'closed' | 'unknown' {
    const w = this.state().window;
    if (!w) return 'unknown';
    if (w.anyDay) return 'open';
    const now = Date.now();
    return now < Date.parse(w.opensAt) ? 'early' : now >= Date.parse(w.closesAt) ? 'closed' : 'open';
  }

  /** Field work (checklist, report, live count, result) waits for a check-in while check-in is open or opens later
   *  today; not once it has closed, nor before the phone has ever heard from the server (offline first). */
  required(): boolean {
    const o = this.openNow();
    return !this.checkedIn() && (o === 'open' || o === 'early');
  }

  /** Record a check-in locally straight away (the outbox sends it). */
  recorded(at: Date, inside: boolean | null) {
    const s = this.state(), iso = at.toISOString();
    this.save({ ...s, first: s.first ?? iso, last: iso, count: s.count + 1, lastInside: inside,
      arrival: s.arrival ?? (inside === false ? null : iso) });
  }

  private save(s: State) {
    this.state.set(s);
    const k = this.key();
    if (k) localStorage.setItem(k, JSON.stringify(s));
  }
}
