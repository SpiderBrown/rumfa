import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { Tasks, type FieldTask } from '../core/tasks';
import { TASK_KIND } from './tasks';

const QUICK = ['Agent not reachable', "I'm going to the PU", 'Called the agent, they are on their way', 'Spoke to the agent, all fine'];

/**
 * One task: what to do and where, progress the room sees (sent, seen, on my way, arrived, reported back), notes,
 * and a way to reach the agent it is about. Clears by itself when the right thing happens.
 */
@Component({
  selector: 'page-task',
  imports: [FormsModule, IonBackButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar><ion-buttons slot="start"><ion-back-button defaultHref="/tabs/tasks" /></ion-buttons>
    <ion-title>{{ k() ? t(kind(k()!).label) : t('Task') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    @if (k(); as k) {
      <div class="card head">
        <div class="top"><span class="pri" [class]="k.priority">{{ t(k.priority === 'urgent' ? 'Urgent' : k.priority === 'high' ? 'High' : 'Normal') }}</span>
          <small>{{ t('Sent') }} {{ time(k.created_at) }}@if (k.created_by_name) { {{ t('by') }} {{ k.created_by_name }} } @else { · {{ t('by Rumfa') }} }</small></div>
        <h2>{{ k.title }}</h2>
        @if (k.body) { <p>{{ k.body }}</p> }
        @if (k.status === 'cleared') { <p class="cleared"><ion-icon name="checkmark-circle" /> {{ k.cleared_reason }}</p> }
      </div>

      @if (k.pu_code) {
        <a class="card place" [href]="mapLink(k)" target="_blank">
          <span class="ico teal"><ion-icon name="walk" /></span>
          <span class="grow"><b>PU {{ k.pu_code.slice(-3) }} {{ k.pu_name ?? '' }}</b><small>{{ distance(k) }}</small></span>
          <ion-icon name="navigate" class="go" />
        </a>
      }
      @if (k.about; as a) {
        <div class="card who">
          <span class="av">{{ initials(a.full_name) }}</span>
          <span class="grow"><b>{{ a.full_name }}</b><small>{{ a.area_code }}</small></span>
          <button class="round" (click)="person(a.id)" [attr.aria-label]="t('Their work today')"><ion-icon name="person-circle" /></button>
          <button class="round green" (click)="call(a)" [attr.aria-label]="t('Call')"><ion-icon name="call" /></button>
        </div>
      }

      <p class="section-title">{{ t('Progress') }} · {{ t('the room sees this') }}</p>
      <div class="card flat steps">
        @for (s of steps(k); track s.label) {
          <div class="row-item" [class.done]="s.at"><ion-icon [name]="s.at ? 'checkmark-circle' : 'radio-button-off'" />
            <span class="grow">{{ t(s.label) }}</span>@if (s.at) { <small>{{ time(s.at) }}</small> }</div>
        }
      </div>

      <p class="section-title">{{ t('Notes') }}</p>
      <div class="chips">@for (q of quick; track q) { <button (click)="note(q)" [disabled]="busy()">{{ t(q) }}</button> }</div>
      <div class="add"><textarea rows="2" [(ngModel)]="draft" [placeholder]="t('Add a note for the room')"></textarea>
        <button (click)="note(draft)" [disabled]="!draft.trim() || busy()"><ion-icon name="send" /></button></div>
      <div class="notes">
        @for (n of (k.notes ?? []).slice().reverse(); track n.id) {
          <div class="n" [class.auto]="n.kind === 'auto'"><b>{{ n.author ?? 'Rumfa' }}</b> · <small>{{ time(n.at) }}</small><p>{{ n.body }}</p></div>
        }
      </div>
    } @else { <p class="hint">{{ t('Loading…') }}</p> }
  </ion-content>
  @if (k(); as k) {
    @if (k.status !== 'done' && k.status !== 'cleared') {
      <ion-footer class="ion-no-border"><div class="foot">
        <button class="ghost" (click)="cant()" [disabled]="busy()">{{ t("Can't go") }}</button>
        <button class="primary" (click)="advance(k)" [disabled]="busy()"><ion-icon [name]="nextIcon(k)" />{{ t(nextLabel(k)) }}</button>
      </div></ion-footer>
    } @else if (k.status === 'done') {
      <ion-footer class="ion-no-border"><div class="foot"><button class="ghost wide" (click)="set('open')" [disabled]="busy()">{{ t('Reopen') }}</button></div></ion-footer>
    }
  }`,
  styles: `
    .head h2 { margin: 6px 0 4px; font-size: 21px; } .head p { margin: 4px 0 0; color: var(--r-ink-2); }
    .top { display: flex; align-items: center; gap: 8px; } .top small { color: var(--r-muted); }
    .pri { font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: #eef1f4; color: var(--r-ink-2); }
    .pri.urgent { background: #fdecea; color: var(--r-urgent); } .pri.high { background: #fde7d6; color: var(--r-high); }
    .cleared { display: flex; gap: 6px; align-items: center; color: #16a34a !important; font-weight: 700; }
    .place, .who { display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--r-ink); }
    .grow { flex: 1; min-width: 0; } .grow b { display: block; } .grow small { display: block; color: var(--r-muted); font-size: 13px; }
    .go { font-size: 22px; color: var(--r-accent); }
    .round { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--r-accent-soft); color: var(--r-accent); display: grid; place-items: center; font-size: 20px; }
    .round.green { background: #16a34a; color: #fff; }
    .steps .row-item { color: var(--r-muted); } .steps ion-icon { font-size: 22px; } .steps .done { color: var(--r-ink); } .steps .done ion-icon { color: #16a34a; }
    .steps small { color: var(--r-muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chips button { border: 1px solid var(--r-line); background: #fff; border-radius: 999px; padding: 8px 12px; font: inherit; font-size: 13px; font-weight: 600; color: var(--r-ink); }
    .add { display: flex; gap: 8px; margin-top: 10px; align-items: flex-end; }
    .add textarea { flex: 1; font: inherit; font-size: 15px; padding: 10px 12px; border: 1.5px solid #d5dae1; border-radius: 14px; resize: none; background: #fff; }
    .add button { width: 46px; height: 46px; border-radius: 14px; border: 0; background: var(--r-accent); color: #fff; font-size: 20px; display: grid; place-items: center; }
    .notes { margin: 12px 0 20px; } .n { padding: 8px 0; border-bottom: 1px solid var(--r-line-soft); font-size: 14px; } .n p { margin: 2px 0 0; }
    .n small { color: var(--r-muted); } .n.auto p { color: #16a34a; }
    .foot { display: flex; gap: 10px; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: var(--r-bg, #f3f4f6); }
    .foot button { border-radius: 16px; padding: 15px; font: inherit; font-size: 16px; font-weight: 800; display: flex; align-items: center; justify-content: center; gap: 8px; }
    .ghost { flex: 0 0 34%; border: 1.5px solid #d5dae1; background: #fff; color: var(--r-ink); } .ghost.wide { flex: 1; }
    .primary { flex: 1; border: 0; background: var(--r-accent); color: #fff; }
    .hint { color: var(--r-muted); }
  `,
})
export default class TaskPage {
  id = input.required<string>();
  private api = inject(Api);
  private tasks = inject(Tasks);
  private calls = inject(Calls);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  readonly quick = QUICK;
  k = signal<FieldTask | null>(null);
  busy = signal(false);
  draft = '';
  private here = signal<{ lat: number; lng: number } | null>(null);
  private stop = this.api.onChange((c) => { if (c.id === this.id()) void this.load(this.id()); }, ['field_tasks']);

  constructor() {
    effect(() => void this.load(this.id()));
    navigator.geolocation?.getCurrentPosition((p) => this.here.set({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { timeout: 10000, maximumAge: 120000 });
  }
  ngOnDestroy() { this.stop(); }

  async load(id: string) { const k = await this.tasks.get(id).catch(async (e) => { await this.ui.error(e); return null; }); if (k) this.k.set(k); void this.tasks.load(); }

  kind(k: FieldTask) { return TASK_KIND[k.kind] ?? TASK_KIND['room']; }
  steps(k: FieldTask) {
    return [{ label: 'Sent', at: k.created_at }, { label: 'Seen', at: k.seen_at }, { label: 'On my way', at: k.on_way_at },
      { label: 'Arrived', at: k.arrived_at }, { label: k.status === 'cleared' ? 'Cleared' : 'Reported back', at: k.done_at ?? k.cleared_at }];
  }
  nextLabel(k: FieldTask) { return k.status === 'open' ? "I'm on my way" : k.status === 'on_way' ? "I've arrived" : 'Report back: done'; }
  nextIcon(k: FieldTask) { return k.status === 'open' ? 'walk' : k.status === 'on_way' ? 'location' : 'checkmark-done'; }

  async advance(k: FieldTask) {
    const next = k.status === 'open' ? 'on_way' : k.status === 'on_way' ? 'arrived' : 'done';
    let note: string | undefined;
    if (next === 'done') {
      const r = await this.ui.prompt('Report back', 'What did you find? What was done?', { ok: 'Done' });
      if (r === null || r === undefined) return;
      note = r || undefined;
    }
    await this.set(next, note);
  }
  async set(status: FieldTask['status'], note?: string) {
    this.busy.set(true);
    try { this.k.set(await this.tasks.setStatus(this.id(), status, note)); } catch (e) { await this.ui.error(e); }
    this.busy.set(false);
  }
  async cant() {
    const r = await this.ui.prompt("Can't go", 'Tell the room why (they can send someone else)', { ok: 'Send', required: true });
    if (r) await this.note(`Can't go: ${r}`);
  }
  async note(body: string) {
    const b = body.trim(); if (!b) return;
    this.busy.set(true);
    try { this.k.set(await this.tasks.addNote(this.id(), b)); this.draft = ''; } catch (e) { await this.ui.error(e); }
    this.busy.set(false);
  }

  distance(k: FieldTask) {
    const h = this.here();
    if (!h || k.pu_lat == null || k.pu_lng == null) return this.t('Tap for directions');
    const R = 6371, toR = (d: number) => (d * Math.PI) / 180;
    const dLat = toR(k.pu_lat - h.lat), dLng = toR(k.pu_lng - h.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(h.lat)) * Math.cos(toR(k.pu_lat)) * Math.sin(dLng / 2) ** 2;
    const km = 2 * R * Math.asin(Math.sqrt(a));
    const walk = Math.round((km / 5) * 60);
    return `${km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km'} · ${this.t('about')} ${walk < 60 ? walk + ' min' : Math.round(walk / 60) + ' h'} ${this.t('walk')}`;
  }
  mapLink(k: FieldTask) {
    return k.pu_lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${k.pu_lat},${k.pu_lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((k.pu_name ?? '') + ' polling unit')}`;
  }
  initials(n: string) { return n.replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase(); }
  time(iso: string) { return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }); }
  person(id: string) { void this.router.navigate(['/person', id]); }
  async call(a: NonNullable<FieldTask['about']>) {
    try {
      const r = await this.api.post<{ channelId: string }>('/channels/direct', { otherId: a.id });
      await this.calls.fromChat(r.channelId, [{ id: a.id, full_name: a.full_name, role: a.role }]);
    } catch { window.location.href = `tel:${a.phone}`; }
  }
}
