import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from './core/api';
import { label } from './core/ui';

interface Link { path: string; icon: string; label: string }

/** Console frame: the menu in groups on the left (with who is signed in), and a slim bar on top. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
  <div class="frame">
    <nav aria-label="Console">
      <div class="brand"><span class="mark">R</span><span><b>Rumfa Console</b><small>Platform staff</small></span></div>
      @for (g of groups; track g.title) {
        <p class="group">{{ g.title }}</p>
        @for (l of g.links; track l.path) {
          <a [routerLink]="l.path" routerLinkActive="on"><mat-icon>{{ l.icon }}</mat-icon>{{ l.label }}</a>
        }
      }
      <span class="grow"></span>
      <div class="me">
        <span class="initials">{{ initials() }}</span>
        <span class="who"><b>{{ api.me()?.full_name }}</b><small>{{ role() }}</small></span>
        <button mat-icon-button matTooltip="Sign out" (click)="signOut()" aria-label="Sign out"><mat-icon>logout</mat-icon></button>
      </div>
    </nav>
    <div class="main">
      <header>
        <span class="spacer"></span>
        <span class="env" [class.prod]="env() === 'Production'">{{ env() }}</span>
      </header>
      <main><router-outlet /></main>
    </div>
  </div>`,
  styles: `
    .frame { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
    nav { background: var(--r-nav); color: #c9d3df; padding: 14px 12px; display: flex; flex-direction: column; gap: 2px; position: sticky; top: 0; height: 100vh; box-sizing: border-box; overflow-y: auto; }
    .brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 14px; color: #fff; }
    .brand b { display: block; font-size: 15px; } .brand small { display: block; font-size: 12px; color: #93a1b3; }
    .mark { width: 32px; height: 32px; border-radius: 8px; background: #2a3646; display: grid; place-items: center; font-weight: 800; }
    .group { margin: 14px 12px 4px; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #7d8a9b; }
    nav a { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 10px; color: inherit; text-decoration: none; font-size: 14px; font-weight: 500; }
    nav a mat-icon { font-size: 20px; width: 20px; height: 20px; color: #93a1b3; }
    nav a:hover { background: rgba(255,255,255,.06); color: #fff; }
    nav a.on { background: var(--r-accent); color: #fff; font-weight: 700; } nav a.on mat-icon { color: #fff; }
    .grow { flex: 1; }
    .me { display: flex; align-items: center; gap: 10px; padding: 12px 6px 2px; border-top: 1px solid #243041; margin-top: 10px; }
    .initials { width: 32px; height: 32px; border-radius: 50%; background: #2a3646; color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 800; flex: none; }
    .who { flex: 1; min-width: 0; } .who b { display: block; color: #fff; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .who small { color: #93a1b3; font-size: 12px; }
    .me button { color: #93a1b3; }
    .main { display: flex; flex-direction: column; min-width: 0; }
    header { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 24px; background: #fff; border-bottom: 1px solid var(--r-line); position: sticky; top: 0; z-index: 2; }
    .env { font-size: 12px; font-weight: 700; border: 1px solid var(--r-line); border-radius: 999px; padding: 3px 10px; color: var(--r-ink-2); }
    .env.prod { border-color: #b9dfc6; color: #146c3a; background: #e3f4ea; }
    main { padding: 24px 28px 40px; }
    @media (max-width: 900px) {
      .frame { grid-template-columns: 1fr; }
      nav { flex-direction: row; flex-wrap: nowrap; overflow-x: auto; height: auto; position: static; }
      .brand, .group, .grow { display: none; } .me { border: 0; margin: 0; padding: 0; } .who { display: none; }
    }
  `,
})
export class Shell {
  api = inject(Api);
  private router = inject(Router);
  readonly groups: { title: string; links: Link[] }[] = [
    { title: 'Clients', links: [{ path: '/clients', icon: 'domain', label: 'Clients' }] },
    { title: 'Reference data', links: [
      { path: '/places', icon: 'map', label: 'Places' },
      { path: '/parties', icon: 'flag', label: 'Parties' },
      { path: '/elections', icon: 'how_to_vote', label: 'Elections' },
      { path: '/contacts', icon: 'contact_phone', label: 'Authority contacts' },
    ] },
    { title: 'Results data', links: [
      { path: '/irev', icon: 'cloud_download', label: 'IReV' },
      { path: '/jobs', icon: 'pending_actions', label: 'Background jobs' },
    ] },
    { title: 'Platform', links: [
      { path: '/staff', icon: 'badge', label: 'Staff' },
      { path: '/activity', icon: 'history', label: 'Activity' },
    ] },
  ];
  role() { return label(this.api.me()?.role); }
  initials() { return (this.api.me()?.full_name ?? '').replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  /** Where this Console is pointed: production, or a development / test API */
  env() { return /localhost|127\.0\.0\.1|\.test\b|staging|dev/i.test(String(window.RUMFA_CONSOLE?.apiUrl ?? location.host)) ? 'Development' : 'Production'; }
  async signOut() { await this.api.signOut(); await this.router.navigateByUrl('/login'); }
}
