import { Injectable, computed, inject, signal } from '@angular/core';
import { Api } from './api';

export interface FieldTask {
  id: string; kind: 'room' | 'not_checked_in' | 'team_report'; title: string; body: string | null; priority: 'urgent' | 'high' | 'normal';
  status: 'open' | 'on_way' | 'arrived' | 'done' | 'cleared'; pu_code: string | null; pu_name: string | null; pu_lat: number | null; pu_lng: number | null;
  case_id: string | null; case_status: string | null; created_at: string; seen_at: string | null; on_way_at: string | null; arrived_at: string | null;
  done_at: string | null; cleared_at: string | null; cleared_reason: string | null; created_by_name: string | null; last_note: string | null;
  about: { id: string; full_name: string; phone: string; role: string; area_code: string } | null;
  notes?: { id: number; kind: string; body: string; at: string; author: string | null }[];
}

/** My tasks (mostly coordinators; the room can also task an agent) (from the room, or made from what the team reports), kept live. */
@Injectable({ providedIn: 'root' })
export class Tasks {
  private api = inject(Api);
  readonly list = signal<FieldTask[]>([]);
  readonly open = computed(() => this.list().filter((t) => t.status !== 'done' && t.status !== 'cleared'));
  readonly unseen = computed(() => this.open().filter((t) => !t.seen_at).length);
  private started = false;

  start() {
    if (this.started || !this.api.me()) return;
    this.started = true;
    void this.load();
    this.api.onChange(() => void this.load(), ['field_tasks', 'cases', 'checkins']);
    let n = 0;
    setInterval(() => { n++; if (!this.api.live() || n % 5 === 0) void this.load(); }, 60_000);
  }
  async load() {
    if (!this.api.me()) return;
    const l = await this.api.get<FieldTask[]>('/tasks/mine', { all: 1 }).catch(() => null);
    if (l) this.list.set(l);
  }
  get(id: string) { return this.api.get<FieldTask>(`/tasks/${id}`); }
  async setStatus(id: string, status: FieldTask['status'], note?: string) {
    const t = await this.api.post<FieldTask>(`/tasks/${id}/status`, { status, note }); void this.load(); return t;
  }
  async addNote(id: string, body: string) { const t = await this.api.post<FieldTask>(`/tasks/${id}/notes`, { body }); void this.load(); return t; }
}
