import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';
import { AgoPipe, Ui, label } from '../core/ui';

interface AreaRow { area_code: string; name: string; units: number; not_checked: number; not_on_irev: number; on_irev: number;
  downloaded: number; replaced: number; failed: number; ocr_read: number; ocr_review: number; ocr_confirmed: number; linked?: number }
interface Status { watcher: { status: string; interval_min: number; area_code: string; next_run_at: string | null; started_at: string | null } | null;
  last_checked_at: string | null; pulling: { id: string; status: string; area_code: string; counts: Record<string, number>; created_at: string } | null }
interface Latest { pu_code: string; pu_name: string; ward_name: string | null; status: string; ocr_status: string; at: string | null; from_link: boolean }

/**
 * IReV data: how far INEC's result viewing portal has got for the areas you cover, area by area, and the newest
 * sheets. Rumfa keeps INEC's link to each sheet (no copy is downloaded here) and reads the figures; unsure reads go to
 * Sheet review. Rumfa staff run the full IReV tools (and the watcher that keeps checking) from Rumfa Console.
 */
@Component({
  selector: 'app-irev',
  imports: [DecimalPipe, RouterLink, MatButtonModule, MatIconModule, MatTooltipModule, AgoPipe],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="eyebrow">Pulled from INEC's result viewing portal</p>
        <h1>IReV data</h1>
        <p class="lede">{{ watchLine() }} Rumfa keeps INEC's link to each sheet and reads the figures. Unsure reads go to <a routerLink="/irev/review">Sheet review</a>.</p>
      </div>
      <div class="head-r">
        <div class="r-seg" role="tablist" aria-label="Election">
          <button role="tab" [class.on]="mode() === 'live'" (click)="setMode('live')">This election</button>
          <button role="tab" [class.on]="mode() === 'baseline'" (click)="setMode('baseline')">Last election</button>
        </div>
        @if (canPull()) {
          @if (parent().length >= 5) {
            <button mat-stroked-button (click)="pull()" [disabled]="!!status()?.pulling" [matTooltip]="'Check IReV now for ' + here() + ' and save links to any new sheets'">
              <mat-icon>refresh</mat-icon> {{ status()?.pulling ? 'Checking…' : 'Pull now' }}</button>
          } @else { <span class="muted sm hint">Open an LGA or a ward to check it now</span> }
        }
      </div>
    </header>

    @if (status()?.pulling; as p) {
      <div class="note r-card"><mat-icon>sync</mat-icon><span>Checking IReV for {{ names()[p.area_code] ?? p.area_code }}{{ countsText(p.counts) ? ': ' + countsText(p.counts) : '…' }}</span></div>
    }

    <nav class="crumbs" aria-label="Area">
      @for (c of crumbs(); track c.code; let last = $last) {
        @if (!last) { <button class="crumb" (click)="go(c.code)">{{ c.name }}</button><span aria-hidden="true">›</span> } @else { <b>{{ c.name }}</b> }
      }
    </nav>

    <section class="stats" aria-label="Summary">
      <div class="stat r-card"><span class="s-l">Sheets published</span><b>{{ tot().published | number }}</b>
        <span class="s-h">{{ pct(tot().published, tot().units) }}% of {{ tot().units | number }} units{{ status()?.last_checked_at ? ' · checked ' + (status()!.last_checked_at! | ago) : '' }}</span></div>
      <div class="stat r-card"><span class="s-l">Read automatically</span><b>{{ tot().read | number }}</b><span class="s-h">{{ pct(tot().read, tot().published) }}% of published</span></div>
      <div class="stat r-card" [class.warn]="tot().review"><span class="s-l">Need a person</span><b>{{ tot().review | number }}</b>
        <span class="s-h">@if (tot().review) { <a routerLink="/irev/review">blurred or partial · review</a> } @else { nothing waiting }</span></div>
      <div class="stat r-card"><span class="s-l">Not yet on IReV</span><b>{{ tot().missing | number }}</b><span class="s-h">{{ tot().replaced ? tot().replaced + ' replaced by INEC' : 'checked and not there yet' }}</span></div>
    </section>

    <section class="r-card tbl" aria-label="By area">
      <div class="t-head"><h2>By {{ levelName() }}</h2>
        <span class="grow"></span>
        <button mat-button (click)="exportCsv()"><mat-icon>download</mat-icon> Unit list (CSV)</button></div>
      <div class="scroll">
        <table>
          <thead><tr><th>{{ levelName() }}</th><th>On IReV</th><th class="num">Read</th><th class="num">Need a person</th><th class="num">Replaced</th><th class="num">Not yet</th><th></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.area_code) {
              <tr class="click" (click)="isUnitLevel() ? openUnit(r) : go(r.area_code)" [class.sel]="unit()?.pu_code === r.area_code">
                <td><b>{{ r.name ?? r.area_code }}</b> <span class="muted xs">{{ r.area_code }}</span></td>
                <td><div class="prog"><span class="mbar"><span [style.width.%]="pct(published(r), r.units)"></span></span>{{ published(r) | number }} / {{ r.units | number }}</div></td>
                <td class="num">{{ r.ocr_read + r.ocr_confirmed | number }}</td>
                <td class="num">@if (r.ocr_review) { <span class="pill hot">{{ r.ocr_review }}</span> } @else { — }</td>
                <td class="num" [class.bad]="r.replaced">{{ r.replaced || '—' }}</td>
                <td class="num muted">{{ r.not_on_irev + r.not_checked | number }}</td>
                <td class="go"><mat-icon>chevron_right</mat-icon></td>
              </tr>
            } @empty { <tr><td colspan="7"><p class="muted pad">{{ loading() ? 'Loading…' : 'Nothing here.' }}</p></td></tr> }
          </tbody>
        </table>
      </div>
    </section>

    @if (unit(); as u) {
      <section class="r-card unit" aria-label="Polling unit">
        <div class="t-head"><h2>{{ names()[u.pu_code] ?? u.pu_code }} <span class="muted xs">{{ u.pu_code }}</span></h2>
          <button mat-icon-button (click)="unit.set(null)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="u-body">
          <p>{{ label(u.status) }} · figures {{ label(u.ocr_status) }} @if (u.first_seen_at) { · first seen {{ u.first_seen_at | ago }} }
            @if (u.replaced_count) { · <span class="bad">replaced {{ u.replaced_count }}×</span> }</p>
          @if (u.storage_path || u.sheet_url) { <button mat-flat-button (click)="openSheet(u.pu_code)"><mat-icon>open_in_new</mat-icon> Open sheet{{ u.storage_path ? '' : ' from INEC' }}</button> }
          @if (u.last_error) { <p class="bad">Last error: {{ u.last_error }}</p> }
          <h3>Check history</h3>
          @for (l of unitLog(); track l.id) { <div class="xs">{{ l.at | ago }} · {{ label(l.status) }}</div> } @empty { <div class="muted xs">Not checked yet.</div> }
        </div>
      </section>
    }

    <section class="r-card latest" aria-label="Latest sheets">
      <div class="t-head"><h2>Latest sheets</h2><span class="muted sm">Click a sheet to open it</span></div>
      <div class="tiles">
        @for (s of latest(); track s.pu_code) {
          <button class="tile r-focus" (click)="openSheet(s.pu_code)">
            <span class="sheet" aria-hidden="true"><mat-icon>description</mat-icon>@if (s.from_link) { <span class="lnk">INEC link</span> }</span>
            <span class="t-foot"><span class="t-name"><b>{{ s.pu_name }}</b><span class="muted xs">{{ s.ward_name }}</span></span>
              <span class="pill" [class]="'pill ' + ocrCls(s)">{{ ocrText(s) }}</span></span>
          </button>
        } @empty { <p class="muted pad">No sheets on IReV here yet.</p> }
      </div>
    </section>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .head-r { display: flex; align-items: center; gap: 10px; } .hint { max-width: 180px; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); max-width: 760px; }
    h2 { margin: 0; font-size: 16px; font-weight: 700; } h3 { margin: 12px 0 4px; font-size: 13px; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; } .bad { color: var(--r-urgent); font-weight: 700; } .grow { flex: 1; }
    .note { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #f3f7fb; font-size: 13.5px; }
    .note mat-icon { color: var(--r-medium); }
    .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 14px; margin-top: -6px; }
    .crumb { border: 0; background: none; color: #0f5e8c; font: inherit; font-weight: 600; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .stat { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; }
    .stat b { font-size: 26px; font-weight: 800; }
    .s-l { font-size: 13px; font-weight: 600; color: var(--r-ink-2); } .s-h { font-size: 12px; color: var(--r-muted); }
    .stat.warn { border-color: #f0c9a8; background: #fffaf5; } .stat.warn b { color: var(--r-high); }
    .tbl, .latest, .unit { overflow: hidden; }
    .t-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 640px; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: var(--r-muted); padding: 10px 14px; background: #fafbfc; border-top: 1px solid var(--r-line-soft); border-bottom: 1px solid var(--r-line); }
    td { padding: 10px 14px; border-bottom: 1px solid var(--r-line-soft); }
    th:first-child, td:first-child { padding-left: 18px; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    tr.click { cursor: pointer; } tr.click:hover td, tr.sel td { background: #fafbfc; }
    .prog { display: flex; align-items: center; gap: 8px; }
    .mbar { width: 120px; height: 7px; border-radius: 999px; background: var(--r-line-soft); overflow: hidden; }
    .mbar span { display: block; height: 100%; background: var(--r-accent); }
    .go { width: 24px; color: var(--r-muted); }
    .pill { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
    .pill.hot { background: var(--r-high-bg); color: #7a2e0b; } .pill.ok { background: #e3f4ea; color: #146c3a; } .pill.none { background: var(--r-low-bg); color: var(--r-ink-2); }
    .pad { margin: 0; padding: 16px 18px; }
    .u-body { padding: 0 18px 16px; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; padding: 0 18px 18px; }
    .tile { display: flex; flex-direction: column; gap: 8px; border: 0; background: none; padding: 0; font: inherit; color: var(--r-ink); cursor: pointer; text-align: left; }
    .sheet { position: relative; height: 130px; border-radius: 8px; background: linear-gradient(180deg, #faf6ea, #f1ead6); border: 1px solid #e3dac2; display: grid; place-items: center; color: #9a8a5e; }
    .sheet mat-icon { font-size: 40px; width: 40px; height: 40px; }
    .tile:hover .sheet { border-color: var(--r-accent); }
    .lnk { position: absolute; left: 6px; top: 6px; font-size: 10.5px; font-weight: 700; background: #fff; border-radius: 999px; padding: 1px 7px; color: var(--r-ink-2); }
    .t-foot { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
    .t-name { display: flex; flex-direction: column; min-width: 0; } .t-name b { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  `,
})
export class IrevPage implements OnDestroy {
  api = inject(Api);
  private ui = inject(Ui);
  label = label;
  mode = signal<'baseline' | 'live'>('live');
  parent = signal('NG');
  rows = signal<AreaRow[]>([]);
  latest = signal<Latest[]>([]);
  status = signal<Status | null>(null);
  loading = signal(true);
  names = signal<Record<string, string>>({ NG: 'All your areas' });
  unit = signal<any | null>(null);
  unitLog = signal<any[]>([]);
  election = computed(() => this.mode() === 'live' ? this.api.liveElectionId() : this.api.baselineElectionId());
  isUnitLevel = computed(() => this.parent().length === 8);
  levelName = computed(() => ({ 2: 'state', 5: 'LGA', 8: 'ward' } as Record<number, string>)[this.parent() === 'NG' ? 2 : this.parent().length + 3] ?? 'polling unit');
  canPull = computed(() => ['analyst', 'supervisor', 'admin'].includes(this.api.me()?.role ?? ''));
  here = computed(() => this.names()[this.parent()] ?? this.parent());
  crumbs = computed(() => {
    const p = this.parent();
    const codes = p === 'NG' ? ['NG'] : ['NG', p.slice(0, 2), p.slice(0, 5), p.slice(0, 8)].filter((c, i, a) => c.length <= p.length && a.indexOf(c) === i);
    return codes.map((c) => ({ code: c, name: this.names()[c] ?? c }));
  });
  tot = computed(() => this.rows().reduce((t, r) => ({ units: t.units + r.units, published: t.published + this.published(r), read: t.read + r.ocr_read + r.ocr_confirmed,
    review: t.review + r.ocr_review, missing: t.missing + r.not_on_irev + r.not_checked, replaced: t.replaced + r.replaced }),
    { units: 0, published: 0, read: 0, review: 0, missing: 0, replaced: 0 }));
  watchLine = computed(() => {
    const w = this.status()?.watcher;
    if (!w) return 'Rumfa checks IReV on election day as results come in.';
    return w.status === 'paused' ? 'Rumfa\'s IReV check is paused for now.' : `On election day, Rumfa checks IReV every ${Math.max(10, w.interval_min)} minutes after each pass.`;
  });
  private stopLive: () => void;
  private timer = setInterval(() => void this.loadStatus(), 30_000);

  constructor() {
    void this.load();
    let pending: ReturnType<typeof setTimeout> | null = null;
    this.stopLive = this.api.onChange(() => { pending ??= setTimeout(() => { pending = null; void this.load(); }, 3000); }, ['irev_fetch_jobs']);
  }
  ngOnDestroy() { this.stopLive(); clearInterval(this.timer); }

  setMode(m: 'baseline' | 'live') { this.mode.set(m); this.unit.set(null); void this.load(); }
  published(r: AreaRow) { return r.on_irev + r.downloaded + r.replaced; }
  pct(a: number, b: number) { return b ? Math.round(a / b * 100) : 0; }
  go(code: string) { this.parent.set(code); this.unit.set(null); void this.load(); }
  countsText(c: Record<string, number>) { return Object.entries(c ?? {}).filter(([, v]) => v).map(([k, v]) => `${label(k)} ${v}`).join(' · '); }
  ocrText(s: Latest) { return ({ read: 'Read', confirmed: 'Confirmed', needs_review: 'Check' } as Record<string, string>)[s.ocr_status] ?? 'Not read'; }
  ocrCls(s: Latest) { return s.ocr_status === 'needs_review' ? 'hot' : ['read', 'confirmed'].includes(s.ocr_status) ? 'ok' : 'none'; }

  async load() {
    const e = this.election();
    if (!e) { this.loading.set(false); this.ui.toast(`No ${this.mode() === 'live' ? 'current' : 'past'} election is set up for your organisation.`); return; }
    this.loading.set(true);
    const area = this.parent();
    const [rows, latest] = await Promise.all([
      this.api.get<AreaRow[]>('/irev/summary', { election: e, parent: area }).catch((x) => { this.ui.error(x); return null; }),
      this.api.get<Latest[]>('/irev/latest', { election: e, area }).catch(() => [] as Latest[]),
      this.loadStatus(),
    ]);
    this.loading.set(false);
    if (area !== this.parent() || !rows) return;
    this.rows.set(rows); this.latest.set(latest);
    this.names.set({ ...this.names(), ...Object.fromEntries(rows.map((r) => [r.area_code, r.name ?? r.area_code])) });
  }
  async loadStatus() {
    const e = this.election(); if (!e) return;
    const s = await this.api.get<Status>('/irev/status', { election: e }).catch(() => null);
    if (s) this.status.set(s);
  }

  /** Check IReV now for the area shown, saving links only */
  async pull() {
    const area = this.parent();
    const level = area === 'NG' ? 'national' : ({ 2: 'state', 5: 'lga', 8: 'ward' } as Record<number, string>)[area.length];
    const ok = await this.ui.run(() => this.api.post('/irev/jobs', { electionId: this.election(), jobType: this.mode(), areaLevel: level, areaCode: area, keep: 'link' }),
      `Checking IReV for ${this.here()}, once. New sheets appear here as they're found.`);
    if (ok) await this.loadStatus();
  }

  async openUnit(r: AreaRow) {
    const d = await this.ui.run(() => this.api.get<{ availability: any; log: any[] }>(`/irev/units/${r.area_code}`, { election: this.election() }));
    if (!d) return;
    this.unit.set(d.availability ?? { pu_code: r.area_code, status: 'not_checked', ocr_status: 'not_read' });
    this.unitLog.set(d.log);
  }
  async openSheet(pu: string) {
    const url = await this.ui.run(() => this.api.viewUrl({ kind: 'irev', electionId: this.election(), pu }));
    if (url) window.open(url, '_blank', 'noopener');
  }
  async exportCsv() {
    const area = this.parent();
    const data = await this.ui.run(() => this.api.get<any[]>('/irev/units', { election: this.election(), area: area === 'NG' ? undefined : area }));
    if (!data) return;
    const head = 'pu_code,status,ocr_status,first_seen_at,irev_updated_at,replaced_count,last_checked_at';
    const csv = [head, ...data.map((r: any) => head.split(',').map((k) => r[k] ?? '').join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `irev-${area}-${this.mode()}.csv`; a.click();
  }
}
