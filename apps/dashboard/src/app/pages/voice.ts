import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { Supa } from '../core/supabase';
import { Ui, label } from '../core/ui';

/**
 * Voice outreach: real, consented recordings only. A recording needs a signed
 * release and admin approval; a campaign needs approval by an admin who did
 * not create it. Everyone called can press 9 to opt out for good.
 */
@Component({
  selector: 'app-voice',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTableModule, MatIconModule],
  template: `
  <h1>Voice outreach</h1>
  <h2>Recordings</h2>
  <div class="form">
    <mat-form-field><mat-label>Speaker</mat-label><input matInput [(ngModel)]="r.speaker" /></mat-form-field>
    <mat-form-field><mat-label>Title</mat-label><input matInput [(ngModel)]="r.title" /></mat-form-field>
    <mat-form-field><mat-label>Language</mat-label><mat-select [(ngModel)]="r.language">
      @for (l of langs; track l.code) { <mat-option [value]="l.code">{{ l.name }}</mat-option> }</mat-select></mat-form-field>
    <label class="file">Audio <input type="file" accept="audio/*" (change)="r.audio = $any($event.target).files[0]" /></label>
    <label class="file">Signed release (PDF) <input type="file" accept="application/pdf,image/*" (change)="r.consent = $any($event.target).files[0]" /></label>
    <button mat-flat-button (click)="upload()">Upload</button>
  </div>
  <table mat-table [dataSource]="recordings()">
    <ng-container matColumnDef="t"><th mat-header-cell *matHeaderCellDef>Recording</th><td mat-cell *matCellDef="let x">{{ x.speaker }} · {{ x.title }} ({{ x.language }})</td></ng-container>
    <ng-container matColumnDef="s"><th mat-header-cell *matHeaderCellDef>Status</th><td mat-cell *matCellDef="let x">{{ label(x.status) }}</td></ng-container>
    <ng-container matColumnDef="a"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let x">
      @if (x.status === 'draft' && supa.isAdmin()) { <button mat-stroked-button (click)="approveRecording(x)">Approve</button> }</td></ng-container>
    <tr mat-header-row *matHeaderRowDef="['t','s','a']"></tr><tr mat-row *matRowDef="let row; columns: ['t','s','a']"></tr>
  </table>

  <h2>Campaigns</h2>
  <div class="form">
    <mat-form-field><mat-label>Name</mat-label><input matInput [(ngModel)]="c.name" /></mat-form-field>
    @for (l of langs; track l.code) {
      <mat-form-field><mat-label>{{ l.name }} recording</mat-label><mat-select [(ngModel)]="c.rec[l.code]">
        <mat-option [value]="null">None</mat-option>
        @for (x of approved(l.code); track x.id) { <mat-option [value]="x.id">{{ x.speaker }} · {{ x.title }}</mat-option> }</mat-select></mat-form-field>
    }
    <mat-form-field><mat-label>States (codes, comma-separated)</mat-label><input matInput [(ngModel)]="c.states" /></mat-form-field>
    <mat-form-field><mat-label>From</mat-label><input matInput type="date" [(ngModel)]="c.from" /></mat-form-field>
    <mat-form-field><mat-label>To</mat-label><input matInput type="date" [(ngModel)]="c.to" /></mat-form-field>
    <mat-form-field><mat-label>Calls per minute</mat-label><input matInput type="number" [(ngModel)]="c.cpm" /></mat-form-field>
    <button mat-flat-button (click)="createCampaign()">Save draft</button>
  </div>
  <table mat-table [dataSource]="campaigns()">
    <ng-container matColumnDef="n"><th mat-header-cell *matHeaderCellDef>Campaign</th><td mat-cell *matCellDef="let x">{{ x.name }} · {{ x.starts_on }} to {{ x.ends_on }}</td></ng-container>
    <ng-container matColumnDef="s"><th mat-header-cell *matHeaderCellDef>Status</th><td mat-cell *matCellDef="let x">{{ label(x.status) }}
      @if (stats()[x.id]; as st) { <div class="hint">{{ st }}</div> }</td></ng-container>
    <ng-container matColumnDef="a"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let x">
      @if (x.status === 'draft' && supa.isAdmin() && x.created_by !== supa.me()?.id) { <button mat-stroked-button (click)="setStatus(x, 'approved', true)">Approve</button> }
      @if (x.status === 'approved' || x.status === 'paused') { <button mat-flat-button (click)="setStatus(x, 'running')">Start</button> }
      @if (x.status === 'running') { <button mat-stroked-button (click)="setStatus(x, 'paused')">Pause</button> }
    </td></ng-container>
    <tr mat-header-row *matHeaderRowDef="['n','s','a']"></tr><tr mat-row *matRowDef="let row; columns: ['n','s','a']"></tr>
  </table>
  <p class="hint">Calls run only between the daily start and end times (Lagos time), and stop before campaigning ends at midnight on 14 January.</p>`,
  styles: `h1 { font: var(--mat-sys-headline-small); } h2 { font: var(--mat-sys-title-medium); margin-top: 24px; } table { width: 100%; }
    .form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; } .file { font-size: 12px; display: flex; flex-direction: column; }
    .hint { font-size: 12px; color: var(--mat-sys-on-surface-variant); }`,
})
export class VoicePage {
  supa = inject(Supa);
  private ui = inject(Ui);
  label = label;
  langs = [{ code: 'ha', name: 'Hausa' }, { code: 'en', name: 'English' }, { code: 'ff', name: 'Fulfulde' }, { code: 'kr', name: 'Kanuri' }, { code: 'yo', name: 'Yoruba' }];
  recordings = signal<any[]>([]);
  campaigns = signal<any[]>([]);
  stats = signal<Record<string, string>>({});
  r: { speaker: string; title: string; language: string; audio?: File; consent?: File } = { speaker: '', title: '', language: 'ha' };
  c = { name: '', rec: {} as Record<string, string | null>, states: '', from: '', to: '2027-01-14', cpm: 60 };

  constructor() { void this.load(); }

  approved(lang: string) { return this.recordings().filter((x) => x.status === 'approved' && x.language === lang); }

  async load() {
    const [r, c] = await Promise.all([
      this.supa.client.from('voice_recordings').select('*').order('created_at', { ascending: false }),
      this.supa.client.from('voice_campaigns').select('*').order('created_at', { ascending: false }),
    ]);
    this.recordings.set(r.data ?? []); this.campaigns.set(c.data ?? []);
    const st: Record<string, string> = {};
    for (const x of c.data ?? []) {
      const { data } = await this.supa.client.from('voice_call_attempts').select('status').eq('campaign_id', x.id).limit(100000);
      if (!data?.length) continue;
      const k: Record<string, number> = {};
      for (const a of data) k[a.status] = (k[a.status] ?? 0) + 1;
      st[x.id] = Object.entries(k).map(([s, n]) => `${label(s)} ${n.toLocaleString()}`).join(' · ');
    }
    this.stats.set(st);
  }

  async upload() {
    const me = this.supa.me()!;
    if (!this.r.speaker || !this.r.title || !this.r.audio || !this.r.consent) { this.ui.error('Speaker, title, audio and the signed release are required'); return; }
    await this.ui.run(async () => {
      const base = `${me.tenant_id}/${crypto.randomUUID()}`;
      const a = await this.supa.client.storage.from('voice-recordings').upload(`${base}.${this.r.audio!.name.split('.').pop()}`, this.r.audio!);
      if (a.error) throw a.error;
      const k = await this.supa.client.storage.from('voice-recordings').upload(`${base}-release.${this.r.consent!.name.split('.').pop()}`, this.r.consent!);
      if (k.error) throw k.error;
      const { error } = await this.supa.client.from('voice_recordings').insert({ tenant_id: me.tenant_id, speaker: this.r.speaker, title: this.r.title,
        language: this.r.language, storage_path: a.data.path, consent_doc_path: k.data.path });
      if (error) throw error;
    }, 'Uploaded; an admin must approve it');
    await this.load();
  }

  async approveRecording(x: any) {
    if (!(await this.ui.confirm('Approve recording', `Confirm the signed release from ${x.speaker} covers this message.`, 'Approve'))) return;
    const { error } = await this.supa.client.from('voice_recordings').update({ status: 'approved', approved_by: this.supa.me()!.id, approved_at: new Date().toISOString() }).eq('id', x.id);
    if (error) this.ui.error(error.message); else await this.load();
  }

  async createCampaign() {
    const recs = Object.fromEntries(Object.entries(this.c.rec).filter(([, v]) => v));
    if (!this.c.name || !Object.keys(recs).length || !this.c.from || !this.c.to) { this.ui.error('Name, dates and at least one recording are required'); return; }
    const { error } = await this.supa.client.from('voice_campaigns').insert({
      tenant_id: this.supa.me()!.tenant_id, name: this.c.name, recordings: recs,
      audience: { states: this.c.states.split(',').map((s) => s.trim()).filter(Boolean), languages: Object.keys(recs) },
      starts_on: this.c.from, ends_on: this.c.to, calls_per_minute: this.c.cpm, created_by: this.supa.me()!.id,
    });
    if (error) this.ui.error(error.message); else { this.ui.toast('Draft saved; another admin must approve it'); await this.load(); }
  }

  async setStatus(x: any, status: string, approving = false) {
    const patch: Record<string, unknown> = { status };
    if (approving) patch['approved_by'] = this.supa.me()!.id;
    const { error } = await this.supa.client.from('voice_campaigns').update(patch).eq('id', x.id);
    if (error) this.ui.error(error.message); else await this.load();
  }
}
