import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Api } from './api';
import { Outbox } from './outbox';

/**
 * Counts shown on the tabs and the top bar: unread chat messages, items waiting to send, and (for coordinators)
 * callback requests waiting. Kept live: the app follows every conversation the person is in.
 */
@Injectable({ providedIn: 'root' })
export class Badges {
  private api = inject(Api);
  private outbox = inject(Outbox);
  readonly unread = signal(0);
  readonly requests = signal(0);
  /** Items saved on the phone but not yet accepted by the server */
  readonly waiting = computed(() => this.outbox.pending().length);
  private unfollow: (() => void)[] = [];
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      if (!this.api.me() || !this.api.session()) return;
      void this.refresh();
    });
    this.api.onChange(() => this.soon(), ['messages', 'callback_requests']);
    // Changes come live; poll only while the live connection is down (and a slow check otherwise)
    let n = 0;
    setInterval(() => { n++; if (!this.api.live() || n % 5 === 0) void this.refresh(); }, 60_000);
  }

  private soon() { if (!this.pending) this.pending = setTimeout(() => { this.pending = null; void this.refresh(); }, 1500); }

  async refresh() {
    if (!this.api.session()) return;
    const [area, all] = await Promise.all([
      this.api.get<{ id: string; unread?: number }[]>('/channels/area').catch(() => null),
      this.api.get<{ id: string; kind: string; unread?: number }[]>('/channels').catch(() => null),
    ]);
    if (area && all) {
      const byId = new Map([...all, ...area].map((c) => [c.id, c.unread ?? 0]));
      this.unread.set([...byId.values()].reduce((a, b) => a + b, 0));
      this.unfollow.forEach((f) => f());
      this.unfollow = [...byId.keys()].map((id) => this.api.follow({ channel: id }));
    }
    if (this.api.isCoordinator()) {
      const r = await this.api.get<unknown[]>('/callbacks', { mine: true, status: 'waiting,no_answer' }).catch(() => null);
      if (r) this.requests.set(r.length);
    }
  }
}
