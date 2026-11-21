import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../core/api';
import { MediaLinks } from '../core/media';
import { Ui, label } from '../core/ui';

interface Recording { id: string; speaker: string; title: string; language: string; status: string; duration_s: number | null; created_at: string }
interface Campaign { id: string; name: string; status: string; recordings: Record<string, string>; audience: { states?: string[] }; starts_on: string; ends_on: string;
  daily_start: string; daily_end: string; calls_per_minute: number; created_by: string; counts: Record<string, number> | null; reached: number; avg_listen_s: number | null }

const LANGS = [{ code: 'ha', name: 'Hausa' }, { code: 'en', name: 'English' }, { code: 'ff', name: 'Fulfulde' }, { code: 'kr', name: 'Kanuri' }, { code: 'yo', name: 'Yoruba' }];
const STATUS: Record<string, { text: string; cls: string }> = {
  draft: { text: 'Draft', cls: 'off' }, approved: { text: 'Approved', cls: 'run' }, running: { text: 'Sending', cls: 'live' },
  paused: { text: 'Paused', cls: 'wait' }, done: { text: 'Sent', cls: 'ok' },
};

/**
 * Voice outreach (add-on): recorded voice calls to supporters in their language. A recording needs the speaker's
 * signed release and admin approval; a campaign needs approval by an admin who did not create it. Everyone called
 * can press 9 to opt out for good. Reported by how many were reached and how long they listened.
 */
@Component({
  selector: 'app-voice',
  imports: [DatePipe, DecimalPipe, FormsModule, MatButtonModule, MatIconModule],
  template: `
  <div class="page">
    <header class="head">
      <div>
        <p class="eyebrow">Add-on · switched on by Rumfa</p>
        <h1>Voice outreach</h1>
        <p class="lede">Recorded voice calls to supporters in their language. Calls run only between the daily hours you set (Lagos time) and stop when campaigning ends.</p>
      </div>
      <div class="head-r">
        <button mat-stroked-button (click)="panel.set(panel() === 'rec' ? null : 'rec')"><mat-icon>mic</mat-icon> Add recording</button>
        <button mat-flat-button (click)="panel.set(panel() === 'camp' ? null : 'camp')" [disabled]="!approvedAny()"><mat-icon>add</mat-icon> New campaign</button>
      </div>
    </header>

    @if (panel() === 'rec') {
      <section class="r-card panel" aria-label="Add a recording">
        <div class="p-head"><h2>Add a recording</h2><button mat-icon-button (click)="panel.set(null)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="form">
          <label><span>Speaker</span><input [(ngModel)]="r.speaker" /></label>
          <label><span>Title</span><input [(ngModel)]="r.title" placeholder="Get out and vote" /></label>
          <label><span>Language</span><select [(ngModel)]="r.language">@for (l of langs; track l.code) { <option [value]="l.code">{{ l.name }}</option> }</select></label>
          <label class="file"><mat-icon>audio_file</mat-icon><span>{{ r.audio?.name ?? 'Audio (mp3, wav, m4a)' }}</span>
            <input type="file" accept="audio/*" (change)="r.audio = $any($event.target).files[0]" /></label>
          <label class="file"><mat-icon>draw</mat-icon><span>{{ r.consent?.name ?? "Speaker's signed release" }}</span>
            <input type="file" accept="application/pdf,image/*" (change)="r.consent = $any($event.target).files[0]" /></label>
        </div>
        <div class="p-foot"><span class="muted sm">An admin listens and approves it before it can be used.</span>
          <button mat-flat-button (click)="upload()">Upload</button></div>
      </section>
    }

    @if (panel() === 'camp') {
      <section class="r-card panel" aria-label="New campaign">
        <div class="p-head"><h2>New campaign</h2><button mat-icon-button (click)="panel.set(null)" aria-label="Close"><mat-icon>close</mat-icon></button></div>
        <div class="form">
          <label><span>Name</span><input [(ngModel)]="c.name" placeholder="Polling unit reminder" /></label>
          @for (l of langs; track l.code) {
            @if (approved(l.code).length) {
              <label><span>{{ l.name }} recording</span><select [(ngModel)]="c.rec[l.code]">
                <option [ngValue]="null">None</option>
                @for (x of approved(l.code); track x.id) { <option [value]="x.id">{{ x.speaker }} · {{ x.title }}</option> }</select></label>
            }
          }
          <label><span>States (codes, comma-separated)</span><input [(ngModel)]="c.states" placeholder="19, 20" /></label>
          <label><span>From</span><input type="date" [(ngModel)]="c.from" /></label>
          <label><span>To</span><input type="date" [(ngModel)]="c.to" /></label>
          <label><span>Calls per minute</span><input type="number" min="1" max="600" [(ngModel)]="c.cpm" /></label>
        </div>
        <div class="p-foot"><span class="muted sm">Saved as a draft. Another admin approves it, then it can start.</span>
          <button mat-flat-button (click)="createCampaign()">Save draft</button></div>
      </section>
    }

    <section aria-label="Campaigns">
      <div class="cards">
        @for (x of campaigns(); track x.id) {
          <div class="camp r-card">
            <div class="c-top"><b>{{ x.name }}</b><span class="st" [class]="'st ' + st(x).cls">{{ st(x).text }}</span></div>
            <div class="muted xs">{{ x.starts_on | date: 'd MMM' }} – {{ x.ends_on | date: 'd MMM' }} · {{ x.daily_start.slice(0, 5) }}–{{ x.daily_end.slice(0, 5) }}
              @if (x.reached) { · {{ x.reached | number }} reached }</div>
            <div class="muted xs">{{ langsOf(x) }}{{ x.audience.states?.length ? ' · states ' + x.audience.states!.join(', ') : '' }}</div>
            <div class="listen">
              @if (firstRec(x); as rec) {
                <button class="play r-focus" (click)="play(rec)" [attr.aria-label]="'Play ' + rec.title"><mat-icon>{{ playing() === rec.id ? 'stop' : 'play_arrow' }}</mat-icon>{{ dur(rec.duration_s) }}</button>
              }
              <span class="bar" aria-hidden="true"><span [style.width.%]="listenPct(x)"></span></span>
              <span class="xs b">{{ listenPct(x) }}% listened</span>
            </div>
            <div class="c-acts">
              @if (x.status === 'draft' && api.isAdmin() && x.created_by !== api.me()?.id) { <button mat-stroked-button (click)="setStatus(x, 'approved')">Approve</button> }
              @if (x.status === 'draft' && x.created_by === api.me()?.id) { <span class="muted xs">Another admin approves it</span> }
              @if (x.status === 'approved' || x.status === 'paused') { <button mat-flat-button (click)="setStatus(x, 'running')"><mat-icon>play_arrow</mat-icon> Start</button> }
              @if (x.status === 'running') { <button mat-stroked-button (click)="setStatus(x, 'paused')"><mat-icon>pause</mat-icon> Pause</button> }
            </div>
          </div>
        } @empty {
          <div class="r-card empty"><mat-icon>campaign</mat-icon><b>No campaigns yet</b>
            <span class="muted">{{ approvedAny() ? 'Press New campaign.' : 'Add a recording first; once an admin approves it you can start a campaign.' }}</span></div>
        }
      </div>
    </section>

    <section class="r-card tbl" aria-label="Recordings">
      <div class="l-head"><h2>Recordings</h2><span class="muted sm">Each with the speaker's signed release</span></div>
      <table>
        <thead><tr><th></th><th>Recording</th><th>Language</th><th>Status</th><th class="r"><span class="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          @for (x of recordings(); track x.id) {
            <tr>
              <td class="w"><button class="play r-focus" (click)="play(x)" [attr.aria-label]="'Play ' + x.title"><mat-icon>{{ playing() === x.id ? 'stop' : 'play_arrow' }}</mat-icon>{{ dur(x.duration_s) }}</button></td>
              <td><b>{{ x.title }}</b><div class="muted xs">{{ x.speaker }}</div></td>
              <td>{{ langName(x.language) }}</td>
              <td><span class="st" [class]="'st ' + (x.status === 'approved' ? 'ok' : 'wait')">{{ x.status === 'approved' ? 'Approved' : 'Waiting for approval' }}</span></td>
              <td class="r">@if (x.status === 'draft' && api.isAdmin()) { <button mat-stroked-button (click)="approveRecording(x)">Approve</button> }</td>
            </tr>
          } @empty { <tr><td colspan="5"><p class="empty-row muted">No recordings yet.</p></td></tr> }
        </tbody>
      </table>
    </section>
  </div>`,
  styles: `
    .page { display: flex; flex-direction: column; gap: 16px; max-width: 1400px; }
    .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .head-r { display: flex; gap: 8px; }
    .eyebrow { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--r-muted); }
    h1 { margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -.01em; }
    .lede { margin: 6px 0 0; color: var(--r-ink-2); max-width: 760px; }
    h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .muted { color: var(--r-muted); } .sm { font-size: 13px; } .xs { font-size: 12px; } .b { font-weight: 700; }
    .panel { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .p-head, .p-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .form { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; align-items: end; }
    .form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--r-ink-2); }
    input, select { border: 1px solid var(--r-line); border-radius: 9px; padding: 8px 10px; font: inherit; font-size: 13.5px; background: #fff; color: var(--r-ink); }
    .form .file { flex-direction: row; align-items: center; gap: 8px; border: 1.5px dashed var(--r-line); border-radius: 10px; padding: 9px 12px; cursor: pointer; }
    .file input { display: none; } .file span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
    .camp { padding: 16px; display: flex; flex-direction: column; gap: 6px; }
    .c-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .listen { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
    .bar { flex: 1; height: 7px; border-radius: 999px; background: var(--r-line-soft); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--r-accent); border-radius: 999px; }
    .c-acts { display: flex; align-items: center; gap: 8px; margin-top: 6px; min-height: 36px; }
    .play { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--r-line); background: #fff; border-radius: 8px; padding: 4px 9px 4px 5px; font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
    .play mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .st { font-size: 11.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
    .st.ok { background: #e3f4ea; color: #146c3a; } .st.wait { background: var(--r-high-bg); color: #7a2e0b; } .st.off { background: var(--r-low-bg); color: var(--r-ink-2); }
    .st.run { background: var(--r-medium-bg); color: var(--r-medium); } .st.live { background: var(--r-accent); color: #fff; }
    .empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 32px; text-align: center; grid-column: 1 / -1; }
    .empty mat-icon { color: var(--r-accent); font-size: 32px; width: 32px; height: 32px; }
    .tbl { overflow-x: auto; }
    .l-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 14px 18px 10px; }
    table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    th { text-align: left; font-size: 12px; font-weight: 600; color: var(--r-muted); padding: 10px 14px; background: #fafbfc; border-top: 1px solid var(--r-line-soft); border-bottom: 1px solid var(--r-line); }
    td { padding: 10px 14px; border-bottom: 1px solid var(--r-line-soft); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: 0; }
    .r { text-align: right; } .w { width: 80px; }
    .empty-row { margin: 0; padding: 20px; text-align: center; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  `,
})
export class VoicePage {
  api = inject(Api);
  private ui = inject(Ui);
  private links = inject(MediaLinks);
  label = label;
  readonly langs = LANGS;
  recordings = signal<Recording[]>([]);
  campaigns = signal<Campaign[]>([]);
  panel = signal<'rec' | 'camp' | null>(null);
  playing = signal<string | null>(null);
  private audio = new Audio();
  r: { speaker: string; title: string; language: string; audio?: File; consent?: File } = { speaker: '', title: '', language: 'ha' };
  c = { name: '', rec: {} as Record<string, string | null>, states: '', from: '', to: '2027-01-14', cpm: 60 };

  approvedAny = computed(() => this.recordings().some((x) => x.status === 'approved'));
  private recById = computed(() => new Map(this.recordings().map((x) => [x.id, x])));

  constructor() {
    void this.load();
    this.audio.onended = () => this.playing.set(null);
  }

  approved(lang: string) { return this.recordings().filter((x) => x.status === 'approved' && x.language === lang); }
  st(x: Campaign) { return STATUS[x.status] ?? { text: label(x.status), cls: 'off' }; }
  langName(code: string) { return LANGS.find((l) => l.code === code)?.name ?? code; }
  langsOf(x: Campaign) { return Object.keys(x.recordings).map((l) => this.langName(l)).join(', '); }
  firstRec(x: Campaign) { const id = Object.values(x.recordings)[0]; return id ? this.recById().get(id) ?? null : null; }
  dur(s: number | null) { return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : ''; }
  /** How much of the message people stayed for, on average, among those who answered */
  listenPct(x: Campaign) {
    const len = this.firstRec(x)?.duration_s;
    if (!x.avg_listen_s || !len) return 0;
    return Math.min(100, Math.round(x.avg_listen_s / len * 100));
  }

  async load() {
    const [r, c] = await Promise.all([this.api.get<Recording[]>('/voice/recordings'), this.api.get<Campaign[]>('/voice/campaigns')])
      .catch((e) => { this.ui.error(e); return [[], []] as [Recording[], Campaign[]]; });
    this.recordings.set(r); this.campaigns.set(c);
  }

  async play(x: Recording) {
    if (this.playing() === x.id) { this.audio.pause(); this.playing.set(null); return; }
    try {
      this.audio.src = await this.links.url({ kind: 'voice', id: x.id });
      await this.audio.play();
      this.playing.set(x.id);
    } catch (e) { this.ui.error(e); }
  }

  async upload() {
    if (!this.r.speaker || !this.r.title || !this.r.audio || !this.r.consent) { this.ui.error('Speaker, title, audio and the signed release are required'); return; }
    const durationS = await new Promise<number | undefined>((res) => {
      const a = new Audio(URL.createObjectURL(this.r.audio!));
      a.onloadedmetadata = () => res(Number.isFinite(a.duration) ? Math.max(1, Math.round(a.duration)) : undefined);
      a.onerror = () => res(undefined);
    });
    const ok = await this.ui.run(async () => {
      const ext = (f: File) => (f.name.split('.').pop() ?? '').toLowerCase();
      const audio = await this.api.upload('voice_recording', this.r.audio!, ext(this.r.audio!));
      const release = await this.api.upload('voice_consent', this.r.consent!, ext(this.r.consent!));
      await this.api.post('/voice/recordings', { speaker: this.r.speaker, title: this.r.title, language: this.r.language, storagePath: audio, consentDocPath: release, durationS });
      return true;
    }, 'Uploaded; an admin must approve it');
    if (ok) { this.panel.set(null); this.r = { speaker: '', title: '', language: this.r.language }; await this.load(); }
  }

  async approveRecording(x: Recording) {
    if (!(await this.ui.confirm('Approve recording', `Confirm the signed release from ${x.speaker} covers this message.`, 'Approve'))) return;
    if (await this.ui.run(() => this.api.post(`/voice/recordings/${x.id}/approve`))) await this.load();
  }

  async createCampaign() {
    const recs = Object.fromEntries(Object.entries(this.c.rec).filter(([, v]) => v));
    if (!this.c.name || !Object.keys(recs).length || !this.c.from || !this.c.to) { this.ui.error('Name, dates and at least one recording are required'); return; }
    const ok = await this.ui.run(() => this.api.post('/voice/campaigns', { name: this.c.name, recordings: recs,
      audience: { states: this.c.states.split(',').map((s) => s.trim()).filter(Boolean), languages: Object.keys(recs) },
      startsOn: this.c.from, endsOn: this.c.to, callsPerMinute: Number(this.c.cpm) }), 'Draft saved; another admin must approve it');
    if (ok) { this.panel.set(null); await this.load(); }
  }

  async setStatus(x: Campaign, status: string) {
    if (status === 'running' && !(await this.ui.confirm(`Start ${x.name}?`, 'Calls begin within the daily hours. Each call costs airtime minutes.', 'Start'))) return;
    if (await this.ui.run(() => this.api.post(`/voice/campaigns/${x.id}/status`, { status }))) await this.load();
  }
}
