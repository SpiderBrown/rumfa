import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

interface Party { acronym: string; name: string; colour: string | null; logoUrl: string | null; elections: number; clients: number;
  ballots: { name: string; state: string | null; date: string }[] }
interface Form { editing: boolean; acronym: string; name: string; colour: string; logo: string | null; removeLogo: boolean; currentLogo: string | null }

/** Political parties shared by every client: name, colour on maps and charts, and logo. */
@Component({
  selector: 'page-parties',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule],
  template: `
  <div class="page">
    <div class="page-head">
      <p class="eyebrow">Shared by every client</p>
      <h1>Parties</h1>
      <span class="spacer"></span>
      @if (api.canEdit && !form()) { <button mat-flat-button (click)="startNew()"><mat-icon>add</mat-icon> Add party</button> }
      <p class="lede">Names, colours and logos used on results, maps and in every client's apps.</p>
    </div>

    @if (form(); as f) {
      <div class="card">
        <h2>{{ f.editing ? 'Edit ' + f.acronym : 'New party' }}</h2>
        <div class="formrow">
          <div class="logobox">
            @if (preview(f); as src) { <img [src]="src" alt="Logo" /> } @else { <span>No logo</span> }
            <label class="pick">
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" (change)="pickLogo($event)" hidden />
              <mat-icon>upload</mat-icon> {{ preview(f) ? 'Change logo' : 'Choose logo' }}
            </label>
            @if (preview(f)) { <button mat-button type="button" (click)="clearLogo()">Remove logo</button> }
          </div>
          <div class="fields">
            <div class="row">
              <mat-form-field><mat-label>Acronym on the ballot</mat-label>
                <input matInput [(ngModel)]="f.acronym" (ngModelChange)="f.acronym = $event.toUpperCase()" maxlength="8" [disabled]="f.editing" placeholder="e.g. NDC" />
                <mat-hint>Capital letters, as INEC writes it</mat-hint></mat-form-field>
              <mat-form-field><mat-label>Full name</mat-label><input matInput [(ngModel)]="f.name" placeholder="e.g. Nigeria Democratic Congress" /></mat-form-field>
            </div>
            <div class="colour">
              <input type="color" [(ngModel)]="f.colour" />
              <span>Colour on maps and charts <span class="hint">{{ f.colour }}</span></span>
            </div>
            <p class="hint">Logo: a square image works best (PNG with a clear background). It is resized to 256 × 256, up to 2 MB.</p>
          </div>
        </div>
        <div class="page-head">
          <span class="spacer"></span>
          <button mat-button (click)="form.set(null)">Cancel</button>
          <button mat-flat-button (click)="save()" [disabled]="busy()">{{ f.editing ? 'Save changes' : 'Add party' }}</button>
        </div>
      </div>
    }

    <table class="grid">
      <tr><th>Logo</th><th>Party</th><th>Short name</th><th>Colour</th><th>On ballot in</th><th>Used by</th><th></th></tr>
      @for (p of rows(); track p.acronym) {
        <tr>
          <td>@if (p.logoUrl) { <img class="logo big" [src]="api.asset(p.logoUrl)" [alt]="p.acronym + ' logo'" /> } @else { <span class="nologo">{{ p.acronym }}</span> }</td>
          <td><b>{{ p.name }}</b></td>
          <td>{{ p.acronym }}</td>
          <td><span class="swatch" [style.background]="p.colour ?? '#fff'"></span> <span class="hint">{{ p.colour ?? 'Not set' }}</span></td>
          <td>@if (p.ballots.length) {
              {{ ballotText(p) }}@if (p.ballots.length > 2) { <span class="hint" [title]="allBallots(p)"> +{{ p.ballots.length - 2 }} more</span> }
            } @else { <span class="hint">Not on a ballot yet</span> }</td>
          <td class="hint">{{ p.clients || '—' }}<div>{{ p.elections }} election(s)</div></td>
          <td>@if (api.canEdit) { <button mat-button (click)="edit(p)"><mat-icon>edit</mat-icon> Edit</button> }</td>
        </tr>
      }
    </table>
  </div>`,
  styles: `
    .logo.big { width: 44px; height: 44px; }
    .nologo { display: inline-grid; place-items: center; width: 44px; height: 44px; border-radius: 6px; border: 1px dashed var(--mat-sys-outline); font-size: 11px; color: var(--mat-sys-outline); }
    .formrow { display: flex; gap: 20px; flex-wrap: wrap; } .fields { flex: 1 1 360px; }
    .logobox { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 160px; }
    .logobox img, .logobox > span { width: 120px; height: 120px; object-fit: contain; border-radius: 12px; background: #fff; border: 1px solid var(--mat-sys-outline-variant);
      display: grid; place-items: center; color: var(--mat-sys-outline); font-size: 12px; }
    .pick { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; padding: 6px 12px; border-radius: 20px; color: var(--mat-sys-primary); font: var(--mat-sys-label-large); }
    .pick:hover { background: var(--mat-sys-surface-container); }
    .colour { display: flex; align-items: center; gap: 10px; margin: 4px 0 8px; }
    .colour input { width: 44px; height: 32px; border: none; background: none; cursor: pointer; }
  `,
})
export class PartiesPage {
  /** "2027 Presidential · Kano Governorship 2027": the two latest elections it's on */
  ballotText(p: Party) { return p.ballots.slice(0, 2).map((b) => b.name).join(' · '); }
  allBallots(p: Party) { return p.ballots.map((b) => `${b.name}${b.state ? ' (' + b.state + ')' : ''}`).join('\n'); }
  api = inject(Api);
  private ui = inject(Ui);
  rows = signal<Party[]>([]);
  form = signal<Form | null>(null);
  busy = signal(false);

  constructor() { void this.load(); }
  async load() { try { this.rows.set(await this.api.get<Party[]>('/platform/parties')); } catch (e) { this.ui.error(e); } }

  startNew() { this.form.set({ editing: false, acronym: '', name: '', colour: '#9e9e9e', logo: null, removeLogo: false, currentLogo: null }); }
  edit(p: Party) {
    this.form.set({ editing: true, acronym: p.acronym, name: p.name, colour: p.colour ?? '#9e9e9e', logo: null, removeLogo: false, currentLogo: this.api.asset(p.logoUrl) });
    window.scrollTo(0, 0);
  }
  /** The logo shown in the form: a newly chosen one, else the saved one (unless being removed) */
  preview(f: Form) { return f.logo ?? (f.removeLogo ? null : f.currentLogo); }

  async pickLogo(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2_000_000) { this.ui.error('The image is over 2 MB'); return; }
    const dataUrl = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = bad; r.readAsDataURL(file); });
    this.form.update((f) => f && { ...f, logo: dataUrl, removeLogo: false });
  }
  clearLogo() { this.form.update((f) => f && { ...f, logo: null, removeLogo: true }); }

  async save() {
    const f = this.form()!;
    const acronym = f.acronym.trim().toUpperCase();
    if (!/^[A-Z]{1,8}$/.test(acronym)) { this.ui.error('The acronym is 1 to 8 capital letters'); return; }
    if (f.name.trim().length < 2) { this.ui.error('Fill in the full name'); return; }
    this.busy.set(true);
    const ok = await this.ui.run(async () => {
      if (f.editing) await this.api.patch(`/platform/parties/${acronym}`, { name: f.name.trim(), colour: f.colour });
      else await this.api.post('/platform/parties', { acronym, name: f.name.trim(), colour: f.colour });
      if (f.logo) await this.api.put(`/platform/parties/${acronym}/logo`, { dataUrl: f.logo });
      else if (f.removeLogo && f.currentLogo) await this.api.del(`/platform/parties/${acronym}/logo`);
      return true;
    }, f.editing ? `${acronym} saved` : `${acronym} added`);
    this.busy.set(false);
    if (ok) { this.form.set(null); await this.load(); }
  }
}
