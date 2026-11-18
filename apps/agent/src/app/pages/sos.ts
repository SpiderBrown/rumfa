import { Component, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { IonButton, IonContent, IonHeader, IonIcon, IonTextarea, IonTitle, IonToolbar } from '@ionic/angular';
import { INCIDENT_CATEGORIES } from '@rumfa/shared';
import { Api } from '../core/api';
import { Outbox } from '../core/outbox';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { takePhoto } from '../core/photo';
import { categoryIcon } from '../core/categories';

/** How long "Sent by mistake? Cancel" stays on screen */
const UNDO_S = 30;
const TAGS = ['violence', 'ballot_snatching', 'thugs'];

/**
 * After holding SOS: the emergency has already gone (or is waiting for signal). Nothing here is needed; it only
 * adds to the alert: what is happening, a note, a photo. It deliberately looks nothing like the report form.
 */
@Component({
  selector: 'page-sos',
  imports: [FormsModule, RouterLink, IonButton, IonContent, IonHeader, IonIcon, IonTextarea, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="danger"><ion-title>{{ t('SOS') }}</ion-title></ion-toolbar></ion-header>
  <ion-content>
    @if (cancelled()) {
      <div class="banner calm">
        <ion-icon name="checkmark-circle" />
        <h1>{{ t('SOS cancelled') }}</h1>
        <p>{{ cancelledText() }}</p>
      </div>
      <div class="pad"><ion-button expand="block" (click)="done()">{{ t('Done') }}</ion-button></div>
    } @else {
      <div class="banner">
        <ion-icon name="alert-circle" />
        @if (sent()) {
          <h1>{{ t('Emergency sent') }}</h1>
          <p>{{ t('The situation room is alerted and will call you. Keep your phone with you.') }}</p>
        } @else {
          <h1>{{ t('Emergency saved') }}</h1>
          <p>{{ t('No signal yet: it goes the moment there is. Send it by SMS now if you can.') }}</p>
        }
      </div>
      @if (!sent() && item(); as i) {
        <div class="pad"><ion-button expand="block" color="danger" (click)="outbox.sendBySms(i)"><ion-icon slot="start" name="chatbubbles" />{{ t('Send by SMS') }}</ion-button></div>
      }

      <div class="pad">
        <p class="ask">{{ t('If you can, say what is happening') }} <span class="opt">({{ t('optional') }})</span></p>
        <div class="tags">
          @for (c of tags; track c.code) {
            <button [class.on]="tag() === c.code" (click)="pick(c.code)"><ion-icon [name]="icon(c.code)" /><span>{{ t(c.label) }}</span></button>
          }
        </div>

        <div class="more">
          <ion-textarea [placeholder]="t('Anything else? (optional)')" [autoGrow]="true" [(ngModel)]="note" rows="2" />
          @if (note.trim()) { <ion-button size="small" (click)="addNote()">{{ t('Add') }}</ion-button> }
        </div>
        @for (n of added(); track $index) { <p class="added"><ion-icon name="checkmark" /> {{ n }}</p> }
        <ion-button expand="block" fill="outline" color="dark" (click)="photo()"><ion-icon slot="start" name="camera" />{{ t('Add a photo') }}</ion-button>

        <ion-button expand="block" class="done" (click)="done()">{{ t('Done') }}</ion-button>

        @if (undoLeft() > 0) {
          <button class="link" (click)="cancel()">{{ t('Sent by mistake? Cancel') }} ({{ undoLeft() }})</button>
        }
        <button class="link" routerLink="/report">{{ t('Not an emergency? Report a problem') }} →</button>
      </div>
    }
  </ion-content>`,
  styles: `
    .banner { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; padding: 28px 24px 24px;
      background: #b3261e; color: #fff; }
    .banner ion-icon { font-size: 56px; } .banner h1 { margin: 0; font-size: 24px; font-weight: 800; } .banner p { margin: 0; font-size: 15px; opacity: .95; }
    .banner.calm { background: var(--ion-color-light); color: var(--ion-text-color); } .banner.calm ion-icon { color: var(--ion-color-success); }
    .pad { padding: 16px; }
    .ask { margin: 4px 0 10px; font-weight: 600; } .opt { font-weight: 400; color: var(--ion-color-medium); }
    .tags { display: flex; flex-direction: column; gap: 8px; }
    .tags button { display: flex; align-items: center; gap: 12px; padding: 14px; border: 2px solid #f1c4c0; border-radius: 14px; background: #fff;
      color: var(--ion-text-color); font: inherit; font-size: 16px; font-weight: 600; text-align: left; }
    .tags button ion-icon { font-size: 26px; color: #b3261e; } .tags button.on { border-color: #b3261e; background: #fdecea; }
    .more { display: flex; align-items: flex-end; gap: 8px; margin: 14px 0 6px; } .more ion-textarea { flex: 1; border-bottom: 1px solid #ddd; }
    .added { display: flex; gap: 6px; align-items: center; margin: 4px 0; font-size: 14px; color: var(--ion-color-success); }
    .done { margin-top: 18px; }
    .link { display: block; width: 100%; margin-top: 14px; padding: 8px; border: 0; background: none; color: var(--ion-color-medium);
      font: inherit; font-size: 15px; text-decoration: underline; }
  `,
})
export default class SosPage implements OnDestroy {
  id = input.required<string>();
  outbox = inject(Outbox);
  private api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  t = inject(I18n).t;
  tags = INCIDENT_CATEGORIES.filter((c) => TAGS.includes(c.code));
  icon = categoryIcon;
  item = computed(() => this.outbox.items().find((i) => i.id === this.id()));
  sent = computed(() => this.item()?.status === 'sent');
  tag = signal<string | null>(null);
  added = signal<string[]>([]);
  cancelled = signal<'removed' | 'told' | null>(null);
  note = '';
  undoLeft = signal(UNDO_S);
  private timer = setInterval(() => { this.undoLeft.update((n) => Math.max(0, n - 1)); if (!this.undoLeft()) clearInterval(this.timer); }, 1000);

  ngOnDestroy() { clearInterval(this.timer); }

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
  async photo() {
    const p = await takePhoto();
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
