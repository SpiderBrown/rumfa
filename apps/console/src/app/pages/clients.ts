import { Component, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
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
  imports: [DatePipe, RouterLink, MatButtonModule, MatIconModule],
  template: `
  <div class="page">
    <div class="page-head">
      <h1>Clients</h1>
      <span class="spacer"></span>
      @if (api.canEdit) { <a mat-flat-button routerLink="/clients/new"><mat-icon>add</mat-icon> Onboard a client</a> }
    </div>
    <table class="grid">
      <tr><th>Client</th><th>Candidate</th><th>Seat</th><th>Live election</th><th>People</th><th>Status</th><th>Since</th></tr>
      @for (c of rows(); track c.id) {
        <tr class="link" (click)="open(c)">
          <td><b>{{ c.brand }}</b><div class="hint">{{ c.name }}</div></td>
          <td>{{ c.candidate_name ?? '—' }} @if (c.party) { <span class="chip">{{ c.party }}</span> }</td>
          <td>{{ seat(c.seat) }}<div class="hint">{{ c.seat_area_name }}</div></td>
          <td>{{ c.live_election ?? '—' }}</td>
          <td class="hint">{{ c.staff }} room · {{ c.coordinators }} coordinators · {{ c.agents }} agents
            @if (c.addons; as a) { @if (a.voice || a.airtime) { <div>@if (a.voice) { <span class="chip">Voice</span> } @if (a.airtime) { <span class="chip">Airtime</span> }</div> } }</td>
          <td><span class="chip" [class.ok]="c.status === 'active'" [class.bad]="c.status !== 'active'">{{ label(c.status) }}</span></td>
          <td class="hint">{{ c.created_at | date: 'd MMM y' }}</td>
        </tr>
      } @empty { <tr><td colspan="7" class="hint">{{ loaded() ? 'No clients yet.' : 'Loading…' }}</td></tr> }
    </table>
  </div>`,
})
export class ClientsPage {
  api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  rows = signal<ClientRow[]>([]);
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
  seat(s: string | null) { return s ? this.seats[s] ?? label(s) : '—'; }
  open(c: ClientRow) { void this.router.navigate(['/clients', c.id]); }
}
