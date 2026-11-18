import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from './core/api';
import { Calls } from './core/calls';
import { Ui, label } from './core/ui';

interface NavItem { path: string; icon: string; text: string; roles?: string[]; addon?: 'voice' | 'airtime'; exact?: boolean }
interface NavGroup { title: string; items: NavItem[] }

const WATCH = ['operator', 'supervisor', 'analyst', 'legal', 'security', 'admin'];
/** The menu in four groups, by what people come to do. Items a role cannot use are left out (and empty groups). */
const NAV: NavGroup[] = [
  { title: 'Operate', items: [
    { path: '/room', icon: 'support_agent', text: 'Situation room' },
    { path: '/callbacks', icon: 'phone_callback', text: 'Callback requests' },
    { path: '/contacts', icon: 'contact_phone', text: 'Authority contacts' },
  ] },
  // One page for the day; its detailed views (check-ins, figures, live count, results, full map) open from it
  { title: 'Election day', items: [
    { path: '/election-day', icon: 'how_to_vote', text: 'Election day', roles: WATCH },
  ] },
  { title: 'Results data', items: [
    { path: '/irev', icon: 'cloud_download', text: 'IReV data', roles: ['analyst', 'supervisor', 'admin'], exact: true },
    { path: '/irev/review', icon: 'fact_check', text: 'Sheet review', roles: ['analyst', 'supervisor', 'admin', 'legal'] },
  ] },
  { title: 'Organisation', items: [
    { path: '/people', icon: 'groups', text: 'People' },
    { path: '/shifts', icon: 'schedule', text: 'Shifts and queues', roles: ['supervisor', 'admin'] },
    { path: '/topups', icon: 'sim_card', text: 'Airtime and data', roles: ['admin'], addon: 'airtime' },
    { path: '/voice', icon: 'campaign', text: 'Voice outreach', roles: ['voice_ops', 'admin'], addon: 'voice' },
    { path: '/settings', icon: 'settings', text: 'Settings', roles: ['admin'] },
  ] },
];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatSidenavModule, MatToolbarModule, MatIconModule,
    MatButtonModule, MatButtonToggleModule, MatTooltipModule],
  template: `
  <mat-sidenav-container class="shell">
    <mat-sidenav mode="side" opened class="nav">
      <nav aria-label="Main">
        <div class="brand"><span class="mark" aria-hidden="true">{{ initial() }}</span>
          <span class="bname"><b>{{ api.brand() }}</b><small>Rumfa Room</small></span></div>
        @for (g of nav(); track g.title) {
          <div class="group">
            <div class="gtitle">{{ g.title }}</div>
            @for (n of g.items; track n.path) {
              <a class="item" [routerLink]="n.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: !!n.exact }" ariaCurrentWhenActive="page">
                <mat-icon aria-hidden="true">{{ n.icon }}</mat-icon><span>{{ n.text }}</span>
              </a>
            }
          </div>
        }
      </nav>
    </mat-sidenav>
    <mat-sidenav-content>
      <mat-toolbar class="top">
        @if (api.isSupport()) { <span class="support" title="Signed in from Rumfa Console to help this client. Sign out to open another client.">Rumfa support access</span> }
        <span class="who">{{ api.me()?.full_name }} · {{ label(api.me()?.role) }} · {{ api.me()?.area_code }}</span>
        <span class="spacer"></span>
        @if (calls.active(); as c) {
          @switch (c.phase) {
            @case ('incoming') {
              <span class="oncall ring"><mat-icon>ring_volume</mat-icon> App call from {{ c.label }}</span>
              <button mat-flat-button (click)="calls.answer()">Answer</button>
              <button mat-stroked-button (click)="calls.hangup()">Decline</button>
            }
            @case ('calling') {
              <span class="oncall"><mat-icon>call</mat-icon> Calling {{ c.label }} in the app…</span>
              <button mat-stroked-button (click)="calls.hangup()">Cancel</button>
            }
            @default {
              <span class="oncall"><mat-icon>call</mat-icon> On call with {{ c.label }}
                ({{ c.via === 'browser' ? 'headset' : c.via === 'app' ? 'app call' : 'your phone' }})</span>
              @if (c.via === 'app') { <button mat-stroked-button (click)="calls.toggleMute()">{{ c.muted ? 'Unmute' : 'Mute' }}</button> }
              <button mat-stroked-button (click)="calls.hangup()">Hang up</button>
            }
          }
        }
        @if (api.isRoom()) {
          <mat-button-toggle-group [value]="status()" (change)="setStatus($event.value)" hideSingleSelectionIndicator>
            <mat-button-toggle value="available">Available</mat-button-toggle>
            <mat-button-toggle value="away">Away</mat-button-toggle>
            <mat-button-toggle value="offline">Offline</mat-button-toggle>
          </mat-button-toggle-group>
        }
        <button mat-icon-button matTooltip="Sign out" (click)="signOut()"><mat-icon>logout</mat-icon></button>
      </mat-toolbar>
      <main class="content"><router-outlet /></main>
    </mat-sidenav-content>
  </mat-sidenav-container>`,
  styles: `
    .shell { height: 100vh; }
    .nav { width: 240px; border: 0; background: var(--r-nav); color: #fff; }
    .nav nav { display: flex; flex-direction: column; gap: 18px; padding: 18px 12px 24px; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 0 6px 4px; }
    .mark { width: 32px; height: 32px; border-radius: 9px; background: var(--r-accent); display: grid; place-items: center; font-weight: 800; font-size: 15px; }
    .bname { display: flex; flex-direction: column; line-height: 1.2; } .bname b { font-size: 15px; } .bname small { font-size: 12px; color: #9aa6b6; }
    .group { display: flex; flex-direction: column; gap: 1px; }
    .gtitle { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #8693a4; padding: 0 12px 6px; }
    .item { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-radius: 8px; color: #c9d1dc; text-decoration: none; font-size: 14px; }
    .item mat-icon { font-size: 19px; width: 19px; height: 19px; color: #8693a4; }
    .item:hover { background: #1e2836; color: #fff; } .item:hover mat-icon { color: #c9d1dc; }
    .item:focus-visible { outline: 2px solid #5eead4; outline-offset: 1px; }
    .item.active { background: var(--r-accent); color: #fff; font-weight: 600; } .item.active mat-icon { color: #fff; }
    .support { background: #fff1e0; border: 1px solid #fb923c; color: #7a3d00; border-radius: 12px; padding: 2px 10px; font-size: 12px; margin-right: 8px; }
    .top { position: sticky; top: 0; z-index: 2; gap: 12px; height: 56px; background: #fff; border-bottom: 1px solid var(--r-line); font: var(--mat-sys-body-medium); }
    .who { color: var(--mat-sys-on-surface-variant); }
    .spacer { flex: 1; }
    .oncall { display: flex; align-items: center; gap: 4px; color: var(--mat-sys-primary); }
    .oncall.ring { color: var(--mat-sys-tertiary); font-weight: 600; }
    .content { padding: 20px 24px 32px; background: var(--r-ground); min-height: calc(100vh - 56px); box-sizing: border-box; }
  `,
})
export class Shell {
  api = inject(Api);
  calls = inject(Calls);
  private ui = inject(Ui);
  private router = inject(Router);
  label = label;
  status = signal('offline');
  // Premium add-ons (voice, airtime) show only when Rumfa has switched them on for the organisation
  nav = computed(() => {
    const role = this.api.me()?.role ?? '', addons = this.api.addons();
    return NAV.map((g) => ({ ...g, items: g.items.filter((n) => (!n.roles || n.roles.includes(role)) && (!n.addon || addons[n.addon])) }))
      .filter((g) => g.items.length);
  });
  initial = computed(() => (this.api.brand() || 'R').trim().charAt(0).toUpperCase());

  private stopCalls: () => void;

  constructor() {
    const s = this.api.staffStatus();
    if (s) this.status.set(s);
    // App calls ringing for me, answered or ended
    this.stopCalls = this.api.onChange((c) => this.calls.onCallChange(c), ['calls']);
    void this.calls.checkIncoming();
    inject(DestroyRef).onDestroy(() => this.stopCalls());
  }

  async setStatus(s: string) {
    await this.ui.run(() => this.api.put('/me/status', { status: s }));
    this.status.set(s);
  }

  async signOut() {
    await this.api.signOut();
    await this.router.navigateByUrl('/login');
  }
}
