import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatMenuModule } from '@angular/material/menu';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

interface Place {
  code: string; name: string; zone?: string | null; irev_state_no?: number | null; lgas?: number; wards?: number; units?: number;
  with_voters?: number; voters?: number; lga_outlines?: number; outline?: boolean; on_irev?: boolean; district?: string | null;
  registered_voters?: number | null; located?: boolean; federal?: number; assembly?: number;
  status?: 'ready' | 'attention' | 'not_loaded'; issues?: string[];
}
interface Browse { parent: string; items: Place[]; breadcrumb: { code: string; name: string }[] }
interface Job {
  id: string; kind: string; params: { states?: string[]; noUnits?: boolean; mode?: 'all' | 'missing' | 'local' }; status: 'running' | 'done' | 'failed';
  progress: { state?: string | null; statesDone?: number; statesTotal?: number; lgas?: number; wards?: number; units?: number; federal?: number; assembly?: number; state_?: number;
    step?: string; done?: Record<string, number>; unmatched?: number; ready?: number; failed?: string[] };
  log: string[]; error: string | null; created_at: string; finished_at: string | null; by?: string | null;
}
const ZONES = ['NC', 'NE', 'NW', 'SE', 'SS', 'SW'];
const ZONE_NAME: Record<string, string> = { NC: 'North Central', NE: 'North East', NW: 'North West', SE: 'South East', SS: 'South South', SW: 'South West' };

/**
 * Places shared by every client: states, LGAs, wards and polling units. Browse what is loaded, correct names, load
 * a state's places from IReV in the background, and add registered voters from a CSV.
 */
@Component({
  selector: 'page-places',
  imports: [DatePipe, DecimalPipe, NgTemplateOutlet, FormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MatTooltipModule, MatMenuModule],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>Places</h1>
      <span class="spacer"></span>
      @if (api.canEdit) {
        @if (inState()) {
          <button mat-flat-button (click)="loadStates([inState()!.code])" [disabled]="running()"
            matTooltip="Everything for this state, in order: LGAs, wards and polling units from IReV, then constituencies, then map outlines and senatorial districts. A few minutes. Running it again only updates.">
            <mat-icon>download</mat-icon> Load {{ inState()!.name }}</button>
        } @else {
          <button mat-flat-button (click)="loadStates()" [disabled]="running()"
            matTooltip="Loads every state that is not ready yet, one after another (each: places from IReV, constituencies, outlines). About 3–4 minutes a state; you can leave the page.">
            <mat-icon>download</mat-icon> Load all states</button>
        }
        <mat-form-field class="mode" subscriptSizing="dynamic" [matTooltip]="modeHint[mode]">
          <mat-select [(ngModel)]="mode" aria-label="What to load">
            <mat-option value="missing">Only what's missing</mat-option>
            <mat-option value="local">Saved data only (no IReV)</mat-option>
            <mat-option value="all">Everything again</mat-option>
          </mat-select>
        </mat-form-field>
        <button mat-stroked-button (click)="panel.set(panel() === 'voters' ? null : 'voters')"
          matTooltip="Registered voters per polling unit, from a CSV file (IReV does not publish them)."><mat-icon>how_to_reg</mat-icon> Registered voters</button>
        <button mat-stroked-button (click)="openAliases()"
          matTooltip="When the outline files spell a place differently from IReV: tell Rumfa they are the same."><mat-icon>rule</mat-icon> Name matches</button>
        <button mat-icon-button [matMenuTriggerFor]="more" matTooltip="One step only (to repair something)"><mat-icon>more_vert</mat-icon></button>
        <mat-menu #more="matMenu">
          <button mat-menu-item (click)="panel.set('irev')"><mat-icon>cloud_download</mat-icon> Places from IReV only…</button>
          <button mat-menu-item (click)="loadConstituencies()" [disabled]="running()"><mat-icon>account_balance</mat-icon> {{ constituencyLabel() }} only</button>
          <button mat-menu-item (click)="refreshOutlines()" [disabled]="running()"><mat-icon>polyline</mat-icon> {{ outlinesLabel() }} only</button>
        </mat-menu>
      }
      <button mat-icon-button (click)="panel.set(panel() === 'history' ? null : 'history')" matTooltip="Import history: past loads and their logs"><mat-icon>history</mat-icon></button>
    </div>

    @if (panel() === 'irev') {
      <div class="card">
        <h2>Places from IReV only</h2>
        <p class="hint">Loads each state's LGAs, wards and polling units from IReV, in the background (about 3–4 minutes a state with polling units). Running it again updates names; nothing is duplicated.</p>
        <div class="tools"><button mat-button (click)="pick.set(allStates())">Tick all</button><button mat-button (click)="pick.set([])">Clear</button></div>
        <div class="states">
          @for (s of states(); track s.code) {
            <button type="button" class="st" [class.on]="pick().includes(s.code)" (click)="toggleState(s.code)">
              {{ s.name }} <span class="hint">{{ s.units | number }}</span>
            </button>
          }
        </div>
        <mat-checkbox [(ngModel)]="noUnits">LGAs and wards only (quick, no polling units)</mat-checkbox>
        <div class="page-head">
          <span class="spacer"></span>
          <button mat-flat-button (click)="startImport()" [disabled]="!pick().length || running()">Load {{ pick().length }} state(s)</button>
        </div>
      </div>
    }

    @if (panel() === 'aliases') {
      <div class="card">
        <h2>Name matches</h2>
        <p class="hint">When an outline file spells a place differently from Rumfa (from IReV), tell Rumfa they are the same, then press
          Load outlines for that state again (matches are used while outlines load). Spaces, case and punctuation are ignored already.</p>
        <div class="row">
          <mat-form-field><mat-label>Level</mat-label><mat-select [(ngModel)]="aliasForm.level">
            <mat-option value="lga">LGA</mat-option><mat-option value="ward">Ward</mat-option><mat-option value="state">State</mat-option></mat-select></mat-form-field>
          <mat-form-field><mat-label>Name in Rumfa</mat-label><input matInput [(ngModel)]="aliasForm.fromName" placeholder="e.g. Mopa Moro" /></mat-form-field>
          <mat-form-field><mat-label>Name in the file</mat-label><input matInput [(ngModel)]="aliasForm.toName" placeholder="e.g. Mopa-Muro" /></mat-form-field>
          <button mat-flat-button class="go" (click)="addAlias()">Add match</button>
        </div>
        <table class="grid">
          <tr><th>Level</th><th>Name in Rumfa</th><th>Name in the file</th><th></th></tr>
          @for (a of aliases().added; track a.level + a.from_key) {
            <tr><td>{{ a.level.toUpperCase() }}</td><td>{{ a.from_name }}</td><td>{{ a.to_name }}</td>
              <td>@if (api.canEdit) { <button mat-icon-button (click)="removeAlias(a)" title="Remove"><mat-icon>delete</mat-icon></button> }</td></tr>
          } @empty { <tr><td colspan="4" class="hint">None yet.</td></tr> }
        </table>
      </div>
    }

    @if (panel() === 'voters') {
      <div class="card">
        <h2>Registered voters</h2>
        <p class="hint">Upload a CSV with a <b>pu_code</b> column (e.g. 19-28-02-003 or 19/28/02/003) and a <b>registered_voters</b> column. Units not in the file keep what they have.</p>
        <label class="pick">
          <input type="file" accept=".csv,text/csv" (change)="uploadVoters($event)" hidden />
          <mat-icon>upload_file</mat-icon> Choose CSV file
        </label>
        @if (votersResult(); as r) {
          <p><b>{{ r.updated | number }}</b> polling units updated.</p>
          @if (r.unknownCount) { <p class="hint">{{ r.unknownCount }} codes are not in Rumfa (load those states first): {{ r.unknown.join(', ') }}…</p> }
          @if (r.badCount) { <p class="hint">{{ r.badCount }} lines could not be read: {{ r.bad.join('; ') }}…</p> }
        }
      </div>
    }

    @if (current().length) {
      <div class="card">
        <h2>{{ running() ? 'Loading' : 'Load finished' }}</h2>
        @for (j of current(); track j.id) { <ng-container *ngTemplateOutlet="jobRow; context: { $implicit: j, close: true }" /> }
      </div>
    }

    @if (panel() === 'history') {
      <div class="card">
        <div class="row head-row"><h2>Import history</h2><span class="spacer"></span>
          @if (api.canEdit && history().length) { <button mat-button (click)="clearHistory()"><mat-icon>delete_sweep</mat-icon> Clear history</button> }
          <button mat-icon-button (click)="panel.set(null)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        @for (j of history(); track j.id) { <ng-container *ngTemplateOutlet="jobRow; context: { $implicit: j, close: false }" /> }
        @empty { <p class="hint">No past loads.</p> }
      </div>
    }

    <ng-template #jobRow let-j let-close="close">
      <div class="job">
        <span class="chip" [class.ok]="j.status === 'done'" [class.warn]="j.status === 'running'" [class.bad]="j.status === 'failed'">{{ j.status === 'running' ? 'Running' : j.status === 'done' ? 'Done' : 'Failed' }}</span>
        <b>{{ jobName(j.kind) }} · {{ j.params.states?.length || 'all' }} state(s)</b>{{ j.params.noUnits ? ' · LGAs and wards only' : '' }}{{ j.params.mode === 'missing' ? ' · only what was missing' : j.params.mode === 'local' ? ' · saved data only' : '' }}
        <span class="hint">· {{ j.created_at | date: 'd MMM, HH:mm' }}{{ j.by ? ' · ' + j.by : '' }}</span>
        @if (close && j.status !== 'running') { <button mat-icon-button class="close" (click)="dismiss(j.id)" aria-label="Close" matTooltip="Close (it stays in Import history)"><mat-icon>close</mat-icon></button> }
        <div class="hint">
          @if (j.status === 'running') { Now: {{ j.progress.state ?? 'starting…' }} · }
          @if (j.kind !== 'outlines' && j.kind !== 'states') { {{ j.progress.statesDone ?? 0 }}/{{ j.progress.statesTotal ?? j.params.states?.length }} states · }
          @if (j.kind === 'states') {
            {{ j.progress.statesDone ?? 0 }}/{{ j.progress.statesTotal ?? j.params.states?.length }} states
            @if (j.status === 'running' && j.progress.state) { · now {{ j.progress.state }}: {{ j.progress.step }} }
            @if (j.status !== 'running') { · {{ j.progress.ready ?? 0 }} ready }
            @if (j.progress.failed?.length) { · stopped for {{ j.progress.failed.join(', ') }} }
          } @else if (j.kind === 'outlines') {
            @if (j.status === 'running') { {{ j.progress.step ?? '' }}… }
            @else { {{ j.progress.done?.['state'] ?? 0 }} states · {{ j.progress.done?.['lga'] ?? 0 }} LGAs · {{ j.progress.done?.['ward'] ?? 0 }} wards · {{ j.progress.done?.['senatorial'] ?? 0 }} districts ({{ j.progress.done?.['linked'] ?? 0 }} LGAs linked) · {{ j.progress.unmatched ?? 0 }} names not matched }
          } @else if (j.kind === 'constituencies') { {{ j.progress.federal ?? 0 }} House of Reps · {{ j.progress.assembly ?? j.progress.state_ ?? 0 }} State Assembly }
          @else { {{ (j.progress.lgas ?? 0) | number }} LGAs · {{ (j.progress.wards ?? 0) | number }} wards · {{ (j.progress.units ?? 0) | number }} units }
        </div>
        @if (j.error) { <div class="err">{{ j.error }}</div> }
        @for (l of j.log.slice(j.kind === 'states' ? -8 : -4); track $index) { <div class="hint log">{{ l }}</div> }
      </div>
    </ng-template>

    @if (editing(); as e) {
      <div class="card">
        <h2>Edit {{ e.name }}</h2>
        <div class="row">
          <mat-form-field><mat-label>Name</mat-label><input matInput [(ngModel)]="e.name" /></mat-form-field>
          @if (e.code.length === 2) {
            <mat-form-field><mat-label>Zone</mat-label><mat-select [(ngModel)]="e.zone">
              @for (z of zones; track z) { <mat-option [value]="z">{{ zoneName[z] }}</mat-option> }</mat-select></mat-form-field>
            <mat-form-field><mat-label>IReV state number</mat-label><input matInput type="number" [(ngModel)]="e.irev_state_no" />
              <mat-hint>IReV's own number for the state (not the INEC code)</mat-hint></mat-form-field>
          }
        </div>
        <div class="page-head"><span class="spacer"></span>
          <button mat-button (click)="editing.set(null)">Cancel</button>
          <button mat-flat-button (click)="saveEdit()">Save</button></div>
      </div>
    }

    @if (data(); as d) {
      <nav class="crumbs">
        @for (b of d.breadcrumb; track b.code; let last = $last) {
          @if (last) { <b>{{ b.name }}</b> } @else { <a (click)="open(b.code)">{{ b.name }}</a><mat-icon>chevron_right</mat-icon> }
        }
        <span class="spacer"></span>
        <mat-form-field class="find" subscriptSizing="dynamic"><mat-label>Filter</mat-label><input matInput [(ngModel)]="filter" /></mat-form-field>
      </nav>
      <table class="grid">
        @switch (level()) {
          @case ('NG') { <tr><th>State</th><th>Status</th><th>Zone</th><th>IReV no.</th><th>LGAs</th><th>Wards</th><th>Polling units</th><th>Registered voters</th><th>Constituencies</th><th>Outlines</th><th></th></tr> }
          @case ('state') { <tr><th>LGA</th><th>Senatorial district</th><th>Wards</th><th>Polling units</th><th>Voters loaded</th><th>Outline</th><th>On IReV</th><th></th></tr> }
          @case ('lga') { <tr><th>Ward</th><th>Code</th><th>Polling units</th><th>Voters loaded</th><th>Outline</th><th>On IReV</th><th></th></tr> }
          @case ('ward') { <tr><th>Polling unit</th><th>Code</th><th>Registered voters</th><th>Location</th><th>On IReV</th><th></th></tr> }
        }
        @for (p of shown(); track p.code) {
          <tr [class.link]="level() !== 'ward'" (click)="level() !== 'ward' && open(p.code)">
            @switch (level()) {
              @case ('NG') {
                <td><b>{{ p.name }}</b> <span class="hint">{{ p.code }}</span></td>
                <td class="status"><span class="chip" [class.ok]="p.status === 'ready'" [class.warn]="p.status === 'attention'" [class.bad]="p.status === 'not_loaded'">
                  {{ p.status === 'ready' ? 'Ready' : p.status === 'attention' ? 'Needs attention' : 'Not loaded' }}</span>
                  @for (i of p.issues ?? []; track i) { <div class="hint">{{ i }}</div> }</td>
                <td>{{ p.zone ?? '—' }}</td><td>{{ p.irev_state_no ?? '—' }}</td>
                <td [class.missing]="!p.lgas">{{ p.lgas | number }}</td><td>{{ p.wards | number }}</td><td [class.missing]="!p.units">{{ p.units | number }}</td>
                <td>{{ p.with_voters ? ((p.voters ?? 0) | number) : '—' }} @if (p.with_voters && p.with_voters < (p.units ?? 0)) { <span class="hint">({{ p.with_voters | number }} units)</span> }</td>
                <td class="hint">{{ p.federal ?? 0 }} Reps · {{ p.assembly ?? 0 }} Assembly</td>
                <td><span class="chip" [class.ok]="p.outline" [class.bad]="!p.outline">State</span>
                  <span class="chip" [class.ok]="p.lgas && p.lga_outlines === p.lgas" [class.warn]="p.lga_outlines && p.lga_outlines < (p.lgas ?? 0)">LGAs {{ p.lga_outlines }}/{{ p.lgas }}</span></td>
              }
              @case ('state') {
                <td><b>{{ p.name }}</b> <span class="hint">{{ p.code }}</span></td><td>{{ p.district ?? '—' }}</td><td>{{ p.wards }}</td><td>{{ p.units | number }}</td>
                <td>{{ p.with_voters | number }}</td><td>{{ p.outline ? 'Yes' : 'No' }}</td><td>{{ p.on_irev ? 'Yes' : 'No' }}</td>
              }
              @case ('lga') {
                <td><b>{{ p.name }}</b></td><td class="hint">{{ p.code }}</td><td>{{ p.units }}</td><td>{{ p.with_voters }}</td><td>{{ p.outline ? 'Yes' : 'No' }}</td><td>{{ p.on_irev ? 'Yes' : 'No' }}</td>
              }
              @case ('ward') {
                <td>{{ p.name }}</td><td class="hint">{{ p.code }}</td><td>{{ p.registered_voters ?? '—' }}</td><td>{{ p.located ? 'Known' : '—' }}</td><td>{{ p.on_irev ? 'Yes' : 'No' }}</td>
              }
            }
            <td (click)="$event.stopPropagation()" class="acts">@if (api.canEdit) {
              @if (level() === 'NG' && p.status !== 'ready') { <button mat-button (click)="loadStates([p.code])" [disabled]="running()" [matTooltip]="'Load ' + p.name + ': places, constituencies and outlines'">Load</button> }
              <button mat-icon-button (click)="edit(p)" title="Edit"><mat-icon>edit</mat-icon></button> }</td>
          </tr>
        } @empty { <tr><td colspan="9" class="hint">Nothing loaded here yet.</td></tr> }
      </table>
    } @else { <p class="hint">Loading…</p> }
  </div>`,
  styles: `
    .job { position: relative; } .job .close { position: absolute; top: -6px; right: -6px; } .head-row { align-items: center; }
    .mode { width: 210px; font-size: 13px; } .mode ::ng-deep .mat-mdc-form-field-infix { padding: 8px 0; min-height: 36px; }
    .tools { margin-bottom: 6px; }
    .states { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .st { padding: 4px 10px; border-radius: 16px; border: 1px solid var(--mat-sys-outline-variant); background: var(--mat-sys-surface); cursor: pointer; font: var(--mat-sys-label-large); }
    .st.on { background: var(--mat-sys-primary-container); border-color: var(--mat-sys-primary); }
    .pick { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; padding: 8px 14px; border-radius: 20px; border: 1px solid var(--mat-sys-outline); color: var(--mat-sys-primary); }
    .job { padding: 8px 0; border-bottom: 1px solid var(--mat-sys-outline-variant); } .job:last-child { border-bottom: none; }
    .log { font-family: monospace; font-size: 11px; } .err { color: var(--mat-sys-error); font-size: 13px; }
    .crumbs { display: flex; align-items: center; gap: 2px; margin: 8px 0; flex-wrap: wrap; }
    .crumbs a { cursor: pointer; color: var(--mat-sys-primary); } .crumbs mat-icon { font-size: 18px; width: 18px; height: 18px; color: var(--mat-sys-outline); }
    .find { width: 220px; } .status { min-width: 140px; } .status .hint { font-size: 11px; } .acts { white-space: nowrap; text-align: right; } .go { flex: 0 0 auto; margin-top: 8px; }
 .missing { color: var(--mat-sys-error); font-weight: 500; }
  `,
})
export class PlacesPage implements OnDestroy {
  api = inject(Api);
  private ui = inject(Ui);
  data = signal<Browse | null>(null);
  states = signal<Place[]>([]);
  jobs = signal<Job[]>([]);
  panel = signal<'irev' | 'voters' | 'aliases' | 'history' | null>(null);
  /** Loads started here, shown on the page until closed */
  private pinned = signal<Set<string>>(new Set());
  /** On the page: what is running now, and loads started here until closed. Everything else is under Import history. */
  current = computed(() => this.jobs().filter((j) => j.status === 'running' || this.pinned().has(j.id)));
  history = computed(() => this.jobs().filter((j) => j.status !== 'running'));
  aliases = signal<{ added: { level: string; from_key: string; to_key: string; from_name: string; to_name: string }[] }>({ added: [] });
  aliasForm = { level: 'lga', fromName: '', toName: '' };
  pick = signal<string[]>([]);
  editing = signal<Place | null>(null);
  votersResult = signal<{ updated: number; unknown: string[]; unknownCount: number; bad: string[]; badCount: number } | null>(null);
  noUnits = false;
  mode: 'missing' | 'local' | 'all' = 'missing';
  readonly modeHint = {
    missing: 'Quicker: only the steps a state does not have yet. Polling units, constituencies or outlines already there are not fetched again.',
    local: 'No downloads from IReV: rebuilds outlines and senatorial districts from the project files for the places already saved. Use after adding name matches.',
    all: 'Fetches everything again from IReV (places, polling units, constituencies) and reloads the outlines. Slowest.',
  };
  filter = '';
  zones = ZONES; zoneName = ZONE_NAME;
  private timer: any;

  level = computed(() => { const p = this.data()?.parent ?? 'NG'; return p === 'NG' ? 'NG' : p.length === 2 ? 'state' : p.length === 5 ? 'lga' : 'ward'; });
  running = computed(() => this.jobs().some((j) => j.status === 'running'));

  constructor() { void this.open('NG'); void this.loadJobs(); }
  ngOnDestroy() { clearTimeout(this.timer); }

  shown() {
    const f = this.filter.trim().toLowerCase();
    return (this.data()?.items ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || p.code.includes(f));
  }
  async open(code: string) {
    try {
      const d = await this.api.get<Browse>('/platform/places/browse', { parent: code });
      this.data.set(d); this.filter = '';
      if (code === 'NG') this.states.set(d.items);
    } catch (e) { this.ui.error(e); }
  }
  /** Keeps the import list fresh while one is running */
  async loadJobs() {
    clearTimeout(this.timer);
    try {
      this.jobs.set(await this.api.get<Job[]>('/platform/jobs'));
      // A job started here has finished (even one too quick to be seen running): show the new counts
      const finished = this.jobs().filter((j) => this.watching.has(j.id) && j.status !== 'running');
      if (finished.length) {
        finished.forEach((j) => this.watching.delete(j.id));
        await this.open(this.data()?.parent ?? 'NG');
      }
    } catch { /* shown again on the next refresh */ }
    if (this.running() || this.watching.size) this.timer = setTimeout(() => void this.loadJobs(), 2000);
  }
  dismiss(id: string) { this.pinned.update((p) => { const n = new Set(p); n.delete(id); return n; }); }
  async clearHistory() {
    if (!(await this.ui.confirm('Clear import history?', 'Removes the finished loads and their logs. The places they loaded stay.', 'Clear'))) return;
    const r = await this.ui.run(() => this.api.del<{ removed: number }>('/platform/jobs'), 'History cleared');
    if (r) { this.pinned.set(new Set()); await this.loadJobs(); }
  }
  /** Jobs started from this page, until they finish */
  private watching = new Set<string>();
  private async startJob(path: string, body: object, message: string) {
    const r = await this.ui.run(() => this.api.post<{ id: string }>(path, body), message);
    if (r) { this.watching.add(r.id); this.pinned.update((p) => new Set(p).add(r.id)); await this.loadJobs(); }
    return !!r;
  }

  allStates() { return this.states().map((s) => s.code); }
  toggleState(c: string) { const p = this.pick(); this.pick.set(p.includes(c) ? p.filter((x) => x !== c) : [...p, c]); }
  async startImport() {
    if (await this.startJob('/platform/jobs/geography', { states: this.pick(), noUnits: this.noUnits || undefined }, 'Import started')) {
      this.panel.set(null); this.pick.set([]);
    }
  }

  /** Inside a state: that state only. At Nigeria: every state. */
  async loadConstituencies() {
    const d = this.data();
    const state = d && d.parent !== 'NG' ? d.parent.slice(0, 2) : null;
    const name = state ? d!.breadcrumb[1]?.name ?? state : null;
    const text = state
      ? `House of Reps and State Assembly constituencies for ${name}, from IReV. Takes a few seconds; running it again only updates names.`
      : 'House of Reps and State Assembly constituencies for every state, from IReV. Takes a few minutes; running it again only updates names.';
    if (!(await this.ui.confirm(state ? `Load ${name}'s constituencies?` : 'Load constituencies for all states?', text, 'Load'))) return;
    await this.startJob('/platform/jobs/constituencies', state ? { states: [state] } : {}, 'Loading constituencies');
  }
  jobName(k: string) { return ({ states: 'Load states', constituencies: 'Constituencies', outlines: 'Map outlines', geography: 'Places from IReV' } as Record<string, string>)[k] ?? k; }
  /** The state being viewed (inside a state, an LGA or a ward) */
  inState() { const d = this.data(); return d && d.parent !== 'NG' ? { code: d.parent.slice(0, 2), name: d.breadcrumb[1]?.name ?? d.parent.slice(0, 2) } : null; }

  /** Everything for these states, in order; with none given, every state that is not ready */
  async loadStates(codes?: string[]) {
    const local = this.mode === 'local';
    const names = codes?.map((c) => this.states().find((s) => s.code === c)?.name ?? (this.inState()?.code === c ? this.inState()!.name : c));
    const todo = codes ? null : this.states().filter((s) => (local ? (s.lgas ?? 0) > 0 : s.status !== 'ready'));
    if (todo && !todo.length) { this.ui.toast(local ? 'No state has places yet: load them from IReV first' : 'Every state is ready'); return; }
    const title = names ? `Load ${names.join(', ')}?` : local ? `Rebuild outlines for ${todo!.length} states?` : `Load ${todo!.length} states that are not ready?`;
    const list = names ? '' : `${todo!.map((s) => s.name).join(', ')}.\n\n`
      + (local ? 'Quick: no downloads.\n\n' : 'One after another, about 3–4 minutes each. You can leave this page; progress shows under Imports.\n\n');
    const what = {
      missing: 'For each state, only what it does not have yet: places and polling units from IReV, constituencies, then map outlines and senatorial districts.',
      local: 'Nothing is downloaded from IReV. For the places already saved, map outlines and senatorial districts are rebuilt from the project files (name matches applied).',
      all: 'For each state, everything again: LGAs, wards and polling units from IReV, constituencies, then map outlines and senatorial districts. Nothing is duplicated.',
    }[this.mode];
    if (!(await this.ui.confirm(title, list + what, 'Load'))) return;
    await this.startJob('/platform/jobs/states', { ...(codes ? { states: codes } : {}), mode: this.mode }, 'Loading');
  }

  /** Inside a state: that state's LGA and ward outlines and senatorial districts. At Nigeria: everything, states and zones included. */
  async refreshOutlines() {
    const d = this.data();
    const state = d && d.parent !== 'NG' ? d.parent.slice(0, 2) : null;
    const name = state ? d!.breadcrumb[1]?.name ?? state : null;
    const text = state
      ? `Reloads ${name}'s LGA and ward outlines and its senatorial districts from the files kept with Rumfa. Takes under a minute.`
      : 'Reloads every outline from the files kept with Rumfa: states and zones, LGAs, wards, then senatorial districts. Takes a few minutes.';
    if (!(await this.ui.confirm(state ? `Load ${name}'s outlines?` : 'Load all outlines?', text + ' Running it again replaces them. Names that do not match are listed; fix them under Name matches.', 'Load'))) return;
    await this.startJob('/platform/jobs/outlines', state ? { state } : {}, 'Loading outlines');
  }
  outlinesLabel() { const d = this.data(); return d && d.parent !== 'NG' ? `Load ${d.breadcrumb[1]?.name ?? ''} outlines` : 'Load outlines'; }
  constituencyLabel() { const d = this.data(); return d && d.parent !== 'NG' ? `Load ${d.breadcrumb[1]?.name ?? ''} constituencies` : 'Load constituencies'; }

  openAliases() {
    if (this.panel() === 'aliases') { this.panel.set(null); return; }
    this.panel.set('aliases'); void this.loadAliases();
  }
  async loadAliases() { try { this.aliases.set(await this.api.get('/platform/places/aliases')); } catch (e) { this.ui.error(e); } }
  async addAlias() {
    const a = this.aliasForm;
    if (!a.fromName.trim() || !a.toName.trim()) { this.ui.error('Fill in both names'); return; }
    if (await this.ui.run(() => this.api.post('/platform/places/aliases', { level: a.level, fromName: a.fromName.trim(), toName: a.toName.trim() }), 'Name match added. Upload the file again to use it.')) {
      this.aliasForm = { level: a.level, fromName: '', toName: '' }; await this.loadAliases();
    }
  }
  async removeAlias(a: { level: string; from_key: string }) {
    if (await this.ui.run(() => this.api.del(`/platform/places/aliases/${a.level}/${a.from_key}`), 'Removed')) await this.loadAliases();
  }

  edit(p: Place) { this.editing.set({ ...p }); window.scrollTo(0, 0); }
  async saveEdit() {
    const e = this.editing()!;
    const body: Record<string, unknown> = { name: e.name.trim() };
    if (e.code.length === 2) { if (e.zone) body['zone'] = e.zone; if (e.irev_state_no) body['irevStateNo'] = Number(e.irev_state_no); }
    if (await this.ui.run(() => this.api.patch(`/platform/places/${e.code}`, body), 'Saved')) { this.editing.set(null); await this.open(this.data()?.parent ?? 'NG'); }
  }

  async uploadVoters(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 9_000_000) { this.ui.error('The file is over 9 MB; split it by state'); return; }
    const csv = await file.text();
    const r = await this.ui.run(() => this.api.post<any>('/platform/places/registered-voters', { csv }));
    if (r) { this.votersResult.set(r); await this.open(this.data()?.parent ?? 'NG'); }
  }
}
