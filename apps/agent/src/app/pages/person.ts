import { Component, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonRefresher, IonRefresherContent, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from '../core/api';
import { Calls } from '../core/calls';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { AgoPipe } from '../core/clock';

interface Work {
  person: { id: string; full_name: string; phone: string; role: string; level: string; area_code: string; unit_name: string | null; ward_name: string | null; last_seen: string | null };
  day: null | {
    checked_in_at: string | null; answers: number; last_accreditation: string | null; accredited: number | null; reports: number;
    live_count: { total: number; status: string; finished_at: string | null } | null;
    result: { at: string; status: string; total_valid: number } | null;
    irev: { status: string; at: string } | null;
  };
  timeline: { at: string; kind: string; text: string; detail: string | null }[];
}
interface Task { id: string; title: string; status: string; kind: string; created_at: string; cleared_reason: string | null }

const KIND_ICON: Record<string, [string, string]> = {
  checkin: ['location', 'teal'], checklist: ['clipboard', 'blue'], figures: ['stats-chart', 'blue'], count: ['speedometer', 'teal'],
  result: ['document-text', 'teal'], irev: ['cloud-done', 'blue'], report: ['warning', 'orange'], sos: ['alert-circle', 'red'], callback: ['call', 'grey'],
};

/** One person's work so far today (for their coordinator): where they are in the day, and what they did and reported. */
@Component({
  selector: 'page-person',
  imports: [IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonRefresher, IonRefresherContent, IonTitle, IonToolbar, AgoPipe],
  template: `
  <ion-header><ion-toolbar><ion-buttons slot="start"><ion-back-button defaultHref="/tabs/chats" /></ion-buttons>
    <ion-title>{{ t('Their work today') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    <ion-refresher slot="fixed" (ionRefresh)="refresh($event)"><ion-refresher-content /></ion-refresher>
    @if (w(); as w) {
      <div class="card who">
        <span class="av big">{{ initials(w.person.full_name) }}</span>
        <div class="grow"><b>{{ w.person.full_name }}</b>
          <small>{{ roleName(w.person) }} · {{ w.person.unit_name ?? w.person.ward_name ?? '' }} {{ w.person.area_code }}</small>
          <small>@if (w.person.last_seen) { {{ t('Last seen') }} {{ w.person.last_seen | ago }} } @else { {{ t('Not seen in the app yet') }} }</small></div>
      </div>
      <div class="acts">
        <button (click)="message(w.person.id)"><ion-icon name="chatbubble" />{{ t('Message') }}</button>
        <button class="call" (click)="call(w.person)"><ion-icon name="call" />{{ t('Call') }}</button>
        <a class="btn" [href]="'tel:' + w.person.phone"><ion-icon name="phone-portrait" />{{ t('Phone') }}</a>
      </div>

      @if (w.day; as d) {
        <p class="section-title">{{ t('Progress') }}</p>
        <div class="stages">
          @for (s of stages(d); track s.label) {
            <div class="stage" [class.done]="s.done"><span class="dot">@if (s.done) { <ion-icon name="checkmark" /> }</span>
              <b>{{ t(s.label) }}</b><small>{{ s.text }}</small></div>
          }
        </div>
        <div class="kpis">
          <div><b>{{ d.accredited ?? '—' }}</b><small>{{ t('accredited') }}</small></div>
          <div><b>{{ d.live_count?.total ?? '—' }}</b><small>{{ t('ballots counted') }}</small></div>
          <div [class.bad]="d.reports > 0"><b>{{ d.reports }}</b><small>{{ t('reports') }}</small></div>
        </div>
      } @else { <p class="hint">{{ t('No election is live yet.') }}</p> }

      @if (tasks().length) {
        <p class="section-title">{{ t('Tasks about them') }}</p>
        <div class="card flat">
          @for (k of tasks(); track k.id) {
            <button class="row-item task" (click)="openTask(k.id)">
              <span class="grow"><b>{{ k.title }}</b><small>{{ taskStatus(k) }}</small></span><ion-icon name="chevron-forward" /></button>
          }
        </div>
      }

      <p class="section-title">{{ t('Timeline') }}</p>
      <div class="card flat">
        @for (e of w.timeline; track $index) {
          <div class="row-item">
            <span class="ico sm" [class]="tone(e.kind)"><ion-icon [name]="icon(e.kind)" /></span>
            <span class="grow"><b>{{ t(e.text) }}</b>@if (e.detail) { <small>{{ e.detail }}</small> }</span>
            <small class="when">{{ time(e.at) }}</small>
          </div>
        } @empty { <div class="row-item"><span class="hint">{{ t('Nothing yet today.') }}</span></div> }
      </div>
    } @else { <p class="hint">{{ t('Loading…') }}</p> }
  </ion-content>`,
  styles: `
    .who { display: flex; align-items: center; gap: 14px; } .av.big { width: 58px; height: 58px; font-size: 20px; }
    .grow { flex: 1; min-width: 0; } .grow b { display: block; } .grow small { display: block; color: var(--r-muted); font-size: 13px; }
    .acts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 4px; }
    .acts button, .acts .btn { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border: 0; border-radius: 14px;
      background: var(--r-accent-soft); color: var(--r-accent); font: inherit; font-size: 13px; font-weight: 700; text-decoration: none; }
    .acts ion-icon { font-size: 22px; } .acts .call { background: #16a34a; color: #fff; }
    .stages { display: grid; gap: 0; background: #fff; border: 1px solid var(--r-line); border-radius: 18px; padding: 6px 14px; }
    .stage { display: grid; grid-template-columns: 28px 1fr auto; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--r-line-soft); }
    .stage:last-child { border-bottom: 0; } .stage small { color: var(--r-muted); font-size: 13px; }
    .dot { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #cbd5e1; display: grid; place-items: center; }
    .stage.done .dot { background: #16a34a; border-color: #16a34a; color: #fff; }
    .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
    .kpis div { background: #fff; border: 1px solid var(--r-line); border-radius: 16px; padding: 10px; text-align: center; }
    .kpis b { display: block; font-size: 22px; } .kpis small { color: var(--r-muted); font-size: 12px; } .kpis .bad b { color: var(--r-high); }
    .ico.sm { width: 34px; height: 34px; border-radius: 10px; } .ico.sm ion-icon { font-size: 18px; }
    .when { color: var(--r-muted); font-size: 12px; white-space: nowrap; }
    .task { width: 100%; background: #fff; border-left: 0; border-right: 0; border-top: 0; font: inherit; text-align: left; color: var(--r-ink); }
    .hint { color: var(--r-muted); }
  `,
})
export default class PersonPage {
  id = input.required<string>();
  private api = inject(Api);
  private calls = inject(Calls);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  w = signal<Work | null>(null);
  tasks = signal<Task[]>([]);

  constructor() { effect(() => void this.load(this.id())); }

  async load(id: string) {
    const [w, t] = await Promise.all([
      this.api.get<Work>(`/team/person/${id}`).catch(async (e) => { await this.ui.error(e); return null; }),
      this.api.get<Task[]>(`/tasks/about/${id}`).catch(() => []),
    ]);
    if (w) this.w.set(w);
    this.tasks.set(t ?? []);
  }
  async refresh(ev: CustomEvent) { await this.load(this.id()); (ev.target as any).complete(); }

  stages(d: NonNullable<Work['day']>) {
    return [
      { label: 'Checked in', done: !!d.checked_in_at, text: d.checked_in_at ? this.time(d.checked_in_at) : this.t('not yet') },
      { label: 'Checklist', done: d.answers > 0, text: d.answers ? `${d.answers} ${this.t('answers')}` : this.t('not yet') },
      { label: 'Accreditation', done: !!d.last_accreditation, text: d.last_accreditation ? `${d.accredited} · ${this.time(d.last_accreditation)}` : this.t('no figure yet') },
      { label: 'Live count', done: d.live_count?.status === 'done', text: d.live_count ? `${d.live_count.total} ${this.t('ballots')}` : this.t('not started') },
      { label: 'Result sent', done: !!d.result, text: d.result ? `${d.result.total_valid} ${this.t('valid')} · ${this.time(d.result.at)}` : this.t('not yet') },
      { label: 'IReV check', done: !!d.irev && d.irev.status !== 'asked', text: d.irev ? this.t(d.irev.status === 'matches' ? 'matches' : d.irev.status === 'differs' ? 'different' : 'waiting for them') : this.t('not yet') },
    ];
  }
  icon(k: string) { return KIND_ICON[k]?.[0] ?? 'ellipse-outline'; }
  tone(k: string) { return 'ico sm ' + (KIND_ICON[k]?.[1] ?? 'grey'); }
  initials(n: string) { return n.replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase(); }
  roleName(p: Work['person']) {
    if (p.role === 'coordinator') return this.t(({ ward: 'Ward coordinator', lga: 'LGA coordinator', state: 'State coordinator' } as Record<string, string>)[p.level] ?? 'Coordinator');
    return this.t(p.role === 'agent' ? 'Polling unit agent' : p.role);
  }
  taskStatus(k: Task) {
    if (k.status === 'cleared') return k.cleared_reason ?? this.t('Cleared');
    return this.t(({ open: 'Open', on_way: 'On my way', arrived: 'Arrived', done: 'Done' } as Record<string, string>)[k.status] ?? k.status);
  }
  /** Time today; with the day for anything earlier */
  time(iso: string) {
    const d = new Date(iso), t = d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${t}`;
  }

  async message(id: string) {
    try { const r = await this.api.post<{ channelId: string }>('/channels/direct', { otherId: id }); await this.router.navigate(['/chat', r.channelId]); }
    catch (e) { await this.ui.error(e); }
  }
  async call(p: Work['person']) {
    try {
      const r = await this.api.post<{ channelId: string }>('/channels/direct', { otherId: p.id });
      await this.calls.fromChat(r.channelId, [{ id: p.id, full_name: p.full_name, role: p.role }]);
    } catch { window.location.href = `tel:${p.phone}`; }
  }
  openTask(id: string) { void this.router.navigate(['/task', id]); }
}
