import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon, IonRefresher, IonRefresherContent } from '@ionic/angular';
import { AppBar } from '../core/app-bar';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { AgoPipe } from '../core/clock';
import { Tasks, type FieldTask } from '../core/tasks';

export const TASK_KIND: Record<string, { label: string; icon: string; tone: string }> = {
  room: { label: 'From the room', icon: 'headset', tone: 'blue' },
  not_checked_in: { label: 'Not checked in', icon: 'person-remove', tone: 'orange' },
  team_report: { label: 'Reported by the team', icon: 'warning', tone: 'red' },
};
export const TASK_STATUS: Record<string, string> = { open: 'Open', on_way: 'On my way', arrived: 'Arrived', done: 'Done', cleared: 'Cleared' };

/** A coordinator's tasks: from the room, and the ones Rumfa made from what the team reports. Open first. */
@Component({
  selector: 'page-tasks',
  imports: [AppBar, AgoPipe, IonContent, IonIcon, IonRefresher, IonRefresherContent],
  template: `
  <app-bar [title]="t('Tasks')" [sos]="false" />
  <ion-content class="ion-padding">
    <ion-refresher slot="fixed" (ionRefresh)="refresh($event)"><ion-refresher-content /></ion-refresher>
    <div class="seg">
      <button [class.on]="tab() === 'open'" (click)="tab.set('open')">{{ t('Open') }} · {{ tasks.open().length }}</button>
      <button [class.on]="tab() === 'finished'" (click)="tab.set('finished')">{{ t('Finished') }}</button>
    </div>
    @for (k of shown(); track k.id) {
      <button class="card task" [class.unseen]="!k.seen_at && tab() === 'open'" (click)="open(k)">
        <span class="ico" [class]="'ico ' + kind(k).tone"><ion-icon [name]="kind(k).icon" /></span>
        <span class="body">
          <span class="top"><span class="pri" [class]="k.priority">{{ t(k.priority === 'urgent' ? 'Urgent' : k.priority === 'high' ? 'High' : 'Normal') }}</span>
            <small>{{ t(kind(k).label) }} · {{ k.created_at | ago }}</small></span>
          <b>{{ k.title }}</b>
          @if (k.status === 'cleared') { <small class="ok"><ion-icon name="checkmark-circle" /> {{ k.cleared_reason }}</small> }
          @else if (k.last_note) { <small>{{ k.last_note }}</small> }
          @else if (k.body) { <small>{{ k.body }}</small> }
        </span>
        <span class="st" [class]="k.status">{{ t(status(k)) }}</span>
      </button>
    } @empty {
      <div class="empty"><ion-icon name="checkmark-done" /><b>{{ tab() === 'open' ? t('Nothing to do right now') : t('Nothing finished yet') }}</b>
        <p>{{ t('Tasks come from the situation room, and from your team: an agent not checked in when voting starts, or a problem they report.') }}</p></div>
    }
  </ion-content>`,
  styles: `
    .seg { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; background: #e5e7eb; border-radius: 14px; padding: 4px; margin-bottom: 12px; }
    .seg button { border: 0; border-radius: 11px; padding: 9px; background: none; font: inherit; font-weight: 700; color: var(--r-muted); }
    .seg button.on { background: #fff; color: var(--r-ink); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .task { width: 100%; display: flex; gap: 12px; align-items: flex-start; text-align: left; font: inherit; color: var(--r-ink); }
    .task.unseen { border-color: var(--r-accent); box-shadow: 0 0 0 1px var(--r-accent) inset; }
    .body { flex: 1; min-width: 0; } .body b { display: block; margin: 3px 0 2px; font-size: 16px; }
    .body small { display: block; color: var(--r-muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .body small.ok { color: #16a34a; white-space: normal; display: flex; gap: 4px; align-items: center; }
    .top { display: flex; align-items: center; gap: 6px; } .top small { display: inline; }
    .pri { font-size: 11px; font-weight: 800; padding: 1px 7px; border-radius: 999px; background: #eef1f4; color: var(--r-ink-2); }
    .pri.urgent { background: #fdecea; color: var(--r-urgent); } .pri.high { background: #fde7d6; color: var(--r-high); }
    .st { font-size: 12px; font-weight: 800; white-space: nowrap; color: var(--r-muted); }
    .st.on_way, .st.arrived { color: var(--r-blue); } .st.done, .st.cleared { color: #16a34a; } .st.open { color: var(--r-accent); }
    .empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 48px 24px; color: var(--r-muted); }
    .empty ion-icon { font-size: 46px; color: var(--r-accent); } .empty b { color: var(--r-ink); font-size: 17px; }
  `,
})
export default class TasksPage {
  api = inject(Api);
  tasks = inject(Tasks);
  private router = inject(Router);
  t = inject(I18n).t;
  tab = signal<'open' | 'finished'>('open');
  shown = computed(() => this.tab() === 'open' ? this.tasks.open() : this.tasks.list().filter((k) => k.status === 'done' || k.status === 'cleared'));

  constructor() { this.tasks.start(); void this.tasks.load(); }
  kind(k: FieldTask) { return TASK_KIND[k.kind] ?? TASK_KIND['room']; }
  status(k: FieldTask) { return TASK_STATUS[k.status] ?? k.status; }
  open(k: FieldTask) { void this.router.navigate(['/task', k.id]); }
  async refresh(ev: CustomEvent) { await this.tasks.load(); (ev.target as any).complete(); }
}
