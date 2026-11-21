import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { Geolocation } from '@capacitor/geolocation';
import { PushNotifications } from '@capacitor/push-notifications';
import { Api } from '../core/api';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

type Perm = 'camera' | 'location' | 'notifications' | 'microphone';
type State = 'ask' | 'ok' | 'no';

/** One-time setup ("Get ready"): confirm details, allow what the app needs, network (for airtime/data) and languages. */
@Component({
  selector: 'page-onboarding',
  imports: [FormsModule, IonContent, IonIcon],
  template: `
  <ion-content class="ion-padding">
    @if (api.me(); as me) {
      <h1 class="page-title">{{ t('Get ready') }}</h1>
      <div class="card profile">
        <span class="av">{{ initials(me.full_name) }}</span>
        <div><b>{{ me.full_name }}</b><small>{{ roleName(me) }} · {{ me.area_code }}</small>
          @if (me.agent_code) { <small>{{ t('Agent code') }} {{ me.agent_code }}</small> }</div>
      </div>
      <p class="hint">{{ t('If these details are wrong, tell your coordinator.') }}</p>

      <p class="section-title">{{ t('Allow on this phone') }}</p>
      <div class="card flat">
        @for (p of perms; track p.key) {
          <div class="row-item">
            <span class="ico" [class]="p.tone"><ion-icon [name]="p.icon" /></span>
            <span class="grow"><b>{{ t(p.name) }}</b><small>{{ t(p.why) }}</small></span>
            @switch (state()[p.key]) {
              @case ('ok') { <span class="ok"><ion-icon name="checkmark-circle" /></span> }
              @case ('no') { <button class="allow again" (click)="ask(p.key)">{{ t('Try again') }}</button> }
              @default { <button class="allow" (click)="ask(p.key)">{{ t('Allow') }}</button> }
            }
          </div>
        }
      </div>

      <p class="section-title">{{ t('Your mobile network') }}</p>
      <div class="pills">
        @for (n of networks; track n.code) {
          <button class="pill" [class.on]="network === n.code" (click)="network = n.code">{{ n.name }}</button>
        }
      </div>

      <p class="section-title">{{ t('Languages you speak') }}</p>
      <div class="pills">
        @for (l of langs; track l.code) {
          <button class="pill" [class.on]="languages.has(l.code)" (click)="toggle(l.code)">{{ l.name }}</button>
        }
      </div>

      <button class="ready" (click)="save()" [disabled]="!network">{{ t("I'm ready") }}</button>
      @if (!network) { <p class="hint center">{{ t('Pick your mobile network to continue') }}</p> }
    }
  </ion-content>`,
  styles: `
    .profile { display: flex; align-items: center; gap: 14px; }
    .profile .av { width: 56px; height: 56px; font-size: 20px; }
    .profile b { display: block; font-size: 18px; } .profile small { display: block; color: var(--r-muted); }
    .grow { flex: 1; min-width: 0; } .grow b { display: block; } .grow small { display: block; color: var(--r-muted); font-size: 13px; }
    .allow { font: inherit; font-weight: 700; border: 0; border-radius: 999px; padding: 8px 16px; background: var(--r-accent); color: #fff; }
    .allow.again { background: #fdecea; color: var(--r-urgent); }
    .ok ion-icon { font-size: 30px; color: #16a34a; }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .pill { font: inherit; font-weight: 600; border: 1.5px solid #d5dae1; background: #fff; border-radius: 999px; padding: 10px 16px; color: var(--r-ink); }
    .pill.on { border-color: var(--r-accent); background: var(--r-accent-soft); color: var(--r-accent); }
    .ready { margin-top: 24px; width: 100%; font: inherit; font-size: 18px; font-weight: 800; border: 0; border-radius: 16px; padding: 16px; background: var(--r-accent); color: #fff; }
    .ready:disabled { opacity: .45; }
    .center { text-align: center; }
  `,
})
export default class OnboardingPage {
  api = inject(Api);
  private router = inject(Router);
  private ui = inject(Ui);
  t = inject(I18n).t;
  readonly perms: { key: Perm; name: string; why: string; icon: string; tone: string }[] = [
    { key: 'camera', name: 'Camera', why: 'Photos of the result sheet and incidents', icon: 'camera', tone: 'ico teal' },
    { key: 'location', name: 'Location', why: 'Check in at your polling unit', icon: 'location', tone: 'ico blue' },
    { key: 'notifications', name: 'Notifications', why: 'Calls, tasks and messages from the room', icon: 'notifications', tone: 'ico orange' },
    { key: 'microphone', name: 'Microphone', why: 'Calls and voice notes in the app', icon: 'mic', tone: 'ico grey' },
  ];
  state = signal<Record<Perm, State>>({ camera: 'ask', location: 'ask', notifications: 'ask', microphone: 'ask' });
  networks = [{ code: 'mtn', name: 'MTN' }, { code: 'airtel', name: 'Airtel' }, { code: 'glo', name: 'Glo' }, { code: '9mobile', name: '9mobile' }];
  langs = [{ code: 'en', name: 'English' }, { code: 'ha', name: 'Hausa' }, { code: 'ff', name: 'Fulfulde' }, { code: 'kr', name: 'Kanuri' },
    { code: 'yo', name: 'Yoruba' }, { code: 'ig', name: 'Igbo' }, { code: 'tiv', name: 'Tiv' }, { code: 'nup', name: 'Nupe' }];
  network = this.api.me()?.network ?? '';
  languages = new Set(this.api.me()?.languages ?? ['en']);

  constructor() { void this.check(); }

  initials(name: string) { return name.replace(/[^\p{L}\s]/gu, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  roleName(me: { role: string; level: string }) {
    if (me.role === 'coordinator') return ({ ward: 'Ward coordinator', lga: 'LGA coordinator', state: 'State coordinator' } as Record<string, string>)[me.level] ?? 'Coordinator';
    return me.role === 'agent' ? 'Polling unit agent' : me.role;
  }
  toggle(code: string) { if (this.languages.has(code)) this.languages.delete(code); else this.languages.add(code); }

  private set(k: Perm, s: State) { this.state.update((m) => ({ ...m, [k]: s })); }

  /** What is already allowed (so the rows open ticked). */
  private async check() {
    const native = Capacitor.isNativePlatform();
    const q = async (name: string) => { try { return (await navigator.permissions.query({ name } as PermissionDescriptor)).state; } catch { return 'prompt'; } };
    try {
      const cam = native ? (await Camera.checkPermissions()).camera : await q('camera');
      if (cam === 'granted') this.set('camera', 'ok');
      const loc = native ? (await Geolocation.checkPermissions()).location : await q('geolocation');
      if (loc === 'granted') this.set('location', 'ok');
      const not = native ? (await PushNotifications.checkPermissions()).receive : (typeof Notification !== 'undefined' ? (Notification.permission === 'default' ? 'prompt' : Notification.permission) : 'prompt');
      if (not === 'granted') this.set('notifications', 'ok');
      if (await q('microphone') === 'granted') this.set('microphone', 'ok');
    } catch { /* leave as "Allow" */ }
  }

  async ask(k: Perm) {
    const native = Capacitor.isNativePlatform();
    try {
      let ok = false;
      if (k === 'camera') {
        if (native) ok = (await Camera.requestPermissions({ permissions: ['camera'] })).camera === 'granted';
        else ok = await this.media({ video: true });
      } else if (k === 'location') {
        if (native) ok = (await Geolocation.requestPermissions()).location === 'granted';
        else ok = await new Promise<boolean>((res) => navigator.geolocation.getCurrentPosition(() => res(true), () => res(false), { timeout: 15000 }));
      } else if (k === 'notifications') {
        if (native) ok = (await PushNotifications.requestPermissions()).receive === 'granted';
        else ok = typeof Notification !== 'undefined' && (await Notification.requestPermission()) === 'granted';
      } else {
        ok = await this.media({ audio: true });
      }
      this.set(k, ok ? 'ok' : 'no');
    } catch { this.set(k, 'no'); }
  }
  private async media(c: MediaStreamConstraints) {
    try { const s = await navigator.mediaDevices.getUserMedia(c); s.getTracks().forEach((t) => t.stop()); return true; } catch { return false; }
  }

  async save() {
    try {
      await this.api.post('/me/onboarding', { network: this.network, languages: [...this.languages] });
      await this.api.refreshMe();
      await this.router.navigateByUrl('/');
    } catch (e) { await this.ui.error(e); }
  }
}
