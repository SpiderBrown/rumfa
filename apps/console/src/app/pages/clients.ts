import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../core/api';
import { Ui, label } from '../core/ui';

interface ClientRow {
  id: string; name: string; brand: string; status: string; candidate_name: string | null; party: string | null; seat: string | null;
  seat_area: string | null; seat_area_name: string | null; live_election: string | null; agents: number; coordinators: number; staff: number;
  domains: string[] | null; created_at: string; addons?: { voice?: boolean; airtime?: boolean };
}

/** Every client (campaign) on Rumfa, newest first. */
@Component({
  selector: 'page-clients',
  imports: [DatePipe, DecimalPipe, RouterLink, MatButtonModule, MatIconModule],
  template: `
  <div class="page">
    <div class="page-head">
      <p class="eyebrow">{{ rows().length }} {{ rows().length === 1 ? 'client' : 'clients' }} · {{ totalPeople() | number }} people</p>
      <h1>Clients</h1>
      <span class="spacer"></span>
      @if (api.canEdit) { <a mat-flat-button routerLink="/clients/new"><mat-icon>add</mat-icon> New client</a> }
      <p class="lede">Each client has its own room, people and settings. Rumfa staff switch add-ons and limits on here.</p>
    </div>
    <table class="grid">
      <tr><th>Client</th><th>Election</th><th>People</th><th>Add-ons</th><th>Status</th><th></th></tr>
      @for (c of rows(); track c.id) {
        <tr class="link" (click)="open(c)">
          <td><div class="who"><span class="av">{{ (c.brand || c.name)[0] }}</span>
            <div><b>{{ c.brand }}</b>@if (c.party) { <span class="chip">{{ c.party }}</span> }
              <div class="hint">{{ c.name }}</div>
              <div class="hint">{{ sub(c) }}</div></div></div></td>
          <td>{{ c.live_election ?? '—' }}<div class="hint">since {{ c.created_at | date: 'd MMM y' }}</div></td>
          <td><b>{{ c.staff + c.coordinators + c.agents | number }}</b><div class="hint">{{ c.staff }} room · {{ c.coordinators }} coord. · {{ c.agents | number }} agents</div></td>
          <td>@if (c.addons?.voice) { <span class="chip accent">Voice</span> } @if (c.addons?.airtime) { <span class="chip accent">Airtime</span> }
            @if (!c.addons?.voice && !c.addons?.airtime) { <span class="hint">None</span> }</td>
          <td><span class="chip" [class.ok]="c.status === 'active'" [class.bad]="c.status === 'suspended'" [class.warn]="c.status !== 'active' && c.status !== 'suspended'">{{ c.status === 'active' ? 'Live' : label(c.status) }}</span></td>
          <td class="go"><mat-icon>chevron_right</mat-icon></td>
        </tr>
      } @empty { <tr><td colspan="6" class="hint">{{ loaded() ? 'No clients yet.' : 'Loading…' }}</td></tr> }
    </table>
  </div>`,
  styles: `.who { display: flex; align-items: center; gap: 10px; } .go { width: 24px; color: var(--r-muted); text-align: right; }`,
})
export class ClientsPage {
  api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  rows = signal<ClientRow[]>([]);
  totalPeople = computed(() => this.rows().reduce((n, c) => n + c.staff + c.coordinators + c.agents, 0));
  loaded = signal(false);
  label = label;
  private seats: Record<string, string> = {};

  constructor() { void this.load(); }
  async load() {
    try {
      const [rows, seats] = await Promise.all([this.api.get<ClientRow[]>('/platform/clients'), this.api.get<any[]>('/platform/clients/seats')]);
      this.seats = Object.fromEntries(seats.map((s) => [s.seat, s.label]));
      this.rows.set(rows);
    } catch (e) { this.ui.error(e); } finally { this.loaded.set(true); }
  }
  /** "Governor · Kano · Abba Gida": only the parts the client has */
  sub(c: ClientRow) { return [c.seat ? this.seat(c.seat) : null, c.seat_area_name, c.candidate_name].filter(Boolean).join(' · ') || '—'; }
  seat(s: string | null) { return s ? this.seats[s] ?? label(s) : '—'; }
  open(c: ClientRow) { void this.router.navigate(['/clients', c.id]); }
}
