import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';

export interface Figures { registered: number | null; accredited: number | null; rejected: number | null; total_valid: number | null; votes: Record<string, number>; status?: string }
export interface IrevCheck {
  id: string; election_id: string; pu_code: string; status: 'asked' | 'matches' | 'differs'; note: string | null; case_id: string | null;
  asked_at: string; answered_at: string | null; election_name: string; pu_name: string; mine: Figures | null; irev: Figures | null;
}

/**
 * My unit's sheet on IReV against the one I signed. Rumfa asks (push) when INEC uploads or replaces it; the app
 * also asks Rumfa to look at IReV for my unit every 5 minutes once my result is sent, until the sheet is there.
 */
@Injectable({ providedIn: 'root' })
export class IrevChecks {
  private api = inject(Api);
  readonly list = signal<IrevCheck[]>([]);
  readonly pending = computed(() => this.list().filter((c) => c.status === 'asked'));
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAsk = 0;
  /** When the app last asked Rumfa to look at IReV for my unit */
  readonly lastLook = signal<number | null>(null);

  async load() {
    if (this.api.me()?.role !== 'agent') return;
    const l = await this.api.get<IrevCheck[]>('/irev-checks/mine').catch(() => null);
    if (l) this.list.set(l);
  }

  /** Once the result is sent: look at IReV for my unit now and then (only while no sheet has been found) */
  watch(resultSent: () => boolean) {
    if (this.timer) return;
    const tick = async () => {
      await this.load();
      if (!resultSent() || this.list().length || Date.now() - this.lastAsk < 5 * 60_000) return;
      this.lastAsk = Date.now(); this.lastLook.set(this.lastAsk);
      await this.api.post('/irev/check-mine').catch(() => undefined);
    };
    void tick();
    // A push notification says when INEC uploads the sheet; this is the fallback and the 5-minute IReV ask (Rumfa looks at most every 10 minutes per ward)
    this.timer = setInterval(() => void tick(), 5 * 60_000);
  }

  async checkNow(): Promise<string> {
    this.lastAsk = Date.now(); this.lastLook.set(this.lastAsk);
    const r = await this.api.post<{ queued: boolean; reason?: string }>('/irev/check-mine');
    return r.queued ? 'Rumfa is looking at IReV for your unit. You will get a notification when the sheet is there.' : (r.reason ?? 'Checked a moment ago');
  }

  async answer(id: string, matches: boolean, note?: string): Promise<{ caseId: string | null }> {
    const r = await this.api.post<{ caseId: string | null }>(`/irev-checks/${id}`, { matches, note });
    await this.load();
    return r;
  }

  async sheetUrl(c: IrevCheck): Promise<string> {
    return (await this.api.post<{ url: string }>('/media/view-url', { kind: 'irev', electionId: c.election_id, pu: c.pu_code })).url;
  }
}
