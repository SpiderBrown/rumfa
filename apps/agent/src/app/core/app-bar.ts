import { Component, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IonBackButton, IonButtons, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular';
import { Api } from './api';
import { Badges } from './badges';
import { I18n } from './i18n';
import { Outbox } from './outbox';
import { OutboxSheet } from './outbox-sheet';
import { Ui } from './ui';

const HOLD_MS = 1500;

/**
 * The top bar on every main screen: title, sync state (items waiting to send, offline), and SOS.
 * SOS is sent by holding the button (a ring fills for 1.5 s, then the phone vibrates): one gesture under stress,
 * but never sent by a brush in a pocket. A short tap explains how.
 */
@Component({
  selector: 'app-bar',
  imports: [IonBackButton, IonButtons, IonHeader, IonIcon, IonTitle, IonToolbar],
  template: `
  <ion-header>
    <ion-toolbar color="primary">
      @if (back()) { <ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons> }
      <ion-title><div class="t">{{ title() }}</div>@if (sub()) { <div class="st">{{ sub() }}</div> }</ion-title>
      <ion-buttons slot="end">
        @if (!outbox.online() || badges.waiting()) {
          <button class="sync" [class.off]="!outbox.online()" (click)="openOutbox()" [attr.aria-label]="syncLabel()">
            <ion-icon [name]="outbox.online() ? 'cloud-upload-outline' : 'cloud-offline'" />
            {{ outbox.online() ? badges.waiting() : t('Offline') }}
          </button>
        }
        @if (sos()) {
          <button class="sos" [class.holding]="holding()" (pointerdown)="start($event)" (pointerup)="cancel(true)" (pointerleave)="cancel(false)"
            (pointercancel)="cancel(false)" (contextmenu)="$event.preventDefault()" [attr.aria-label]="t('Hold for SOS')">
            <svg viewBox="0 0 36 36" class="ring" aria-hidden="true"><circle cx="18" cy="18" r="16" [style.stroke-dashoffset]="dash()" /></svg>
            <span>SOS</span>
          </button>
        }
      </ion-buttons>
    </ion-toolbar>
    <ng-content />
  </ion-header>`,
  styles: `
    :host { display: block; position: relative; z-index: 10; }
    .t { font-size: 18px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; } .st { font-size: 12px; font-weight: 400; opacity: .85; }
    .sync { display: flex; align-items: center; gap: 4px; margin-right: 6px; padding: 4px 9px; border: 0; border-radius: 14px; font: inherit; font-size: 13px;
      font-weight: 600; background: rgba(255,255,255,.18); color: #fff; } .sync.off { background: #f59e0b; color: #111; } .sync ion-icon { font-size: 17px; }
    .sos { position: relative; width: 58px; height: 34px; margin-right: 8px; border: 0; border-radius: 17px; background: #d32f2f; color: #fff;
      font: inherit; font-weight: 800; letter-spacing: .5px; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
      box-shadow: 0 0 0 2px rgba(255,255,255,.85); }
    .sos.holding { background: #b71c1c; transform: scale(1.06); }
    .ring { position: absolute; inset: -5px -2px; width: calc(100% + 4px); height: calc(100% + 10px); pointer-events: none; }
    .ring circle { fill: none; stroke: #fff; stroke-width: 3; stroke-dasharray: 101; transform: rotate(-90deg); transform-origin: center; transition: stroke-dashoffset .05s linear; }
    .sos span { position: relative; }
  `,
})
export class AppBar implements OnDestroy {
  title = input('');
  sub = input('');
  back = input(false);
  /** SOS shows for people at a polling unit (agents and volunteers) */
  sos = input(true);
  outbox = inject(Outbox);
  badges = inject(Badges);
  private api = inject(Api);
  private router = inject(Router);
  private ui = inject(Ui);
  private sheet = inject(OutboxSheet);
  t = inject(I18n).t;

  holding = signal(false);
  private progress = signal(0);
  private startedAt = 0;
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  dash = computed(() => 101 * (1 - this.progress()));
  syncLabel = computed(() => this.outbox.online() ? `${this.badges.waiting()} ${this.t('waiting to send')}` : this.t('Offline'));

  ngOnDestroy() { cancelAnimationFrame(this.raf); clearTimeout(this.timer); }

  start(ev: PointerEvent) {
    ev.preventDefault();
    this.holding.set(true);
    this.startedAt = performance.now();
    navigator.vibrate?.(10);
    // A timer decides (animation frames pause when the page is not visible); frames only draw the ring
    this.timer = setTimeout(() => this.fire(), HOLD_MS);
    const tick = () => {
      if (!this.holding()) return;
      this.progress.set(Math.min(1, (performance.now() - this.startedAt) / HOLD_MS));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Released or slid away: a quick tap explains how to send */
  cancel(released: boolean) {
    if (!this.holding()) return;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.timer);
    const short = performance.now() - this.startedAt < 400;
    this.holding.set(false);
    this.progress.set(0);
    if (released && short) void this.ui.toast('Hold the SOS button for a moment to send an emergency', 'medium');
  }

  private fire() {
    cancelAnimationFrame(this.raf);
    this.holding.set(false);
    this.progress.set(0);
    navigator.vibrate?.([40, 60, 40]);
    void this.sendSos();
  }

  /** SOS goes at once, with no question first; what is happening can be added on the next screen. */
  private async sendSos() {
    const me = this.api.me();
    if (!me) return;
    const item = await this.outbox.add('incident', { pu: me.area_code, category: 'sos', severity: 'critical', description: null, sos: true }, 'SOS');
    await this.router.navigate(['/sos', item.id]);
  }

  openOutbox() { void this.sheet.open(); }
}
