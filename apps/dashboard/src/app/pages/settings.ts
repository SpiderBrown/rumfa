import { Component, inject, signal } from '@angular/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

interface CallSettings { phone: boolean; bridged: boolean; webrtc: boolean }

/** The organisation's own settings. Admins only. */
@Component({
  selector: 'app-settings',
  imports: [MatSlideToggleModule],
  template: `
  <h1>Settings</h1>
  <h2>Calls in the agent app</h2>
  <p class="hint">How agents, volunteers and coordinators can call people from a chat. Turn on at least one. Room staff always call from this dashboard.</p>
  @if (calls(); as c) {
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
    @if (!c.phone && !c.bridged && !c.webrtc) { <p class="warn">All calling is off: the call button is hidden in the agent app.</p> }
  }`,
  styles: `h1 { font: var(--mat-sys-headline-small); } .hint { color: var(--mat-sys-on-surface-variant); max-width: 640px; }
    .opt { margin: 16px 0; max-width: 640px; } .opt p { margin: 4px 0 0 52px; font-size: 13px; color: var(--mat-sys-on-surface-variant); }
    .warn { color: var(--mat-sys-error); }`,
})
export class SettingsPage {
  private api = inject(Api);
  private ui = inject(Ui);
  calls = signal<CallSettings | null>(null);

  constructor() { void this.load(); }

  async load() {
    try { this.calls.set((await this.api.get<{ calls: CallSettings }>('/settings')).calls); } catch (e) { this.ui.error(e); }
  }

  async set(k: keyof CallSettings, on: boolean) {
    const r = await this.ui.run(() => this.api.patch<CallSettings>('/settings/calls', { [k]: on }), 'Saved. Agents see it next time the app refreshes.');
    if (r) this.calls.set(r); else await this.load();
  }
}
