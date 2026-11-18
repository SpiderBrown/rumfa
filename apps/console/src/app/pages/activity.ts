import { Component, inject, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

interface Entry { id: number; at: string; action: string; target_type: string | null; target_id: string | null; details: any; tenant_id: string | null; client: string | null; by: string | null }

/** Everything Rumfa staff did on the console, newest first. Nothing here can be changed or removed. */
@Component({
  selector: 'page-activity',
  imports: [DatePipe, JsonPipe, RouterLink],
  template: `
  <div class="page">
    <div class="page-head"><h1>Activity log</h1></div>
    <table class="grid">
      <tr><th>When</th><th>Who</th><th>What</th><th>Client</th><th>Details</th></tr>
      @for (e of rows(); track e.id) {
        <tr>
          <td class="hint">{{ e.at | date: 'd MMM y, HH:mm' }}</td>
          <td>{{ e.by ?? 'Command line' }}</td>
          <td>{{ e.action }}</td>
          <td>@if (e.tenant_id) { <a [routerLink]="['/clients', e.tenant_id]">{{ e.client }}</a> }</td>
          <td class="hint details">{{ e.details | json }}</td>
        </tr>
      }
    </table>
  </div>`,
  styles: `.details { font-family: monospace; font-size: 11px; max-width: 420px; word-break: break-all; }`,
})
export class ActivityPage {
  private api = inject(Api);
  private ui = inject(Ui);
  rows = signal<Entry[]>([]);
  constructor() { void this.api.get<Entry[]>('/platform/audit', { limit: 300 }).then((r) => this.rows.set(r)).catch((e) => this.ui.error(e)); }
}
