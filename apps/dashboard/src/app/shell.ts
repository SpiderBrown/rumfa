import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from './core/api';
import { Calls } from './core/calls';
import { Ui, label } from './core/ui';

interface NavItem { path: string; icon: string; text: string; roles?: string[] }

const NAV: NavItem[] = [
  { path: '/room', icon: 'support_agent', text: 'Situation room' },
  { path: '/map', icon: 'map', text: 'Situation map', roles: ['operator', 'supervisor', 'analyst', 'legal', 'security', 'admin'] },
  { path: '/callbacks', icon: 'phone_callback', text: 'Callback requests' },
  { path: '/live-count', icon: 'ballot', text: 'Live count', roles: ['operator', 'supervisor', 'analyst', 'legal', 'security', 'admin'] },
  { path: '/results', icon: 'how_to_vote', text: 'Live results', roles: ['analyst', 'supervisor', 'admin', 'legal', 'operator'] },
  { path: '/irev', icon: 'cloud_download', text: 'IReV data', roles: ['analyst', 'supervisor', 'admin'] },
  { path: '/irev/review', icon: 'fact_check', text: 'Sheet review', roles: ['analyst', 'supervisor', 'admin', 'legal'] },
  { path: '/contacts', icon: 'contact_phone', text: 'Authority contacts' },
  { path: '/people', icon: 'groups', text: 'People' },
  { path: '/shifts', icon: 'schedule', text: 'Shifts and queues', roles: ['supervisor', 'admin'] },
  { path: '/topups', icon: 'sim_card', text: 'Airtime and data', roles: ['admin'] },
  { path: '/voice', icon: 'campaign', text: 'Voice outreach', roles: ['voice_ops', 'admin'] },
  { path: '/settings', icon: 'settings', text: 'Settings', roles: ['admin'] },
];

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatSidenavModule, MatToolbarModule, MatListModule, MatIconModule,
    MatButtonModule, MatButtonToggleModule, MatTooltipModule],
  template: `
  <mat-sidenav-container class="shell">
    <mat-sidenav mode="side" opened class="nav">
      <div class="brand"><mat-icon>shield</mat-icon><span>{{ api.brand() }}</span></div>
      <mat-nav-list>
        @for (n of nav(); track n.path) {
          <a mat-list-item [routerLink]="n.path" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: n.path === '/irev' }">
            <mat-icon matListItemIcon>{{ n.icon }}</mat-icon><span matListItemTitle>{{ n.text }}</span>
          </a>
        }
      </mat-nav-list>
    </mat-sidenav>
    <mat-sidenav-content>
      <mat-toolbar class="top">
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
    .nav { width: 232px; border-right: 1px solid var(--mat-sys-outline-variant); }
    .brand { display: flex; gap: 8px; align-items: center; padding: 16px; font: var(--mat-sys-title-large); color: var(--mat-sys-primary); }
    .active { background: var(--mat-sys-secondary-container); }
    .top { position: sticky; top: 0; z-index: 2; gap: 12px; background: var(--mat-sys-surface-container); font: var(--mat-sys-body-medium); }
    .who { color: var(--mat-sys-on-surface-variant); }
    .spacer { flex: 1; }
    .oncall { display: flex; align-items: center; gap: 4px; color: var(--mat-sys-primary); }
    .oncall.ring { color: var(--mat-sys-tertiary); font-weight: 600; }
    .content { padding: 20px 24px; }
  `,
})
export class Shell {
  api = inject(Api);
  calls = inject(Calls);
  private ui = inject(Ui);
  private router = inject(Router);
  label = label;
  status = signal('offline');
  nav = computed(() => NAV.filter((n) => !n.roles || n.roles.includes(this.api.me()?.role ?? '')));

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
