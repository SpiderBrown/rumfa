import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { type UnitFigures, figureFlags, usedBallots } from '@rumfa/shared';
import { Api } from './api';
import { Outbox } from './outbox';

export type Stage = 'setup' | 'accreditation' | 'close' | 'result';
export interface FigureUpdate { stage: Stage; figures: UnitFigures; reported_at: string; pending?: boolean }

/**
 * The polling unit's EC8A summary figures through the day (setup, accreditation updates, close of poll, result).
 * Each save goes to the situation room through the outbox straight away; kept per person on the phone and
 * restored from the server after a reinstall. Later stages (and the result form) start from what was sent.
 */
@Injectable({ providedIn: 'root' })
export class UnitFiguresService {
  private api = inject(Api);
  private outbox = inject(Outbox);
  /** Every update this agent made today, oldest first (server ones, then any still waiting to send) */
  readonly history = signal<FigureUpdate[]>([]);
  readonly latest = computed(() => this.merge(this.history()).latest);
  /** Accreditation has closed: a final accredited figure was sent with the close-of-poll or result figures */
  readonly final = computed(() => this.merge(this.history()).final);
  readonly accreditationUpdates = computed(() => this.history().filter((u) => u.figures.accredited != null));
  private key = () => { const me = this.api.me(); return me ? `rumfa.figures.${me.tenant_id}.${me.id}` : null; };

  constructor() {
    effect(() => {
      const k = this.key();
      if (!k) return;
      try { this.history.set(JSON.parse(localStorage.getItem(k) ?? '[]')); } catch { this.history.set([]); }
      void this.load();
    });
  }

  async load() {
    try {
      const r = await this.api.get<{ history: FigureUpdate[] }>('/unit-figures/mine');
      const waiting = this.outbox.items().filter((i) => i.kind === 'figures' && i.status !== 'sent');
      const pending = waiting.map((i) => ({ stage: i.payload['stage'], figures: i.payload['figures'], reported_at: i.payload['at'], pending: true }));
      this.save([...r.history, ...pending]);
    } catch { /* offline: keep the cache */ }
  }

  /** Saves figures for a stage and sends them. Returns the warnings they show (the room is told too). */
  async send(stage: Stage, figures: UnitFigures) {
    const previousAccredited = this.latest().accredited ?? null;
    const at = new Date().toISOString();
    await this.outbox.add('figures', { pu: this.api.me()!.area_code, stage, figures, at }, LABEL[stage]);
    this.save([...this.history(), { stage, figures, reported_at: at, pending: true }]);
    return this.warnings(figures.accredited != null ? previousAccredited : null);
  }

  /** Problems in the figures so far, as the room will see them. */
  warnings(previousAccredited: number | null = null) {
    return figureFlags(this.latest(), { final: this.final(), previousAccredited });
  }

  used() { return usedBallots(this.latest()); }

  /** Still on the phone (in the outbox, not yet accepted by the server)? Follows the outbox as items go out. */
  isPending(u: FigureUpdate): boolean {
    return this.outbox.items().some((i) => i.kind === 'figures' && i.payload['at'] === u.reported_at && i.status !== 'sent');
  }

  /** Sent, or still on the phone: from the outbox, so it updates as items go out */
  pendingCount = computed(() => this.outbox.items().filter((i) => i.kind === 'figures' && i.status !== 'sent').length);

  private merge(list: FigureUpdate[]) {
    const latest: UnitFigures = {};
    let final = false;
    for (const u of [...list].sort((a, b) => Date.parse(a.reported_at) - Date.parse(b.reported_at))) {
      Object.assign(latest, u.figures);
      if ((u.stage === 'close' || u.stage === 'result') && u.figures.accredited != null) final = true;
    }
    return { latest, final };
  }

  private save(list: FigureUpdate[]) {
    this.history.set(list);
    const k = this.key();
    if (k) localStorage.setItem(k, JSON.stringify(list));
  }
}

const LABEL: Record<Stage, string> = {
  setup: 'Setup figures', accreditation: 'Accreditation update', close: 'Close of poll figures', result: 'Result figures',
};
