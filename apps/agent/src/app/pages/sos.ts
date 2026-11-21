import { Component, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular';
import { INCIDENT_CATEGORIES } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { takePhoto } from '../core/photo';
import { categoryIcon } from '../core/categories';

/** How long "Sent by mistake? Cancel" stays on screen */
const UNDO_S = 30;

/**
 * After holding SOS: the emergency has already gone (or is waiting for signal). Nothing here is needed; it only
 * adds to the alert: what is happening, a note, a photo. It deliberately looks nothing like the report form.
 */
@Component({
  selector: 'page-sos',
  imports: [FormsModule, RouterLink, IonContent, IonIcon],
  template: `
  <ion-content>
    @if (cancelled()) {
      <div class="hero calm">
        <span class="ring"><ion-icon name="checkmark-circle" /></span>
        <h1>{{ t('SOS cancelled') }}</h1>
        <p>{{ cancelledText() }}</p>
      </div>
      <div class="pad"><button class="big" (click)="done()">{{ t('Done') }}</button></div>
    } @else {
      <div class="hero">
        <span class="ring"><span>SOS</span></span>
        @if (sent()) {
          <h1>{{ t('Help is on the way') }}</h1>
          <p>{{ t('The situation room and your coordinator are alerted with your location. Keep your phone with you.') }}</p>
        } @else {
          <h1>{{ t('Emergency saved') }}</h1>
          <p>{{ t('No signal yet: it goes the moment there is. Send it by SMS now if you can.') }}</p>
        }
      </div>

      <!-- What has happened to the alert so far -->
      <div class="card flat status">
        <div class="row-item" [class.ok]="sent()">
          <ion-icon [name]="sent() ? 'checkmark-circle' : 'time-outline'" />
          <span>{{ sent() ? t('Sent') + ' ' + time(item()?.createdAt) : t('Waiting for signal') }}@if (accuracy()) { · {{ t('location') }} ±{{ accuracy() }} m }</span>
        </div>
        <div class="row-item" [class.ok]="track()?.seen">
          <ion-icon [name]="track()?.seen ? 'checkmark-circle' : 'ellipse-outline'" />
          <span>{{ track()?.seen ? t('The situation room saw it') : t('Waiting for the situation room to see it') }}@if (track()?.seenAt) { · {{ time(track()!.seenAt!) }} }</span>
        </div>
        <div class="row-item" [class.ok]="!!track()?.handler">
          <ion-icon [name]="track()?.handler ? 'call' : 'ellipse-outline'" />
          <span>{{ track()?.handler ? track()!.handler + ' ' + t('will call you') : t('Someone will call you') }}</span>
        </div>
      </div>
      @if (!sent() && item(); as i) {
        <div class="pad0"><button class="big red" (click)="outbox.sendBySms(i)"><ion-icon name="chatbubbles" />{{ t('Send by SMS') }}</button></div>
      }

      <p class="section-title">{{ t('If it is safe, add details') }}</p>
      <div class="pad0">
        <div class="acts">
          <button (click)="photo()"><ion-icon name="camera" />{{ t('Take a photo') }}</button>
          <button (click)="photo('gallery')"><ion-icon name="image" />{{ t('From gallery') }}</button>
        </div>

        <p class="ask">{{ t('What is happening?') }} <span class="opt">· {{ t('optional') }}</span></p>
        <div class="tags">
          @for (c of tags; track c.code) {
            <button [class.on]="tag() === c.code" (click)="pick(c.code)"><ion-icon [name]="icon(c.code)" /><span>{{ t(c.label) }}</span></button>
          }
        </div>

        <div class="more">
          <textarea rows="2" [(ngModel)]="note" [placeholder]="t('Anything else? (optional)')"></textarea>
          @if (note.trim()) { <button class="add" (click)="addNote()">{{ t('Add') }}</button> }
        </div>
        @for (n of added(); track $index) { <p class="added"><ion-icon name="checkmark" /> {{ n }}</p> }

        <button class="big safe" (click)="done()"><ion-icon name="shield-checkmark" />{{ t("I'm safe now") }}</button>

        @if (undoLeft() > 0) {
          <button class="link" (click)="cancel()">{{ t('Sent by mistake? Cancel') }} ({{ undoLeft() }})</button>
        }
        <button class="link" routerLink="/report">{{ t('Not an emergency? Report a problem') }} →</button>
      </div>
    }
  </ion-content>`,
  styles: `
    .hero { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: calc(28px + env(safe-area-inset-top)) 24px 26px;
      background: linear-gradient(180deg, #b3261e, #8f1d17); color: #fff; border-radius: 0 0 28px 28px; }
    .ring { width: 104px; height: 104px; border-radius: 50%; background: rgba(255,255,255,.16); display: grid; place-items: center; animation: pulse 1.8s infinite; }
    .ring span { width: 76px; height: 76px; border-radius: 50%; background: #fff; color: #b3261e; display: grid; place-items: center; font-weight: 900; font-size: 22px; }
    .ring ion-icon { font-size: 64px; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,255,255,.35); } 70% { box-shadow: 0 0 0 22px rgba(255,255,255,0); } 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); } }
    .hero h1 { margin: 6px 0 0; font-size: 26px; font-weight: 800; } .hero p { margin: 0; font-size: 15px; opacity: .95; }
    .hero.calm { background: #fff; color: var(--r-ink); border-bottom: 1px solid var(--r-line); } .hero.calm .ring { background: #e3f4ea; color: #16a34a; animation: none; }
    .status { margin: 14px 12px 0; } .status .row-item { color: var(--r-muted); font-size: 15px; }
    .status ion-icon { font-size: 22px; flex: none; } .status .ok { color: var(--r-ink); } .status .ok ion-icon { color: #16a34a; }
    .pad { padding: 16px; } .pad0 { padding: 0 12px 24px; } .pad0:first-of-type { padding-top: 12px; }
    .section-title { margin: 20px 16px 8px; }
    .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .acts button { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 8px; border: 1px solid var(--r-line); border-radius: 18px;
      background: #fff; font: inherit; font-weight: 700; color: var(--r-ink); } .acts ion-icon { font-size: 30px; color: #b3261e; }
    .ask { margin: 16px 2px 8px; font-weight: 700; } .opt { font-weight: 500; color: var(--r-muted); }
    .tags { display: flex; flex-direction: column; gap: 8px; }
    .tags button { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1.5px solid #f1c4c0; border-radius: 16px; background: #fff;
      color: var(--r-ink); font: inherit; font-size: 16px; font-weight: 600; text-align: left; }
    .tags button ion-icon { font-size: 26px; color: #b3261e; } .tags button.on { border-color: #b3261e; background: #fdecea; }
    .more { display: flex; align-items: flex-end; gap: 8px; margin: 14px 0 6px; }
    .more textarea { flex: 1; font: inherit; font-size: 16px; padding: 12px 14px; border: 1.5px solid #d5dae1; border-radius: 14px; background: #fff; resize: none; }
    .add { border: 0; border-radius: 12px; padding: 12px 16px; background: var(--r-ink); color: #fff; font: inherit; font-weight: 700; }
    .added { display: flex; gap: 6px; align-items: center; margin: 4px 0; font-size: 14px; color: #16a34a; }
    .big { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 16px; padding: 16px;
      font: inherit; font-size: 17px; font-weight: 800; background: var(--r-accent); color: #fff; margin-top: 12px; }
    .big.red { background: #b3261e; } .big.safe { margin-top: 22px; background: #16a34a; }
    .link { display: block; width: 100%; margin-top: 12px; padding: 8px; border: 0; background: none; color: var(--r-muted); font: inherit; font-size: 15px; text-decoration: underline; }
  `,
})
export default class SosPage implements OnDestroy {
  id = input.required<string>();
  outbox = inject(Outbox);
  private api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  t = inject(I18n).t;
  /** The danger categories (optional): helps the room send the right people */
  tags = INCIDENT_CATEGORIES.filter((c) => c.queue === 'security' && c.code !== 'sos');
  icon = categoryIcon;
  item = computed(() => this.outbox.items().find((i) => i.id === this.id()));
  sent = computed(() => this.item()?.status === 'sent');
  tag = signal<string | null>(null);
  added = signal<string[]>([]);
  cancelled = signal<'removed' | 'told' | null>(null);
  note = '';
  undoLeft = signal(UNDO_S);
  private timer = setInterval(() => { this.undoLeft.update((n) => Math.max(0, n - 1)); if (!this.undoLeft()) clearInterval(this.timer); }, 1000);
  /** How the room is handling it (sent, seen, who will call), checked every 10 s once it has gone */
  track = signal<{ seen: boolean; seenAt: string | null; handler: string | null } | null>(null);
  accuracy = signal<number | null>(null);
  private poll = setInterval(() => void this.follow$(), 10_000);

  constructor() {
    void this.follow$();
    navigator.geolocation?.getCurrentPosition((p) => this.accuracy.set(Math.round(p.coords.accuracy)), () => {}, { timeout: 10000, maximumAge: 60000 });
  }
  private async follow$() {
    if (!this.sent() || this.cancelled()) return;
    const r = await this.api.get<{ seen: boolean; seenAt: string | null; handler: string | null } | null>(`/incidents/mine/${this.id()}`).catch(() => undefined);
    if (r) this.track.set(r);
  }

  ngOnDestroy() { clearInterval(this.timer); clearInterval(this.poll); }
  time(at: string | number | undefined) { return at ? new Date(at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : ''; }

  private follow(payload: Record<string, unknown>, label: string, photo?: Blob) {
    return this.outbox.add('incident_details', { reportId: this.id(), pu: this.api.me()?.area_code, ...payload }, label, photo);
  }

  async pick(code: string) {
    if (this.tag() === code) return;
    this.tag.set(code);
    await this.follow({ category: code }, `SOS: ${this.tags.find((c) => c.code === code)?.label}`);
  }
  async addNote() {
    const n = this.note.trim();
    if (!n) return;
    await this.follow({ note: n }, 'SOS: note');
    this.added.update((a) => [...a, n]);
    this.note = '';
  }
  async photo(from: 'camera' | 'gallery' = 'camera') {
    const p = await takePhoto(from);
    if (!p) return;
    await this.follow({}, 'SOS: photo', p.blob);
    this.added.update((a) => [...a, this.t('Photo added')]);
  }

  async cancel() {
    if (!(await this.ui.confirm('Cancel the SOS?', 'Only if it was sent by mistake. If you are in danger, keep it.', 'Yes, cancel it', 'Keep SOS'))) return;
    // Not gone yet: simply never send it. Gone: tell the room it was a mistake.
    if (await this.outbox.remove(this.id())) {
      for (const f of this.outbox.items().filter((i) => i.kind === 'incident_details' && i.payload['reportId'] === this.id())) await this.outbox.remove(f.id);
      this.cancelled.set('removed');
    }
    else { await this.follow({ mistake: true }, 'SOS cancelled'); this.cancelled.set('told'); }
    clearInterval(this.timer);
  }
  cancelledText() {
    return this.cancelled() === 'removed' ? this.t('It had not gone yet, so nothing was sent.') : this.t('The situation room is told it was sent by mistake.');
  }

  done() { void this.router.navigateByUrl('/'); }
}
