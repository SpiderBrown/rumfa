import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

interface CallSettings { phone: boolean; bridged: boolean; webrtc: boolean; inapp: boolean }
interface CheckinSettings { opens: string; anyDay: boolean }
interface AllSettings { calls: CallSettings; checkin: CheckinSettings; party: string | null; parties: string[] }

/** The organisation's own settings. Admins only. */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatSlideToggleModule],
  template: `
  <h1>Settings</h1>
  @if (all(); as a) {
    <h2>Our party</h2>
    <p class="hint">Your party's button comes first and largest on the agents' live count, so they never miss a ballot for you. The other parties follow in ballot order.</p>
    <mat-form-field class="narrow">
      <mat-label>Party</mat-label>
      <mat-select [ngModel]="a.party" (ngModelChange)="setParty($event)">
        <mat-option [value]="null">None (ballot order only)</mat-option>
        @for (p of a.parties; track p) { <mat-option [value]="p">{{ p }}</mat-option> }
      </mat-select>
    </mat-form-field>

    <h2>Check-in at polling units</h2>
    <p class="hint">Agents tap Check in once when they reach their unit; the first check-in is their arrival time. Check-in opens on election day at the time below (Lagos time) and closes at midnight. INEC officials arrive about 7:30 am and voting starts at 8:30 am, so 6:00 am gives agents time to be in place.</p>
    <mat-form-field class="narrow">
      <mat-label>Opens on election day at</mat-label>
      <input matInput type="time" [ngModel]="a.checkin.opens" (change)="setCheckin({ opens: $any($event.target).value })" />
    </mat-form-field>
    <div class="opt">
      <mat-slide-toggle [checked]="a.checkin.anyDay" (change)="setCheckin({ anyDay: $event.checked })">Practice: allow check-in on any day</mat-slide-toggle>
      <p>For training and mock drills before the election. Turn it off before election day so early taps are not taken as arrivals.</p>
    </div>
  }

  <h2>Calls in the agent app</h2>
  <p class="hint">How agents, volunteers and coordinators can call people from a chat. Turn on at least one. Room staff always have phone calling in this dashboard; app calls follow the switch below in both apps.</p>
  @if (calls(); as c) {
    <div class="opt">
      <mat-slide-toggle [checked]="c.inapp" (change)="set('inapp', $event.checked)">App call (free)</mat-slide-toggle>
      <p>A voice call over the internet between two people using the Rumfa apps: agent app to agent app, or with this dashboard. No phone network, so no per-minute charge; both people need data. Applies to the dashboard too. Needs LiveKit set up on the server.</p>
    </div>
    <div class="opt">
      <mat-slide-toggle [checked]="c.bridged" (change)="set('bridged', $event.checked)">Rumfa call</mat-slide-toggle>
      <p>Rumfa rings the caller's phone, then connects the other person. Your organisation pays for the minutes, and no one sees the other person's number. Calls can be recorded.</p>
    </div>
    <div class="opt">
      <mat-slide-toggle [checked]="c.webrtc" (change)="set('webrtc', $event.checked)">Internet call</mat-slide-toggle>
      <p>The caller speaks over mobile data; the other person gets a normal phone call. Cheaper per minute, but breaks up on weak data. Needs the call client set up in the app's config.</p>
    </div>
    <div class="opt">
      <mat-slide-toggle [checked]="c.phone" (change)="set('phone', $event.checked)">Phone call</mat-slide-toggle>
      <p>Opens the phone's own dialler. Works on the weakest signal, but uses the caller's airtime and shows them the number.</p>
    </div>
    @if (!c.phone && !c.bridged && !c.webrtc && !c.inapp) { <p class="warn">All calling is off: the call button is hidden in the agent app.</p> }
  }`,
  styles: `h1 { font: var(--mat-sys-headline-small); } h2 { margin-top: 28px; } .narrow { width: 260px; } .hint { color: var(--mat-sys-on-surface-variant); max-width: 640px; }
    .opt { margin: 16px 0; max-width: 640px; } .opt p { margin: 4px 0 0 52px; font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .warn { color: var(--mat-sys-error); }`,
})
export class SettingsPage {
  private api = inject(Api);
  private ui = inject(Ui);
  calls = signal<CallSettings | null>(null);
  all = signal<AllSettings | null>(null);

  constructor() { void this.load(); }

  async load() {
    try { const a = await this.api.get<AllSettings>('/settings'); this.all.set(a); this.calls.set(a.calls); } catch (e) { this.ui.error(e); }
  }

  async set(k: keyof CallSettings, on: boolean) {
    const r = await this.ui.run(() => this.api.patch<CallSettings>('/settings/calls', { [k]: on }), 'Saved. Agents see it next time the app refreshes.');
    if (r) this.calls.set(r); else await this.load();
  }

  async setParty(party: string | null) {
    const r = await this.ui.run(() => this.api.patch('/settings/party', { party }), 'Saved. Agents see it next time the app refreshes.');
    if (r) this.all.update((a) => a && { ...a, party }); else await this.load();
  }

  async setCheckin(d: Partial<CheckinSettings>) {
    if (d.opens === '') return;
    const r = await this.ui.run(() => this.api.patch<CheckinSettings>('/settings/checkin', d), 'Saved.');
    if (r) this.all.update((a) => a && { ...a, checkin: r }); else await this.load();
  }
}
