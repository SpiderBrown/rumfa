import { Component, ElementRef, OnDestroy, computed, inject, signal, viewChild } from '@angular/core';
import { PercentPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { IonContent, IonIcon, IonRefresher, IonRefresherContent } from '@ionic/angular';
import { ISSUE_BANDS, REPORTING_BANDS, issueBand, issueScore, partyColour, reportingBand, type MapLayer } from '@rumfa/shared';
import { Api } from '../core/api';
import { AppBar } from '../core/app-bar';
import { AreaMap, type MapArea, type MapData } from '../core/area-map';
import { Calls } from '../core/calls';
import { I18n } from '../core/i18n';
import { Tasks } from '../core/tasks';
import { Ui } from '../core/ui';

type Need = 'callback' | 'notin' | 'silent' | 'trouble' | 'turnout';
interface TeamPerson { id: string; full_name: string; phone: string; role: string; level: string; area_code: string; place: string; needs: Need[]; checked_in_at: string | null }
interface Team {
  area: string; name: string; childLevel: string; counts: Record<string, number>; people: TeamPerson[];
  children: { code: string; name: string; coordinator: { id: string; full_name: string } | null; agents: number; inPlace: number; todo: number }[];
}
const NEED: Record<Need, { text: string; tone: string }> = {
  callback: { text: 'Asked for a call', tone: 'blue' }, notin: { text: 'Not checked in', tone: 'orange' }, silent: { text: 'Silent', tone: 'grey' },
  trouble: { text: 'Phone or app trouble', tone: 'red' }, turnout: { text: 'No turnout update', tone: 'orange' },
};

/**
 * A coordinator's area: how it is going (people in place, issues, results, turnout), the map (dashed circles where
 * there is no outline, units placed where their agents checked in), charts for votes, progress and issues, who needs
 * a call, the coordinators below me, and the sub-areas to open. Tap a sub-area to go down a level.
 */
@Component({
  selector: 'page-coord-map',
  imports: [AppBar, PercentPipe, RouterLink, IonContent, IonIcon, IonRefresher, IonRefresherContent],
  template: `
  <app-bar [title]="t('My area')" [sos]="false" />
  <ion-content>
    <ion-refresher slot="fixed" (ionRefresh)="refresh($event)"><ion-refresher-content /></ion-refresher>
    <div class="pad">
      <div class="crumbs">
        @for (b of data()?.breadcrumb ?? []; track b.code; let last = $last) {
          @if (last) { <b>{{ b.name }}</b> } @else { <a (click)="open(b.code)">{{ b.name }}</a><ion-icon name="chevron-forward" /> }
        }
      </div>

      <!-- How the area is going -->
      <div class="kpis">
        <div><b>{{ totals().inPlace }}<small>/{{ totals().agents }}</small></b><span>{{ t('in place') }}</span></div>
        <div [class.bad]="totals().open"><b>{{ totals().open }}</b><span>{{ t('open issues') }}</span></div>
        <div><b>{{ totals().reported }}<small>/{{ totals().units }}</small></b><span>{{ t('results') }}</span></div>
        <div><b>{{ totals().turnout === null ? '—' : (totals().turnout! | percent) }}</b><span>{{ t('turnout') }}</span></div>
      </div>

      @if (tasks.open().length) {
        <button class="card tasks" routerLink="/tabs/tasks">
          <span class="ico orange"><ion-icon name="checkmark-done" /></span>
          <span class="grow"><b>{{ tasks.open().length }} {{ t(tasks.open().length === 1 ? 'task for you' : 'tasks for you') }}</b>
            <small>{{ tasks.open()[0].title }}</small></span>
          <ion-icon name="chevron-forward" />
        </button>
      }

      <div class="seg">
        @for (l of layers; track l.id) { <button [class.on]="layer() === l.id" (click)="setLayer(l.id)">{{ t(l.label) }}</button> }
      </div>
    </div>

    <div class="mapwrap">
      <div #map class="map"></div>
      <div class="legend">
        @switch (layer()) {
          @case ('issues') { @for (b of issueBands; track b.label) { <span><i [style.background]="b.colour"></i>{{ t(b.label) }}</span> } }
          @case ('votes') { @for (p of partiesShown(); track p) { <span><i [style.background]="colour(p)"></i>{{ p }}</span> } }
          @case ('reporting') { @for (b of reportingBands; track b.label) { <span><i [style.background]="b.colour"></i>{{ b.label }}</span> } }
        }
        @if (hasApprox()) { <span><i class="dash"></i>{{ t('Rough place') }}</span> }
      </div>
    </div>

    <div class="pad">
      <!-- The chart for the layer on show -->
      @switch (layer()) {
        @case ('votes') {
          <p class="section-title">{{ t('Votes in') }} {{ placeName() }}</p>
          <div class="card">
            @for (v of voteBars(); track v.party) {
              <div class="bar"><span class="bl"><i [style.background]="colour(v.party)"></i>{{ v.party }}</span>
                <span class="bt"><span [style.width.%]="v.width" [style.background]="colour(v.party)"></span></span>
                <b>{{ v.votes.toLocaleString() }}</b><small>{{ v.share | percent }}</small></div>
            } @empty { <p class="hint">{{ t('No results yet.') }}</p> }
            @if (voteBars().length) { <p class="hint">{{ totals().reported }} {{ t('of') }} {{ totals().units }} {{ t('units reported') }}</p> }
          </div>
        }
        @case ('reporting') {
          <p class="section-title">{{ t('Progress through the day') }}</p>
          <div class="card">
            @for (s of progress(); track s.label) {
              <div class="bar"><span class="bl wide">{{ t(s.label) }}</span>
                <span class="bt"><span [style.width.%]="s.pct * 100" class="pg"></span></span>
                <b>{{ s.n }}</b><small>{{ s.pct | percent }}</small></div>
            }
          </div>
        }
        @default {
          <p class="section-title">{{ t('Open issues by severity') }}</p>
          <div class="card">
            <div class="stack">
              @for (s of severity(); track s.key) { @if (s.n) { <span [style.flex]="s.n" [style.background]="s.colour" [title]="s.label"></span> } }
              @if (!totals().open) { <span class="none">{{ t('No open issues') }}</span> }
            </div>
            <div class="sev">@for (s of severity(); track s.key) { <span><i [style.background]="s.colour"></i>{{ t(s.label) }} <b>{{ s.n }}</b></span> }</div>
          </div>
        }
      }

      <!-- People who need a call now (my agents, or anyone below me) -->
      @if (team(); as tm) {
        @if (tm.people.length) {
          <p class="section-title">{{ t('Needs a call') }} <span class="count">{{ tm.people.length }}</span></p>
          <div class="card flat">
            @for (p of tm.people.slice(0, showAll() ? 200 : 6); track p.id) {
              <div class="row-item">
                <button class="av sm" (click)="person(p.id)">{{ initials(p.full_name) }}</button>
                <button class="grow plain" (click)="person(p.id)"><b>{{ p.full_name }}</b>
                  <small>{{ p.place }}</small>
                  <span class="needs">@for (n of p.needs; track n) { <i [class]="need(n).tone">{{ t(need(n).text) }}</i> }</span></button>
                <button class="round green" (click)="call(p)" [attr.aria-label]="t('Call')"><ion-icon name="call" /></button>
                <button class="round" (click)="done(p)" [attr.aria-label]="t('Followed up')"><ion-icon name="checkmark" /></button>
              </div>
            }
            @if (tm.people.length > 6 && !showAll()) { <button class="more" (click)="showAll.set(true)">{{ t('Show all') }} ({{ tm.people.length }})</button> }
          </div>
        }

        <!-- Coordinators below me: reach them, or open their area -->
        @if (coords().length) {
          <p class="section-title">{{ t('Coordinators') }}</p>
          <div class="card flat">
            @for (c of coords(); track c.code) {
              <div class="row-item">
                <span class="av sm co">{{ initials(c.coordinator!.full_name) }}</span>
                <button class="grow plain" (click)="open(c.code)"><b>{{ c.coordinator!.full_name }}</b>
                  <small>{{ c.name }} · {{ c.inPlace }}/{{ c.agents }} {{ t('in place') }}@if (c.todo) { · <span class="warn">{{ c.todo }} {{ t('to follow up') }}</span> }</small></button>
                <button class="round" (click)="message(c.coordinator!.id)" [attr.aria-label]="t('Message')"><ion-icon name="chatbubble" /></button>
                <button class="round green" (click)="callCoord(c.coordinator!)" [attr.aria-label]="t('Call')"><ion-icon name="call" /></button>
              </div>
            }
          </div>
        }
      }

      <!-- Sub-areas: tap to go down a level -->
      @if (data(); as d) {
        <p class="section-title">{{ d.children.length }} {{ t(childName()) }}</p>
        <div class="card flat">
          @for (a of sorted(); track a.code) {
            <button class="row-item area" (click)="tap(a)">
              <span class="dot" [style.background]="dot(a)" [class.approx]="a.approx"></span>
              <span class="grow"><b>{{ a.name }}</b>
                <small>
                  @if (a.open) { <span class="warn">{{ a.open }} {{ t('open') }}@if (a.critical) { ({{ a.critical }} {{ t('critical') }}) }</span> · }
                  @if (a.leader) { {{ a.leader.party }} {{ a.leader.share | percent }} · }
                  {{ a.checked_in ?? 0 }}/{{ a.agents }} {{ t('in place') }} · {{ a.reported }}/{{ d.childLevel === 'pu' ? 1 : a.units }} {{ t('reported') }}
                </small>
                @if (a.coordinator && d.childLevel !== 'pu') { <small>{{ t('Coordinator') }}: {{ a.coordinator.full_name }}</small> }
              </span>
              @if (d.childLevel !== 'pu') { <ion-icon name="chevron-forward" /> }
            </button>
          }
        </div>
      }

      <button class="card manage" routerLink="/coord/team"><span class="ico teal"><ion-icon name="people" /></span>
        <span class="grow"><b>{{ t('Manage my team') }}</b><small>{{ t('Add people, activation codes') }}</small></span><ion-icon name="chevron-forward" /></button>
    </div>
  </ion-content>`,
  styles: `
    .pad { padding: 0 12px; }
    .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 10px 2px; font-size: 14px; }
    .crumbs a { color: var(--r-accent); font-weight: 600; } .crumbs ion-icon { font-size: 12px; color: var(--r-muted); }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 10px; }
    .kpis div { background: #fff; border: 1px solid var(--r-line); border-radius: 16px; padding: 10px 4px; text-align: center; }
    .kpis b { display: block; font-size: 20px; } .kpis b small { font-size: 12px; color: var(--r-muted); font-weight: 600; }
    .kpis span { font-size: 11px; color: var(--r-muted); font-weight: 600; } .kpis .bad b { color: var(--r-urgent); }
    .tasks, .manage { width: 100%; display: flex; align-items: center; gap: 12px; text-align: left; font: inherit; color: var(--r-ink); }
    .tasks { border-color: #f6cfae; background: #fff8f1; }
    .grow { flex: 1; min-width: 0; } .grow b { display: block; } .grow small { display: block; color: var(--r-muted); font-size: 13px; }
    .plain { border: 0; background: none; padding: 0; text-align: left; font: inherit; color: var(--r-ink); }
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; background: #e5e7eb; border-radius: 14px; padding: 4px; margin-bottom: 10px; }
    .seg button { border: 0; border-radius: 11px; padding: 9px; background: none; font: inherit; font-weight: 700; color: var(--r-muted); }
    .seg button.on { background: #fff; color: var(--r-ink); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .mapwrap { position: relative; } .map { height: 40vh; background: #eef1f4; }
    .legend { position: absolute; left: 8px; bottom: 8px; z-index: 500; background: #fff; padding: 6px 8px; border-radius: 10px; font-size: 11px;
      box-shadow: 0 1px 4px rgba(0,0,0,.25); display: flex; flex-direction: column; gap: 2px; max-height: 45%; overflow: auto; }
    .legend span { display: flex; align-items: center; gap: 5px; } .legend i { width: 12px; height: 12px; border-radius: 3px; border: 1px solid rgba(0,0,0,.2); }
    .legend i.dash { border: 1.5px dashed #374151; border-radius: 50%; background: none; }
    .bar { display: grid; grid-template-columns: 64px 1fr auto 40px; align-items: center; gap: 8px; padding: 5px 0; font-size: 14px; }
    .bl { display: flex; align-items: center; gap: 5px; font-weight: 700; } .bl i { width: 10px; height: 10px; border-radius: 50%; } .bl.wide { font-weight: 600; }
    .bar:has(.bl.wide) { grid-template-columns: 110px 1fr auto 40px; }
    .bt { height: 10px; border-radius: 5px; background: #eef1f4; overflow: hidden; } .bt span { display: block; height: 100%; border-radius: 5px; }
    .bt .pg { background: var(--r-accent); } .bar small { color: var(--r-muted); text-align: right; }
    .stack { display: flex; height: 16px; border-radius: 8px; overflow: hidden; background: #eef1f4; } .stack .none { flex: 1; font-size: 11px; color: var(--r-muted); text-align: center; line-height: 16px; }
    .sev { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; font-size: 13px; } .sev span { display: flex; align-items: center; gap: 4px; }
    .sev i { width: 10px; height: 10px; border-radius: 3px; }
    .count { background: var(--r-urgent); color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 12px; letter-spacing: 0; margin-left: 4px; }
    .av.sm { width: 40px; height: 40px; border: 0; font: inherit; font-weight: 800; font-size: 14px; } .av.co { background: var(--r-accent); }
    .needs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
    .needs i { font-style: normal; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: #eef1f4; color: var(--r-ink-2); }
    .needs i.orange { background: #fde7d6; color: var(--r-high); } .needs i.red { background: #fdecea; color: var(--r-urgent); } .needs i.blue { background: #e3ecf7; color: var(--r-blue); }
    .round { width: 38px; height: 38px; border-radius: 50%; border: 0; background: var(--r-accent-soft); color: var(--r-accent); display: grid; place-items: center; font-size: 18px; flex: none; }
    .round.green { background: #16a34a; color: #fff; }
    .more { width: 100%; border: 0; background: none; padding: 12px; font: inherit; font-weight: 700; color: var(--r-accent); }
    .area { width: 100%; background: #fff; border-left: 0; border-right: 0; border-top: 0; font: inherit; text-align: left; color: var(--r-ink); }
    .dot { width: 16px; height: 16px; border-radius: 5px; border: 1px solid rgba(0,0,0,.2); flex: none; } .dot.approx { border: 1.5px dashed #374151; border-radius: 50%; }
    .warn { color: var(--r-high); font-weight: 700; } .hint { color: var(--r-muted); font-size: 13px; margin: 6px 0 0; }
    .manage { margin: 14px 0 24px; }
  `,
})
export default class CoordMapPage implements OnDestroy {
  private api = inject(Api);
  private ui = inject(Ui);
  private calls = inject(Calls);
  private router = inject(Router);
  tasks = inject(Tasks);
  private i18n = inject(I18n);
  t = this.i18n.t;
  private el = viewChild.required<ElementRef<HTMLElement>>('map');
  private areaMap: AreaMap | null = null;
  private stopLive: () => void = () => undefined;
  private reloadTimer: any;
  private parent: string | null = null;

  readonly layers: { id: MapLayer; label: string }[] = [{ id: 'issues', label: 'Issues' }, { id: 'votes', label: 'Votes' }, { id: 'reporting', label: 'Progress' }];
  readonly issueBands = ISSUE_BANDS;
  readonly reportingBands = REPORTING_BANDS.map((colour, i) => ({ colour, label: ['0%', '<25%', '25–50%', '50–90%', '90%+'][i] }));
  data = signal<MapData | null>(null);
  team = signal<Team | null>(null);
  layer = signal<MapLayer>('issues');
  showAll = signal(false);
  childName = computed(() => ({ state: 'States', lga: 'LGAs', ward: 'Wards', pu: 'Polling units', zone: 'Zones', senatorial: 'Senatorial districts' } as Record<string, string>)[this.data()?.childLevel ?? 'ward']);
  placeName = computed(() => this.data()?.breadcrumb.at(-1)?.name ?? '');
  hasApprox = computed(() => !!this.data()?.approxArea || (this.data()?.children ?? []).some((c) => c.approx));
  totals = computed(() => {
    const d = this.data();
    const t = { units: 0, reported: 0, open: d?.areaWide.open ?? 0, critical: d?.areaWide.critical ?? 0, agents: 0, inPlace: 0, verified: 0,
      turnoutUnits: 0, accredited: 0, turnoutReg: 0, turnout: null as number | null };
    for (const c of d?.children ?? []) {
      t.units += d!.childLevel === 'pu' ? 1 : c.units; t.reported += c.reported; t.open += c.open; t.critical += c.critical;
      t.agents += c.agents; t.inPlace += c.checked_in ?? 0; t.verified += c.verified; t.turnoutUnits += c.turnout_units ?? 0;
      t.accredited += c.accredited ?? 0; t.turnoutReg += c.turnout_registered ?? 0;
    }
    t.turnout = t.turnoutReg ? t.accredited / t.turnoutReg : null;
    return t;
  });
  voteBars = computed(() => {
    const sum: Record<string, number> = {};
    for (const c of this.data()?.children ?? []) for (const [p, v] of Object.entries(c.votes ?? {})) sum[p] = (sum[p] ?? 0) + Number(v);
    const total = Object.values(sum).reduce((a, b) => a + b, 0);
    const rows = Object.entries(sum).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const top = rows[0]?.[1] ?? 1;
    return rows.map(([party, votes]) => ({ party, votes, share: total ? votes / total : 0, width: (votes / top) * 100 }));
  });
  progress = computed(() => {
    const t = this.totals(), u = Math.max(1, t.units);
    return [
      { label: 'Agents placed', n: t.agents, pct: Math.min(1, t.agents / u) },
      { label: 'Checked in', n: t.inPlace, pct: Math.min(1, t.inPlace / u) },
      { label: 'Turnout sent', n: t.turnoutUnits, pct: Math.min(1, t.turnoutUnits / u) },
      { label: 'Results sent', n: t.reported, pct: Math.min(1, t.reported / u) },
      { label: 'Verified', n: t.verified, pct: Math.min(1, t.verified / u) },
    ];
  });
  severity = computed(() => {
    const s = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const c of this.data()?.children ?? []) { s.critical += c.critical; s.high += c.high; s.medium += c.medium; s.low += c.low; }
    return [{ key: 'critical', label: 'Critical', n: s.critical, colour: '#b3261e' }, { key: 'high', label: 'High', n: s.high, colour: '#ea580c' },
      { key: 'medium', label: 'Medium', n: s.medium, colour: '#f59e0b' }, { key: 'low', label: 'Low', n: s.low, colour: '#94a3b8' }];
  });
  coords = computed(() => (this.team()?.children ?? []).filter((c) => c.coordinator));
  partiesShown = computed(() => {
    const leading = new Set((this.data()?.children ?? []).map((c) => c.leader?.party).filter(Boolean) as string[]);
    return leading.size ? [...leading] : (this.data()?.parties ?? []).slice(0, 5);
  });
  sorted = computed(() => {
    const kids = [...(this.data()?.children ?? [])];
    return this.layer() === 'issues' ? kids.sort((a, b) => issueScore(b) - issueScore(a)) : kids;
  });

  constructor() { this.tasks.start(); }

  /** Ionic shows the page after an animation; the map needs its final size first. */
  ionViewDidEnter() {
    if (!this.areaMap) {
      this.areaMap = new AreaMap(this.el().nativeElement, window.RUMFA_CONFIG.mapTiles);
      void this.load();
      this.stopLive = this.api.onChange(() => { clearTimeout(this.reloadTimer); this.reloadTimer = setTimeout(() => void this.load(), 3000); },
        ['cases', 'verifications', 'checkins', 'unit_figure_updates', 'callback_requests']);
    } else this.areaMap.resize();
  }
  ngOnDestroy() { this.stopLive(); clearTimeout(this.reloadTimer); this.areaMap?.destroy(); }

  async load() {
    try {
      const d = await this.api.get<MapData>('/map', { parent: this.parent ?? undefined });
      this.data.set(d);
      this.parent = d.parent;
      this.draw();
      const tm = await this.api.get<Team>('/team', { area: d.parent }).catch(() => null);
      this.team.set(tm);
    } catch (e) { await this.ui.error(e); }
  }
  async refresh(ev: CustomEvent) { await this.load(); (ev.target as any).complete(); }

  open(code: string) { this.parent = code; this.showAll.set(false); void this.load(); }
  tap(a: MapArea) { if (this.data()?.childLevel !== 'pu') this.open(a.code); else { const p = this.team()?.people.find((x) => x.area_code === a.code); if (p) this.person(p.id); } }
  setLayer(l: MapLayer) { this.layer.set(l); this.draw(); }
  colour(p: string) { const d = this.data(); return partyColour(p, d?.parties ?? [], d?.partyColours ?? {}); }
  dot(a: MapArea) {
    const d = this.data();
    const l = this.layer();
    if (l === 'issues') return ISSUE_BANDS[issueBand(a)].colour;
    if (l === 'votes') return a.leader ? this.colour(a.leader.party) : '#c9ced6';
    return REPORTING_BANDS[reportingBand(a.reported, d?.childLevel === 'pu' ? 1 : a.units)];
  }
  need(n: Need) { return NEED[n] ?? { text: n, tone: 'grey' }; }
  initials(n: string) { return n.replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase(); }
  person(id: string) { void this.router.navigate(['/person', id]); }

  async message(id: string) {
    try { const r = await this.api.post<{ channelId: string }>('/channels/direct', { otherId: id }); await this.router.navigate(['/chat', r.channelId]); }
    catch (e) { await this.ui.error(e); }
  }
  async call(p: TeamPerson) {
    try {
      const r = await this.api.post<{ channelId: string }>('/channels/direct', { otherId: p.id });
      await this.calls.fromChat(r.channelId, [{ id: p.id, full_name: p.full_name, role: p.role }]);
    } catch { window.location.href = `tel:${p.phone}`; }
  }
  async callCoord(c: { id: string; full_name: string }) {
    try {
      const r = await this.api.post<{ channelId: string }>('/channels/direct', { otherId: c.id });
      await this.calls.fromChat(r.channelId, [{ id: c.id, full_name: c.full_name, role: 'coordinator' }]);
    } catch (e) { await this.ui.error(e); }
  }
  /** Followed up: hides them from "Needs a call" for a while (each need separately) */
  async done(p: TeamPerson) {
    const note = await this.ui.prompt('Followed up', `${p.full_name}: what happened? (optional)`, { ok: 'Done' });
    if (note === null) return;
    try {
      for (const n of p.needs) await this.api.post('/team/follow-ups', { volunteerId: p.id, need: n, note: note || undefined });
      await this.load();
    } catch (e) { await this.ui.error(e); }
  }
  private draw() { const d = this.data(); if (d && this.areaMap) this.areaMap.render(d, this.layer(), (a) => this.tap(a)); }
}
