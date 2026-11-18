import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from './core/api';
import { label } from './core/ui';

/** Console frame: menu on the left, the signed-in staff member and sign-out at the top. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
  <div class="frame">
    <nav>
      <div class="brand"><mat-icon>admin_panel_settings</mat-icon> Rumfa Console</div>
      @for (l of links; track l.path) {
        <a [routerLink]="l.path" routerLinkActive="on"><mat-icon>{{ l.icon }}</mat-icon>{{ l.label }}</a>
      }
    </nav>
    <div class="main">
      <header>
        <span class="spacer"></span>
        <span class="who">{{ api.me()?.full_name }} · {{ role() }}</span>
        <button mat-icon-button matTooltip="Sign out" (click)="signOut()"><mat-icon>logout</mat-icon></button>
      </header>
      <main><router-outlet /></main>
    </div>
  </div>`,
  styles: `
    .frame { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
    nav { background: #0f1b2d; color: #dbe4f0; padding: 12px 8px; display: flex; flex-direction: column; gap: 2px; }
    .brand { display: flex; align-items: center; gap: 8px; font: var(--mat-sys-title-medium); padding: 8px 12px 16px; color: #fff; }
    nav a { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; color: inherit; text-decoration: none; }
    nav a:hover { background: rgba(255,255,255,.08); } nav a.on { background: rgba(255,255,255,.16); color: #fff; }
    .main { display: flex; flex-direction: column; min-width: 0; }
    header { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--mat-sys-outline-variant); }
    .who { color: var(--mat-sys-on-surface-variant); }
    main { padding: 20px 24px; }
    @media (max-width: 800px) { .frame { grid-template-columns: 1fr; } nav { flex-direction: row; overflow-x: auto; } .brand { display: none; } }
  `,
})
export class Shell {
  api = inject(Api);
  private router = inject(Router);
  readonly links = [
    { path: '/clients', icon: 'groups', label: 'Clients' },
    { path: '/parties', icon: 'flag', label: 'Parties' },
    { path: '/elections', icon: 'how_to_vote', label: 'Elections' },
    { path: '/places', icon: 'map', label: 'Places' },
    { path: '/contacts', icon: 'contact_phone', label: 'Authority contacts' },
    { path: '/staff', icon: 'badge', label: 'Rumfa staff' },
    { path: '/activity', icon: 'history', label: 'Activity log' },
  ];
  role() { return label(this.api.me()?.role); }
  async signOut() { await this.api.signOut(); await this.router.navigateByUrl('/login'); }
}
