import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../../core/api';
import { AgoPipe, Ui, minutesText as fmtMin, placeLine, reportsLine, type CasePlace } from '../../core/ui';
import { AreaMap, type MapArea, type MapData } from '../../core/area-map';
import { CaseDetailPage } from './case-detail';

export interface CaseRow {
  id: string; title: string; what?: string | null; where?: CasePlace | null; category: string; severity: string; status: string; pu_code: string | null; area_code: string;
  report_count: number; reporter_count: number; alert_count?: number; assigned_to: string | null; queue_id: string; created_at: string;
  ack_due_at: string | null; due_at: string | null; escalation_level: number; incident_group_id: string | null;
}
interface QueueCount { queue_id: string; name: string; kind: string; waiting: number; assigned: number; overdue: number; critical: number }

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_LABEL: Record<string, string> = { critical: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
/** Each kind of queue has its colour, used on its card, its group and its cases */
const KIND: Record<string, { colour: string; hint: string; order: number }> = {
  security: { colour: '#a1251b', hint: 'Violence, thugs, snatching', order: 0 },
  legal: { colour: '#5b3fa8', hint: 'Results, agent denied, vote buying', order: 1 },
  state: { colour: '#1f4e8c', hint: 'Materials, BVAS, voters turned away', order: 2 },
  helpdesk: { colour: '#0f766e', hint: 'App, phone, forms', order: 3 },
  national: { colour: '#3d4652', hint: 'Escalated from the states', order: 4 },
};
const OTHER = { colour: '#5b6675', hint: '', order: 9 };
const CLOSED = ['resolved', 'closed', 'merged'];

/**
 * The situation room: queues by kind of case across the top, the cases grouped by queue on the left (or on a
 * map), and the case being worked on the right, without leaving the page. /room/case/:id opens a case here.
 */
@Component({
  selector: 'app-queue',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule, AgoPipe, CaseDetailPage],
  template: `
  <div class="room">
    <header class="head">
      <div>
        <h1>Situation room</h1>
        <p class="sub">{{ subtitle() }}</p>
      </div>
      <div class="head-r">
        <span class="stat"><b>{{ totals().waiting }}</b> waiting</span>
        @if (totals().critical) { <span class="stat urgent"><b>{{ totals().critical }}</b> urgent</span> }
        @if (totals().overdue) { <span class="stat over"><b>{{ totals().overdue }}</b> over time</span> }
        <button mat-flat-button (click)="takeNext(null)" [disabled]="!totals().waiting">
          <mat-icon>bolt</mat-icon> Take next case</button>
      </div>
    </header>

    <!-- Queues, by kind of case: load at a glance, a filter, and the next case in one click -->
    <section class="queues" aria-label="Queues">
      @for (q of busyQueues(); track q.queue_id) {
        <div class="q" [class.sel]="queueFilter() === q.queue_id" [style.--k]="q.colour">
          <button class="q-main r-focus" (click)="toggleQueue(q.queue_id)" [matTooltip]="q.hint" [attr.aria-pressed]="queueFilter() === q.queue_id"
            [attr.aria-label]="q.name + ': ' + q.waiting + ' waiting' + (q.critical ? ', ' + q.critical + ' urgent' : '')">
            <span class="q-name"><span class="dot" aria-hidden="true"></span>{{ q.name }}</span>
            <span class="q-nums"><b>{{ q.waiting }}</b> waiting
              @if (q.critical) { <span class="urgent">{{ q.critical }} urgent</span> }
              @if (q.overdue) { <span class="over">{{ q.overdue }} over time</span> }</span>
            <span class="q-hint">{{ q.assigned }} being worked</span>
          </button>
          <div class="q-foot"><button mat-button (click)="takeNext(q.queue_id)" [disabled]="!q.waiting">Take next</button></div>
        </div>
      }
      @if (!queues().length) { <p class="muted noq">No queues to show yet. A supervisor sets them up under Shifts and queues.</p> }
    </section>
    @if (quietQueues().length) {
      <div class="quiet" aria-label="Quiet queues">
        <span class="muted">Quiet now:</span>
        @for (q of quietQueues(); track q.queue_id) {
          <button class="chip r-focus" [class.sel]="queueFilter() === q.queue_id" [style.--k]="q.colour" (click)="toggleQueue(q.queue_id)"
            [attr.aria-pressed]="queueFilter() === q.queue_id" [matTooltip]="q.hint + ' · nothing waiting'"><span class="dot" aria-hidden="true"></span>{{ q.name }}</button>
        }
      </div>
    }

    <div class="body">
      <!-- Left: the cases -->
      <section class="list" aria-label="Cases">
        <div class="tools">
          <div class="r-seg" role="tablist" aria-label="Which cases">
            @for (t of tabs; track t.id) {
              <button role="tab" [class.on]="view() === t.id" [attr.aria-selected]="view() === t.id" (click)="setView(t.id)">{{ t.label }}</button>
            }
          </div>
          <div class="r-seg" role="tablist" aria-label="Show as">
            <button role="tab" [class.on]="!mapMode()" [attr.aria-selected]="!mapMode()" (click)="setMap(false)"><mat-icon class="i">view_list</mat-icon>List</button>
            <button role="tab" [class.on]="mapMode()" [attr.aria-selected]="mapMode()" (click)="setMap(true)"><mat-icon class="i">map</mat-icon>Map</button>
          </div>
        </div>

        <div class="map-wrap" [hidden]="!mapMode()">
          @if (mapData(); as d) {
            <div class="crumbs">
              @for (b of d.breadcrumb; track b.code; let last = $last) {
                @if (!last) { <button class="crumb" (click)="openArea(b.code)">{{ b.name }}</button><span aria-hidden="true">›</span> }
                @else { <b>{{ b.name }}</b> }
              }
            </div>
          }
          <div #map class="map" role="img" aria-label="Map of open cases by area"></div>
        </div>
        @if (area(); as a) {
          <div class="filter-note">Showing <b>{{ a.name }}</b> only <button mat-button (click)="clearArea()">Show all</button></div>
        }

        @for (g of groups(); track g.key) {
          <div class="group">
            <h2 class="g-head"><span class="dot" [style.background]="g.colour" aria-hidden="true"></span>{{ g.name }}<span class="g-count">· {{ g.cases.length }}</span></h2>
            @for (c of g.cases; track c.id) {
              <button class="case r-focus" [class.cur]="c.id === id()" [style.--k]="g.colour" (click)="select(c.id)" [attr.aria-current]="c.id === id() ? 'true' : null">
                <span class="c-top">
                  <span class="r-pill" [class]="c.severity">{{ sevLabel[c.severity] }}</span>
                  <span class="muted sm">{{ c.created_at | ago }}</span>
                  <span class="due" [class]="dueClass(c)">{{ dueText(c) }}</span>
                </span>
                <span class="c-title">{{ c.what ?? c.title }}
                  @if (c.incident_group_id) { <mat-icon class="link" matTooltip="Linked with other cases as one incident">link</mat-icon> }</span>
                <span class="muted sm">{{ place(c) }} · {{ reports(c) }}</span>
                <span class="c-owner sm">{{ owner(c) }}</span>
              </button>
            }
          </div>
        } @empty {
          <div class="empty r-card"><mat-icon>task_alt</mat-icon><b>{{ emptyTitle() }}</b><span class="muted">{{ emptyText() }}</span></div>
        }
      </section>

      <!-- Right: the case being worked -->
      <section class="detail" aria-label="Case">
        @if (id(); as cid) {
          <app-case-detail [id]="cid" [embedded]="true" />
        } @else {
          <div class="pick r-card">
            <mat-icon>arrow_back</mat-icon>
            <b>Pick a case on the left</b>
            <span class="muted">or press <b>Take next case</b>: the most urgent one waiting in your queues.</span>
          </div>
        }
      </section>
    </div>
  </div>`,
  styles: `
    .room { display: flex; flex-direction: column; gap: 16px; max-width: 1600px; }
    .head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .sub { margin: 4px 0 0; color: var(--r-muted); font-size: 13px; font-weight: 600; }
    .head-r { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .stat { display: inline-flex; align-items: baseline; gap: 6px; padding: 6px 12px; border-radius: 999px; background: #fff; border: 1px solid var(--r-line); font-size: 13px; }
    .stat b { font-size: 16px; } .stat.urgent b { color: var(--r-urgent); } .stat.over b { color: var(--r-high); }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .noq { grid-column: 1 / -1; margin: 0; }
    .urgent { color: var(--r-urgent); font-weight: 700; font-size: 12px; } .over { color: var(--r-high); font-weight: 700; font-size: 12px; }

    .queues { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
    .quiet { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; margin-top: -6px; }
    .chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--r-line); background: #fff; border-radius: 999px; padding: 4px 10px;
      font: inherit; font-size: 13px; color: var(--r-ink-2); cursor: pointer; }
    .chip:hover { border-color: #9aa6b6; } .chip.sel { border: 2px solid var(--k); padding: 3px 9px; color: var(--r-ink); }
    .q { background: #fff; border: 1px solid var(--r-line); border-top: 4px solid var(--k); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
    .q.sel { border: 2px solid var(--k); box-shadow: 0 2px 10px rgba(20, 23, 31, .08); }
    .q-main { border: 0; background: none; text-align: left; padding: 10px 14px 4px; display: flex; flex-direction: column; gap: 4px; font: inherit; color: var(--r-ink); cursor: pointer; }
    .q-main:hover { background: #fafbfc; }
    .q-name { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; }
    .dot { width: 10px; height: 10px; border-radius: 3px; background: var(--k); flex: none; }
    .q-hint { font-size: 12px; color: var(--r-muted); }
    .q-nums { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--r-muted); }
    .q-nums b { font-size: 22px; font-weight: 800; color: var(--r-ink); }
    .q-foot { border-top: 1px solid var(--r-line-soft); padding: 2px 6px; display: flex; justify-content: flex-end; }

    .body { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
    .list { flex: 0 1 440px; min-width: 300px; display: flex; flex-direction: column; gap: 10px; }
    /* The case stays in view while the list scrolls */
    .detail { flex: 999 1 560px; min-width: 0; position: sticky; top: 72px; max-height: calc(100vh - 88px); overflow: auto; border-radius: var(--r-radius); }
    @media (max-width: 900px) { .detail { position: static; max-height: none; } }
    .tools { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
    .r-seg .i { font-size: 16px; width: 16px; height: 16px; vertical-align: -3px; margin-right: 4px; }
    .map-wrap { background: #fff; border: 1px solid var(--r-line); border-radius: 12px; padding: 8px; }
    .map { height: 280px; border-radius: 8px; }
    .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 13px; padding: 2px 4px 8px; }
    .crumb { border: 0; background: none; color: #0f5e8c; font: inherit; font-weight: 600; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
    .crumb:hover { background: #eaf2f8; }
    .filter-note { font-size: 13px; display: flex; align-items: center; gap: 6px; }

    .group { display: flex; flex-direction: column; gap: 8px; }
    .g-head { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--r-ink-2); }
    .g-count { font-weight: 600; text-transform: none; letter-spacing: 0; color: var(--r-muted); }
    .case { display: flex; flex-direction: column; gap: 5px; width: 100%; text-align: left; font: inherit; color: var(--r-ink); cursor: pointer;
      background: #fff; border: 1px solid var(--r-line); border-left: 4px solid var(--k); border-radius: 12px; padding: 11px 13px; }
    .case:hover { border-color: #9aa6b6; border-left-color: var(--k); }
    .case.cur { background: var(--r-accent-soft); outline: 2px solid var(--r-accent); outline-offset: -1px; }
    .c-top { display: flex; align-items: center; gap: 8px; }
    .due { margin-left: auto; font-size: 12px; font-weight: 700; color: var(--r-muted); }
    .due.soon { color: var(--r-high); } .due.late { color: var(--r-urgent); } .due.done { color: var(--r-accent-strong); }
    .c-title { font-size: 15px; font-weight: 700; line-height: 1.3; }
    .link { font-size: 16px; width: 16px; height: 16px; vertical-align: -3px; color: var(--r-muted); }
    .c-owner { color: var(--r-ink-2); }
    .empty, .pick { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 40px 24px; }
    .empty mat-icon, .pick mat-icon { font-size: 36px; width: 36px; height: 36px; color: var(--r-accent); }
    .pick { min-height: 320px; justify-content: center; }
    @media (max-width: 900px) { .list { flex: 1 1 100%; } }
  `,
})
export class QueuePage implements OnDestroy {
  /** The case open on the right, from /room/case/:id */
  id = input<string | undefined>(undefined);
  private api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  readonly sevLabel = SEV_LABEL;
  readonly tabs = [{ id: 'mine' as const, label: 'My cases' }, { id: 'open' as const, label: 'All open' }, { id: 'closed' as const, label: 'Closed' }];

  view = signal<'mine' | 'open' | 'closed'>('open');
  queueFilter = signal<string | null>(null);
  cases = signal<CaseRow[]>([]);
  queues = signal<QueueCount[]>([]);
  staff = signal<Record<string, string>>({});
  mapMode = signal(false);
  mapData = signal<MapData | null>(null);
  area = signal<{ code: string; name: string } | null>(null);
  /** Re-renders the due times */
  private tick = signal(0);
  private mapEl = viewChild<ElementRef<HTMLElement>>('map');
  private areaMap: AreaMap | null = null;
  private stopLive: () => void;
  private timer = setInterval(() => { this.tick.update((n) => n + 1); }, 15_000);
  private countsTimer = setInterval(() => void this.loadCounts(), 30_000);

  private kindOf = computed(() => Object.fromEntries(this.queues().map((q) => [q.queue_id, q])));

  queueCards = computed(() => [...this.queues()]
    .map((q) => ({ ...q, colour: (KIND[q.kind] ?? OTHER).colour, hint: (KIND[q.kind] ?? OTHER).hint, order: (KIND[q.kind] ?? OTHER).order }))
    .sort((a, b) => b.critical - a.critical || a.order - b.order || a.name.localeCompare(b.name)));

  /** Queues with something waiting or being worked get a card; the rest share one quiet row */
  busyQueues = computed(() => this.queueCards().filter((q) => q.waiting || q.assigned || q.queue_id === this.queueFilter()));
  quietQueues = computed(() => this.queueCards().filter((q) => !q.waiting && !q.assigned && q.queue_id !== this.queueFilter()));
  totals = computed(() => this.queues().reduce((t, q) => ({ waiting: t.waiting + q.waiting, critical: t.critical + q.critical, overdue: t.overdue + q.overdue }),
    { waiting: 0, critical: 0, overdue: 0 }));

  subtitle = computed(() => {
    const names = this.queueCards().map((q) => q.name);
    return names.length ? 'Your queues: ' + names.join(', ') : 'Cases from the field and from the automatic checks';
  });

  /** Cases grouped by queue; the queue holding the most urgent case first, most urgent first inside */
  groups = computed(() => {
    this.tick();
    const qf = this.queueFilter(), a = this.area()?.code, kinds = this.kindOf();
    const rows = this.cases().filter((c) => (!qf || c.queue_id === qf) && (!a || (c.pu_code ?? c.area_code).startsWith(a)));
    const by = new Map<string, CaseRow[]>();
    for (const c of rows) { const k = kinds[c.queue_id] ? c.queue_id : 'other'; by.set(k, [...(by.get(k) ?? []), c]); }
    return [...by.entries()].map(([key, list]) => {
      const q = kinds[key];
      const sorted = list.sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity] || x.created_at.localeCompare(y.created_at));
      return { key, name: q?.name ?? 'Other cases', colour: (q ? KIND[q.kind] ?? OTHER : OTHER).colour, cases: sorted,
        top: SEV_ORDER[sorted[0].severity], order: (q ? KIND[q.kind] ?? OTHER : OTHER).order };
    }).sort((x, y) => x.top - y.top || x.order - y.order);
  });

  constructor() {
    void this.load();
    void this.loadCounts();
    void this.api.get<{ id: string; full_name: string }[]>('/people/room-staff').then((s) =>
      this.staff.set(Object.fromEntries(s.map((x) => [x.id, x.full_name])))).catch(() => {});
    // Live: any case change in my area reloads the list (a burst of changes reloads once)
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.stopLive = this.api.onChange(() => {
      pending ??= setTimeout(() => { pending = null; void this.load(); void this.loadCounts(); if (this.mapMode()) void this.loadMap(); }, 400);
    }, ['cases']);
    try { this.mapMode.set(localStorage.getItem('rumfa.room.map') === '1'); } catch { /* private mode */ }
    // The map is drawn once its box is on the page
    effect(() => {
      const el = this.mapEl()?.nativeElement;
      // Leaflet measures its box when created, so wait until the box is shown and laid out
      if (el && this.mapMode() && !this.areaMap) {
        setTimeout(() => { this.areaMap ??= new AreaMap(el, window.RUMFA_CONFIG.mapTiles); void this.loadMap(); }, 0);
      } else if (this.mapMode() && this.areaMap) setTimeout(() => { this.areaMap?.resize(); void this.loadMap(); }, 0);
    });
  }

  ngOnDestroy() { clearInterval(this.timer); clearInterval(this.countsTimer); this.stopLive(); this.areaMap?.destroy(); }

  async load() {
    const v = this.view();
    const q = v === 'mine' ? { mine: true, status: 'assigned,in_progress,escalated,resolved' }
      : v === 'open' ? { status: 'queued,assigned,in_progress,escalated' }
      : { status: 'resolved,closed,merged', sinceHours: 6 };
    try { this.cases.set(await this.api.get<CaseRow[]>('/cases', q)); } catch (e) { this.ui.error(e); }
  }
  async loadCounts() { this.queues.set(await this.api.get<QueueCount[]>('/queues/counts').catch(() => this.queues())); }

  setView(v: 'mine' | 'open' | 'closed') { this.view.set(v); void this.load(); }
  toggleQueue(id: string) { this.queueFilter.set(this.queueFilter() === id ? null : id); }
  select(id: string) { void this.router.navigate(['/room/case', id]); }

  setMap(on: boolean) {
    this.mapMode.set(on);
    try { localStorage.setItem('rumfa.room.map', on ? '1' : '0'); } catch { /* private mode */ }
  }
  private mapParent: string | undefined;
  async loadMap() {
    try {
      const d = await this.api.get<MapData>('/map', { parent: this.mapParent });
      this.mapData.set(d);
      this.mapParent = d.parent;
      this.areaMap?.render(d, 'issues', (a) => this.clickArea(a), this.area()?.code);
    } catch (e) { this.ui.error(e); }
  }
  /** A click on the map shows only that area's cases, and opens its sub-areas */
  clickArea(a: MapArea) {
    this.area.set({ code: a.code, name: a.name });
    if (this.mapData()?.childLevel !== 'pu') { this.mapParent = a.code; void this.loadMap(); }
    else { const d = this.mapData(); if (d) this.areaMap?.render(d, 'issues', (x) => this.clickArea(x), a.code); }
  }
  openArea(code: string) {
    this.mapParent = code;
    const crumb = this.mapData()?.breadcrumb.find((b) => b.code === code);
    this.area.set(crumb && code !== 'NG' && crumb !== this.mapData()?.breadcrumb[0] ? { code, name: crumb.name } : null);
    void this.loadMap();
  }
  clearArea() { this.area.set(null); this.mapParent = undefined; if (this.mapMode()) void this.loadMap(); }

  place(c: CaseRow) { return (c.where && placeLine(c.where, false)) || c.pu_code || c.area_code; }
  reports(c: CaseRow) { return reportsLine(c.report_count, c.reporter_count, c.alert_count ?? 0); }
  owner(c: CaseRow) {
    if (c.status === 'merged') return 'Merged into another case';
    if (CLOSED.includes(c.status)) return c.status === 'resolved' ? 'Resolved, waiting for a supervisor to close' : 'Closed';
    if (!c.assigned_to) return c.status === 'escalated' ? 'Escalated · nobody on it yet' : 'Nobody on it yet';
    const name = c.assigned_to === this.api.me()?.id ? 'You' : this.staff()[c.assigned_to] ?? 'Someone';
    return (c.status === 'assigned' ? name + ' · not acknowledged yet' : name) + (c.escalation_level ? ' · escalated' : '');
  }
  private due(c: CaseRow) { return c.status === 'assigned' ? c.ack_due_at : c.due_at; }
  dueText(c: CaseRow) {
    this.tick();
    if (CLOSED.includes(c.status)) return c.status === 'merged' ? 'Merged' : 'Resolved';
    const d = this.due(c);
    if (!d) return '';
    const min = Math.round((new Date(d).getTime() - Date.now()) / 60_000);
    const verb = c.status === 'assigned' ? 'Acknowledge' : c.assigned_to ? 'Due' : 'Take';
    if (min < 0) return `Over by ${fmtMin(-min)}`;
    return `${verb} within ${fmtMin(min)}`;
  }
  dueClass(c: CaseRow) {
    if (CLOSED.includes(c.status)) return 'due done';
    const d = this.due(c);
    if (!d) return 'due';
    const min = (new Date(d).getTime() - Date.now()) / 60_000;
    return min < 0 ? 'due late' : min < 10 ? 'due soon' : 'due';
  }
  emptyTitle() { return this.view() === 'mine' ? 'No cases on you' : this.view() === 'closed' ? 'Nothing closed in the last 6 hours' : 'No open cases'; }
  emptyText() {
    if (this.queueFilter() || this.area()) return 'Try all queues or all areas.';
    return this.view() === 'mine' ? 'Take the next case when you are ready.' : 'New reports from the field appear here as they come in.';
  }

  async takeNext(queueId: string | null) {
    const r = await this.ui.run(() => this.api.post<{ caseId: string | null }>('/cases/next', { queueId: queueId ?? undefined }));
    if (r?.caseId) { this.select(r.caseId); void this.load(); void this.loadCounts(); }
    else if (r) this.ui.toast('Nothing waiting' + (queueId ? ' in this queue' : ' in your queues'));
  }
}

