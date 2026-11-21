import { DatePipe } from '@angular/common';
import { Component, ElementRef, HostListener, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { checkResult, figureFlags, placeName, usedBallots } from '@rumfa/shared';
import { Api } from '../core/api';
import { Ui } from '../core/ui';
import { SheetViewer } from '../core/sheet-viewer';

interface Sheet {
  election_id: string; pu_code: string; sheet_version: number; registered: number | null; accredited: number | null; rejected: number | null;
  total_valid: number | null; votes: Record<string, number>; confidence: Record<string, number> | null; sheet_pu_code: string | null;
  pu_name: string; pu_registered: number | null; ward_name: string; lga_name: string; state_name: string;
  election_name: string; election_type: string; election_date: string; from_link: boolean;
  agent_check: 'asked' | 'matches' | 'differs' | null; agent_note: string | null;
  /** Our agent's signed sheet for this unit, to compare with */
  ours: { id: string; registered: number | null; accredited: number | null; rejected: number | null; total_valid: number | null; votes: Record<string, number>;
          has_photo: boolean; submitted_at: string; by: string | null; has_full: boolean; full_requested_at: string | null } | null;
  ballots_received: number | null; unused: number | null; spoiled: number | null; used: number | null;
}
type Core = 'registered' | 'accredited' | 'rejected' | 'total_valid';
/** Items 3, 4, 5 and 8: the ballot papers. Optional: fill them when the sheet shows them. */
type Ballot = 'ballots_received' | 'unused' | 'spoiled' | 'used';
type Key = Core | Ballot;
const CORE: Core[] = ['registered', 'accredited', 'rejected', 'total_valid'];

/** The numbered items of Form EC8A, in the sheet's own order, so reviewers read down the sheet and down the form together. */
const ITEMS: { n: number; label: string; key: Key; optional?: boolean }[] = [
  { n: 1, label: 'Number of voters on the register', key: 'registered' },
  { n: 2, label: 'Number of accredited voters', key: 'accredited' },
  { n: 3, label: 'Number of ballot papers issued to the polling unit', key: 'ballots_received', optional: true },
  { n: 4, label: 'Number of unused ballot papers', key: 'unused', optional: true },
  { n: 5, label: 'Number of spoiled ballot papers', key: 'spoiled', optional: true },
  { n: 6, label: 'Number of rejected ballots', key: 'rejected' },
  { n: 7, label: 'Number of total valid votes', key: 'total_valid' },
  { n: 8, label: 'Number of used ballot papers', key: 'used', optional: true },
];
const TYPE: Record<string, string> = { presidential: 'Presidential', governorship: 'Governorship', senate: 'Senate', reps: 'House of Representatives',
  state_assembly: 'State House of Assembly', chairman: 'Chairmanship', councillor: 'Councillorship', fct_area_council: 'FCT Area Council' };

/** 212 → "Two hundred and twelve", the way figures are written in words on the sheet */
export function inWords(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isInteger(n) || n < 0) return '';
  if (n === 0) return 'Zero';
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
    'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under100 = (x: number) => x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? '-' + ones[x % 10] : '');
  const under1000 = (x: number) => {
    const h = Math.floor(x / 100), r = x % 100;
    return [h ? ones[h] + ' hundred' : '', r ? (h ? 'and ' : '') + under100(r) : ''].filter(Boolean).join(' ');
  };
  const parts: string[] = [];
  for (const [size, word] of [[1_000_000, 'million'], [1_000, 'thousand']] as const) {
    if (n >= size) { parts.push(under1000(Math.floor(n / size)) + ' ' + word); n %= size; }
  }
  if (n) parts.push((parts.length && n < 100 ? 'and ' : '') + under1000(n));
  const s = parts.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Sheet review: IReV sheets whose figures the reader couldn't read confidently. The form mirrors Form EC8A. */
@Component({
  selector: 'app-irev-review',
  imports: [FormsModule, DatePipe, SheetViewer, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
  <header class="head">
    <div><p class="eyebrow">IReV sheets the reader wasn't sure about</p><h1>Sheet review</h1>
      <p class="lede">Read down the sheet and down the form together. Amber boxes are the ones the reader wasn't sure of.
        @if (byAgents()) { <br><b>{{ byAgents() }}</b> more were checked by our agents at the units and match their signed sheets, so they're not here. }</p></div>
    @if (queue().length) {
      <div class="nav">
        <button mat-icon-button (click)="step(-1)" [disabled]="queue().length < 2" aria-label="Previous sheet" matTooltip="Previous sheet"><mat-icon>chevron_left</mat-icon></button>
        <span class="pos"><b>{{ idx() + 1 }}</b> of {{ queue().length }}</span>
        <button mat-icon-button (click)="step(1)" [disabled]="queue().length < 2" aria-label="Next sheet" matTooltip="Next sheet"><mat-icon>chevron_right</mat-icon></button>
      </div>
    }
  </header>

  @if (loading()) { <p class="empty">Loading the review queue…</p> }
  @else if (cur(); as s) {
    @if (s.agent_check === 'differs') {
      <div class="agentsays"><mat-icon>report</mat-icon><span><b>Our agent at this unit says IReV is different from the sheet they signed</b>
        @if (s.agent_note) { : "{{ s.agent_note }}" }. A case is open with the legal desk; type what IReV shows.</span></div>
    } @else if (s.agent_check === 'asked') {
      <div class="agentsays wait"><mat-icon>hourglass_top</mat-icon><span>Our agent at this unit has been asked to check this sheet and hasn't answered yet.</span></div>
    }
    <div class="grid">
      <section class="sheet" aria-label="The sheets">
        @if (s.ours?.has_photo) {
          <div class="r-seg which" role="tablist" aria-label="Which sheet">
            <button type="button" role="tab" [class.on]="view() === 'irev'" (click)="showSheet('irev')">IReV copy</button>
            <button type="button" role="tab" [class.on]="view() === 'ours'" (click)="showSheet('ours')">Our agent's photo</button>
          </div>
        }
        @if (view() === 'ours') {
          <div class="src"><mat-icon aria-hidden="true">photo_camera</mat-icon> Sent by {{ s.ours?.by ?? 'our agent' }} · {{ s.ours?.submitted_at | date: 'd MMM, HH:mm' }}
            <span class="grow"></span>
            @if (s.ours?.has_full) { <button mat-button type="button" (click)="oursFull()"><mat-icon>hd</mat-icon> Full resolution</button> }
            @else if (s.ours?.full_requested_at || askedFull()) { <span class="xs">Full photo asked for</span> }
            @else { <button mat-button type="button" (click)="askFull()"><mat-icon>hd</mat-icon> Ask for the full photo</button> }</div>
        }
        @else if (s.from_link) { <div class="src"><mat-icon aria-hidden="true">link</mat-icon> Shown from INEC's link. We don't keep a copy of this sheet.</div> }
        <app-sheet-viewer [url]="view() === 'ours' ? oursUrl() : imgUrl()" />
      </section>

      <form class="paper" (submit)="$event.preventDefault(); confirm()" aria-label="Form EC8A figures" #paper>
        <div class="ph">
          <div class="org">Independent National Electoral Commission</div>
          <div class="form">FORM EC8A</div>
          <div class="title">Statement of result of poll from polling unit</div>
          <div class="el">{{ typeName(s.election_type) }} election · {{ s.election_date | date: 'd MMMM y' }}</div>
        </div>

        <dl class="where">
          <div><dt>State</dt><dd>{{ name(s.state_name) }}</dd></div>
          <div><dt>Local government area</dt><dd>{{ name(s.lga_name) }}</dd></div>
          <div><dt>Registration area (ward)</dt><dd>{{ name(s.ward_name) }}</dd></div>
          <div><dt>Polling unit</dt><dd>{{ name(s.pu_name) }}</dd></div>
          <div><dt>Polling unit code</dt><dd class="code">{{ s.pu_code }}
            @if (s.sheet_pu_code && s.sheet_pu_code !== s.pu_code) { <span class="flag">sheet shows {{ s.sheet_pu_code }}</span> }</dd></div>
          <div><dt>Sheet</dt><dd>Version {{ s.sheet_version }}{{ s.sheet_version > 1 ? ' (replaced on IReV)' : '' }}</dd></div>
        </dl>

        <ol class="items">
          @for (it of items; track it.n) {
            <li class="item" [class.unsure]="unsure(it.key)" [class.bad]="itemBad(it.key)" [class.opt]="it.optional">
              <span class="no">{{ it.n }}</span>
              <label class="lab" [for]="'f-' + it.key">{{ it.label }}
                @if (it.key === 'registered' && s.pu_registered) { <small>Our register for this unit: {{ s.pu_registered }}</small> }
                @if (it.key === 'used') { <small>Should be 5 + 6 + 7 = {{ usedShould() ?? '…' }}</small> }
                @if (it.optional && it.key !== 'used') { <small>If the sheet shows it</small> }</label>
              <input class="box" [id]="'f-' + it.key" inputmode="numeric" autocomplete="off" [ngModel]="form()[it.key] ?? ''" [name]="it.key"
                     [placeholder]="it.optional ? '—' : ''" (ngModelChange)="setField(it.key, $event)" (keydown.enter)="next($event)"
                     [attr.aria-invalid]="itemBad(it.key)" [attr.aria-describedby]="unsure(it.key) ? 'unsure-note' : null" />
              @if (unsure(it.key)) { <span class="chk" aria-hidden="true">check</span> }
              @if (oursOf(it.key); as o) { <span class="ours" [class.diff]="o.diff" [attr.title]="'On our agent sheet: ' + o.v">ours {{ o.v }}</span> }
            </li>
          }
        </ol>

        <table class="votes">
          <caption>Votes scored by each party
            @if (noBallot()) { <span class="nb">No ballot list is set for this election, so every registered party is listed alphabetically (INEC's ballot order). Leave parties not on the sheet at 0.</span> }</caption>
          <thead><tr><th scope="col" class="sn">S/N</th><th scope="col">Political party</th><th scope="col" class="fig">Votes in figures</th><th scope="col">Votes in words</th></tr></thead>
          <tbody>
            @for (p of parties(); track p; let i = $index) {
              <tr [class.unsure]="unsure('votes.' + p)" [class.plain]="!colourOf(p)">
                <td class="sn">{{ i + 1 }}</td>
                <td><span class="party"><i [style.background]="colourOf(p) ?? '#c9ced6'" aria-hidden="true"></i>{{ p }}</span></td>
                <td class="fig"><input class="box" inputmode="numeric" autocomplete="off" [ngModel]="votes()[p] ?? ''" [name]="'v-' + p" placeholder="0"
                       [attr.aria-label]="p + ' votes in figures'" (ngModelChange)="setVote(p, $event)" (keydown.enter)="next($event)" />
                  @if (unsure('votes.' + p)) { <span class="chk" aria-hidden="true">check</span> }
                  @if (oursVote(p); as o) { <span class="ours" [class.diff]="o.diff">ours {{ o.v }}</span> }</td>
                <td class="words">{{ inWords(votes()[p]) }}</td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr><td></td><th scope="row">Total of party votes</th><td class="fig sum">{{ partySum() }}</td>
              <td class="words">@if (form().total_valid !== null && form().total_valid !== undefined) {
                @if (partySum() === form().total_valid) { <span class="ok"><mat-icon aria-hidden="true">check_circle</mat-icon> Matches item 7</span> }
                @else { <span class="no-match"><mat-icon aria-hidden="true">error</mat-icon> Item 7 says {{ form().total_valid }}</span> } }</td></tr>
          </tfoot>
        </table>

        <div class="checks" aria-live="polite">
          @for (i of issues(); track i.code) { <div class="issue"><mat-icon aria-hidden="true">warning</mat-icon>{{ i.message }}</div> }
          @if (!issues().length && complete()) { <div class="good"><mat-icon aria-hidden="true">task_alt</mat-icon> The figures add up.</div> }
          @if (hasUnsure()) { <p id="unsure-note" class="note">Boxes marked <span class="chk inline">check</span> are where the reader wasn't sure. Compare them with the sheet.</p> }
        </div>

        @if (s.ours) {
          <div class="vs" [class.bad]="diffs().length" aria-live="polite">
            @if (diffs().length) {
              <mat-icon aria-hidden="true">warning</mat-icon>
              <span><b>Different from our agent's sheet:</b> {{ diffs().slice(0, 4).join(' · ') }}{{ diffs().length > 4 ? ' and ' + (diffs().length - 4) + ' more' : '' }}.
                Confirming what IReV shows opens a case for the legal desk. If our sheet is the one that's wrong, confirm anyway and say so on the case.</span>
            } @else { <mat-icon aria-hidden="true">verified</mat-icon><span>Same as our agent's sheet so far.</span> }
          </div>
        }
        <div class="acts">
          <button mat-button type="button" (click)="step(1)" [disabled]="queue().length < 2">Skip for now</button>
          <span class="grow"></span>
          @if (missing().length) { <span class="miss">Fill {{ missing().join(', ') }} to confirm</span> }
          @else { <span class="kbd">Enter moves down · {{ mac ? '⌘ Return' : 'Ctrl + Enter' }} confirms</span> }
          <button mat-flat-button type="submit" [disabled]="saving() || !complete()"><mat-icon>{{ diffs().length ? 'gavel' : 'done_all' }}</mat-icon> {{ diffs().length ? 'Confirm and open a legal case' : 'Confirm and next' }}</button>
        </div>
      </form>
    </div>
  } @else {
    <div class="done"><mat-icon aria-hidden="true">fact_check</mat-icon><h2>Nothing to review</h2><p>Every sheet read so far has been read confidently or checked by someone.</p></div>
  }`,
  styles: `
    :host { display: block; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); }
    .nav { display: flex; align-items: center; gap: 4px; background: #fff; border: 1px solid var(--r-line); border-radius: 10px; padding: 2px 6px; }
    .pos { font-size: 13px; color: var(--r-ink-2); min-width: 70px; text-align: center; }
    .empty { color: var(--r-muted); }
    .grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(420px, 1fr); gap: 20px; align-items: start; }
    .sheet { position: sticky; top: 72px; }
    .src { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: #1f4e8c; background: #e3ecf7; border-radius: 8px 8px 0 0; padding: 6px 10px; }
    .src mat-icon { font-size: 16px; width: 16px; height: 16px; }

    /* The paper: like the printed EC8A */
    .paper { background: #fffdf6; border: 1px solid #d9d2bd; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,.05), 0 8px 24px rgba(60,50,20,.06); padding: 18px 20px 16px; color: #1d1b16; }
    .ph { text-align: center; border-bottom: 2px solid #1d1b16; padding-bottom: 10px; }
    .org { font-size: 11.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #0b5a2b; }
    .form { font-size: 22px; font-weight: 800; letter-spacing: .04em; margin-top: 2px; }
    .title { font-size: 12.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .el { font-size: 12.5px; color: #5a5446; margin-top: 4px; }
    .where { display: grid; grid-template-columns: 1fr 1fr; gap: 0; margin: 0; border-bottom: 1px solid #cfc7b0; }
    .where > div { padding: 7px 4px; border-bottom: 1px dotted #d9d2bd; }
    .where > div:nth-last-child(-n+2) { border-bottom: 0; }
    dt { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #6b6452; }
    dd { margin: 2px 0 0; font-size: 14px; font-weight: 600; } .code { font-variant-numeric: tabular-nums; }
    .flag { margin-left: 6px; background: #fdecea; color: #b42318; font-size: 11.5px; font-weight: 700; border-radius: 6px; padding: 1px 6px; }

    .items { list-style: none; margin: 10px 0 0; padding: 0; }
    .item { display: grid; grid-template-columns: 28px 1fr 120px; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px dotted #d9d2bd; position: relative; }
    .no { width: 24px; height: 24px; border: 1.5px solid #1d1b16; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
    .lab { font-size: 13.5px; } .lab small { display: block; font-size: 11.5px; color: #6b6452; }
    .item.opt .no { border-style: dashed; } .box::placeholder { color: #b9b19a; font-weight: 400; }
    .box { width: 100%; box-sizing: border-box; font: inherit; font-size: 17px; font-weight: 700; text-align: right; font-variant-numeric: tabular-nums;
      padding: 6px 8px; border: 1.5px solid #8f8771; border-radius: 4px; background: #fff; color: #1d1b16; }
    .box:focus { outline: 3px solid rgba(15,118,110,.35); border-color: var(--r-accent); }
    .unsure .box { background: #fff4d6; border-color: #d99a00; }
    .bad .box, .box[aria-invalid="true"] { border-color: #b42318; }
    .chk { position: absolute; right: -6px; top: -6px; background: #b54708; color: #fff; font-size: 9.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; border-radius: 6px; padding: 1px 5px; pointer-events: none; }
    .chk.inline { position: static; display: inline-block; }

    .votes { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13.5px; }
    .votes caption { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #6b6452; padding-bottom: 6px; }
    .votes th, .votes td { border: 1px solid #b9b19a; padding: 4px 8px; }
    .votes thead th { background: #f1ecdc; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; text-align: left; }
    .votes .sn { width: 34px; text-align: center; } .votes .fig { width: 120px; position: relative; }
    .votes .box { font-size: 15px; padding: 4px 6px; }
    .party { display: inline-flex; align-items: center; gap: 7px; font-weight: 700; }
    .party i { width: 12px; height: 12px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgba(0,0,0,.25); }
    .words { font-size: 12.5px; color: #3c3627; font-style: italic; }
    .nb { display: block; text-transform: none; letter-spacing: 0; font-weight: 500; font-size: 12px; color: #7a3306; background: #fff4e5; border-radius: 6px; padding: 5px 8px; margin-top: 4px; }
    tr.unsure td { background: #fffaf0; }
    tfoot th { text-align: left; } .sum { font-weight: 800; font-size: 16px; text-align: right; font-variant-numeric: tabular-nums; }
    .ok, .no-match { display: inline-flex; align-items: center; gap: 4px; font-style: normal; font-weight: 600; }
    .ok { color: #157f3b; } .no-match { color: #b42318; }
    .ok mat-icon, .no-match mat-icon { font-size: 16px; width: 16px; height: 16px; }

    .checks { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
    .issue, .good { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; border-radius: 6px; padding: 6px 10px; }
    .issue { background: #fdecea; color: #7a1d14; } .good { background: #e5f4ea; color: #0f5a2a; }
    .issue mat-icon, .good mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .note { margin: 0; font-size: 12px; color: #6b6452; }
    .acts { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 2px solid #1d1b16; }
    .grow { flex: 1; } .kbd { font-size: 11.5px; color: #6b6452; } .miss { font-size: 12px; font-weight: 600; color: #b54708; }
    tr.plain td { color: #8a8472; } tr.plain .party { font-weight: 600; } tr.plain .box { border-color: #d6d0bd; }
    .which { margin-bottom: 8px; } .src .xs { font-size: 12px; font-weight: 600; } .src .grow { flex: 1; }
    .ours { display: inline-block; margin-left: 8px; font-size: 11.5px; font-weight: 700; color: var(--r-muted); white-space: nowrap; }
    .ours.diff { color: #7a2e0b; background: var(--r-high-bg); border-radius: 999px; padding: 1px 7px; }
    .vs { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0; padding: 10px 12px; border-radius: 10px; background: #eef7f5; color: #0b5a54; font-size: 13.5px; }
    .vs.bad { background: var(--r-high-bg); color: #7a2e0b; } .vs mat-icon { flex: none; }
    .agentsays { display: flex; align-items: center; gap: 10px; padding: 10px 14px; margin-bottom: 12px; border-radius: 10px; background: #fdecea; color: #7a1d16; font-size: 13.5px; }
    .agentsays.wait { background: #f3f7fb; color: var(--r-ink-2); }
    .done { text-align: center; padding: 60px 20px; color: var(--r-muted); } .done mat-icon { font-size: 48px; width: 48px; height: 48px; color: #c5ccd6; }
    .done h2 { color: var(--r-ink); margin: 8px 0 4px; }
    @media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } .sheet { position: static; } }
  `,
})
export class IrevReviewPage {
  private api = inject(Api);
  private ui = inject(Ui);
  private host = inject(ElementRef<HTMLElement>);
  readonly items = ITEMS;
  inWords = inWords;
  queue = signal<Sheet[]>([]);
  /** Sheets taken off the queue because our agent at the unit confirmed IReV matches their signed sheet */
  byAgents = signal(0);
  idx = signal(0);
  loading = signal(true);
  saving = signal(false);
  cur = computed(() => this.queue()[this.idx()] ?? null);
  parties = signal<string[]>([]);
  /** The election has no ballot list in Rumfa: all registered parties are shown, alphabetically */
  noBallot = signal(false);
  imgUrl = signal<string | null>(null);
  oursUrl = signal<string | null>(null);
  view = signal<'irev' | 'ours'>('irev');
  /** Our agent's figure for an item, and whether what's typed differs */
  oursOf(k: Key): { v: number; diff: boolean } | null {
    const o = this.cur()?.ours; if (!o || !(k in o) || (o as any)[k] == null) return null;
    const v = Number((o as any)[k]), typed = this.form()[k];
    return { v, diff: typed != null && Number(typed) !== v };
  }
  oursVote(p: string): { v: number; diff: boolean } | null {
    const o = this.cur()?.ours; if (!o) return null;
    const v = Number(o.votes?.[p] ?? 0), typed = this.votes()[p] ?? 0;
    return { v, diff: Number(typed) !== v };
  }
  /** Where the figures typed (what IReV shows) differ from our agent's sheet */
  diffs = computed(() => {
    const o = this.cur()?.ours; if (!o) return [] as string[];
    const out: string[] = [];
    for (const it of ITEMS) { const x = this.oursOf(it.key); if (x?.diff) out.push(`${it.label.split(' (')[0]} ${x.v} vs ${this.form()[it.key]}`); }
    for (const p of this.parties()) { const x = this.oursVote(p); if (x?.diff) out.push(`${p} ${x.v} vs ${this.votes()[p] ?? 0}`); }
    return out;
  });
  askedFull = signal(false);
  async oursFull() { const o = this.cur()?.ours; if (o) this.oursUrl.set(await this.api.viewUrl({ kind: 'ec8a', id: o.id, full: true }).catch(() => this.oursUrl())); }
  async askFull() {
    const o = this.cur()?.ours; if (!o) return;
    const ok = await this.ui.run(() => this.api.post(`/results/${o.id}/request-full-photo`), 'Asked. The full photo comes when the agent\'s phone is online.');
    if (ok !== undefined) this.askedFull.set(true);
  }
  async showSheet(w: 'irev' | 'ours') {
    this.view.set(w);
    const s = this.cur();
    if (w === 'ours' && s?.ours && !this.oursUrl()) this.oursUrl.set(await this.api.viewUrl({ kind: 'ec8a', id: s.ours.id }).catch(() => null));
  }
  form = signal<Partial<Record<Key, number | null>>>({});
  votes = signal<Record<string, number | null>>({});

  partySum = computed(() => Object.values(this.votes()).reduce<number>((a, b) => a + (b ?? 0), 0));
  /** Items 1, 2, 6, 7 and every party are needed; the ballot papers are optional */
  complete = computed(() => this.missing().length === 0);
  /** What still needs a number before confirming: items 1, 2, 6 and 7. A party box left blank counts as 0 (as on the sheet). */
  missing = computed(() => { const f = this.form(); return ITEMS.filter((i) => !i.optional && !Number.isInteger(f[i.key])).map((i) => `item ${i.n}`); });
  /** Mac keyboards: ⌘ Return (Ctrl + Enter also works) */
  readonly mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  /** What item 8 should be: spoiled + rejected + valid */
  usedShould = computed(() => { const f = this.form(); return usedBallots({ spoiled: f.spoiled ?? undefined, rejected: f.rejected ?? undefined, total_valid: f.total_valid ?? undefined }); });
  /** The ballot-paper checks, as on the phone: issued = used + unused, used = spoiled + rejected + valid */
  private ballotIssues = computed(() => {
    const f = this.form(), u = (k: Key) => f[k] ?? undefined;
    return figureFlags({ ballots_received: u('ballots_received'), unused: u('unused'), spoiled: u('spoiled'), used: u('used'), rejected: u('rejected'), total_valid: u('total_valid') })
      .filter((x) => x.flag === 'ballots_unbalanced' || x.flag === 'used_mismatch').map((x) => ({ code: x.flag, message: x.message }));
  });
  private figures = computed(() => {
    const f = this.form();
    return { registered: f.registered ?? 0, accredited: f.accredited ?? 0, rejected: f.rejected ?? 0, totalValid: f.total_valid ?? 0,
      votes: Object.fromEntries(this.parties().map((p) => [p, this.votes()[p] ?? 0])) };
  });
  issues = computed(() => [...(this.complete() ? checkResult(this.figures()) : []), ...this.ballotIssues()]);
  hasUnsure = computed(() => { const s = this.cur(); return !!s && [...ITEMS.map((i) => i.key), ...this.parties().map((p) => 'votes.' + p)].some((k) => this.unsure(k)); });

  constructor() { void this.load(); }

  @HostListener('keydown', ['$event'])
  key(e: KeyboardEvent) {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (!this.complete()) { this.ui.toast(`Fill ${this.missing().join(', ')} first`); this.focusMissing(); return; }
    void this.confirm();
  }
  private focusMissing() {
    const first = ITEMS.find((i) => !i.optional && !Number.isInteger(this.form()[i.key]));
    const el = first && (this.host.nativeElement as HTMLElement).querySelector<HTMLInputElement>(`#f-${first.key}`);
    el?.focus();
  }
  /** Only the colours set in Console → Parties; other parties stay grey so they're easy to skip */
  colourOf(p: string): string | null { return this.api.partyColours()[p] ?? null; }

  async load() {
    this.loading.set(true);
    const elections = [this.api.liveElectionId(), this.api.baselineElectionId()].filter(Boolean) as string[];
    const lists = await Promise.all(elections.map((e) => this.api.get<Sheet[]>('/irev/review', { election: e }).catch(() => [])));
    // Sheets our agents confirmed match their own are verified for us: nothing to type. Disputed ones (a case is open) first.
    const all = lists.flat();
    this.byAgents.set(all.filter((x) => x.agent_check === 'matches').length);
    const rank = (x: Sheet) => (x.agent_check === 'differs' ? 0 : x.agent_check ? 2 : 1);
    this.queue.set(all.filter((x) => x.agent_check !== 'matches').sort((a, b) => rank(a) - rank(b)).slice(0, 200));
    this.idx.set(0);
    this.loading.set(false);
    await this.show();
  }

  typeName(t: string) { return TYPE[t] ?? 'General'; }
  name(n: string) { return placeName(n); }
  unsure(k: string) { const c = this.cur()?.confidence; return !!c && c[k] !== undefined && c[k] < 0.85; }
  itemBad(k: Key) {
    const codes = this.issues().map((i) => i.code);
    return (k === 'total_valid' && codes.includes('sum_mismatch')) || (k === 'accredited' && (codes.includes('over_accredited') || codes.includes('over_registered')))
      || (k === 'registered' && codes.includes('over_registered'))
      || (['ballots_received', 'unused'].includes(k) && codes.includes('ballots_unbalanced')) || (k === 'used' && codes.includes('used_mismatch'));
  }
  private num(v: string | number | null): number | null {
    const s = String(v ?? '').replace(/[^\d]/g, '');
    return s === '' ? null : Number(s);
  }
  setField(k: Key, v: string) { this.form.update((f) => ({ ...f, [k]: this.num(v) })); }
  setVote(p: string, v: string) { this.votes.update((m) => ({ ...m, [p]: this.num(v) })); }

  /** Enter moves to the next box, down the sheet */
  next(e: Event) {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.metaKey) return;   // the confirm shortcut, handled above
    e.preventDefault();
    const boxes = [...(this.host.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input.box')];
    const i = boxes.indexOf(e.target as HTMLInputElement);
    if (i >= 0 && i < boxes.length - 1) { boxes[i + 1].focus(); boxes[i + 1].select(); }
  }

  async show() {
    const s = this.cur();
    this.imgUrl.set(null); this.oursUrl.set(null); this.view.set('irev'); this.askedFull.set(false);
    if (!s) return;
    let parties = await this.api.get<string[]>(`/elections/${s.election_id}/parties`).catch(() => [] as string[]);
    this.noBallot.set(!parties.length);
    if (!parties.length) parties = await this.api.get<string[]>(`/elections/${s.election_id}/parties`, { fallback: 'registered' }).catch(() => Object.keys(s.votes ?? {}));
    this.parties.set(parties);
    this.form.set({ registered: s.registered, accredited: s.accredited, rejected: s.rejected, total_valid: s.total_valid,
      ballots_received: s.ballots_received, unused: s.unused, spoiled: s.spoiled, used: s.used });
    this.votes.set(Object.fromEntries(this.parties().map((p) => [p, s.votes?.[p] ?? null])));
    this.imgUrl.set(await this.api.viewUrl({ kind: 'irev', electionId: s.election_id, pu: s.pu_code }).catch(() => null));
    setTimeout(() => { const first = (this.host.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input.box'); first?.focus(); first?.select(); });
  }

  async step(d: number) {
    const n = this.queue().length; if (!n) return;
    this.idx.set((this.idx() + d + n) % n);
    await this.show();
  }

  async confirm() {
    const s = this.cur();
    if (!s || !this.complete() || this.saving()) return;
    const f = this.figures(), b = this.form();
    const issues = this.issues();
    if (issues.length && !(await this.ui.confirm('The figures don\'t add up', issues.map((i) => i.message).join(' ') + ' Save them exactly as the sheet shows?', 'Save as the sheet shows'))) return;
    this.saving.set(true);
    const ok = await this.ui.run(async () => {
      await this.api.post('/irev/sheets/confirm', { electionId: s.election_id, pu: s.pu_code, version: s.sheet_version, registered: f.registered,
        accredited: f.accredited, rejected: f.rejected, totalValid: f.totalValid, votes: f.votes,
        ballotsReceived: b.ballots_received ?? undefined, unused: b.unused ?? undefined, spoiled: b.spoiled ?? undefined, used: b.used ?? undefined });
      return true;
    }, `Confirmed ${s.pu_code}`);
    this.saving.set(false);
    if (!ok) return;
    const rest = this.queue().filter((x) => x !== s);
    this.queue.set(rest);
    if (this.idx() >= rest.length) this.idx.set(0);
    await this.show();
  }
}
