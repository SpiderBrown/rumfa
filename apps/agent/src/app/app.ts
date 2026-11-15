import { Component, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonApp, IonRouterOutlet, AlertController } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Api } from './core/api';
import { I18n } from './core/i18n';

@Component({
  selector: 'app-root',
  imports: [IonApp, IonRouterOutlet],
  template: '<ion-app><ion-router-outlet /></ion-app>',
})
export class App {
  private api = inject(Api);
  private router = inject(Router);
  private alert = inject(AlertController);
  private i18n = inject(I18n);
  private stopLive?: () => void;

  constructor() {
    // When signed in: register for push, and listen for live-view requests
    effect(() => {
      const me = this.api.me();
      if (!me || !this.api.session()) return;
      void this.registerPush();
      // Live-view requests addressed to me arrive on my own live-update room
      this.stopLive?.();
      this.stopLive = this.api.onChange((c) => {
        if (c.op === 'insert' && c.status === 'requested' && c.id) void this.askLiveView(c.id);
      }, ['live_view_requests']);
    });
  }

  private async registerPush() {
    if (!Capacitor.isNativePlatform()) return;
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.addListener('registration', (t) => void this.api.post('/me/device-tokens', { token: t.value, platform: Capacitor.getPlatform() }).catch(() => undefined));
    await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
      const d = a.notification.data ?? {};
      if (d.template === 'live_view_request') void this.router.navigate(['/live', d.request_id]);
      else if (d.template === 'callback_request') void this.router.navigateByUrl('/coord/callbacks');
      else if (d.case_id) void this.router.navigateByUrl('/messages');
    });
    await PushNotifications.register();
  }

  private async askLiveView(id: string) {
    const a = await this.alert.create({
      header: this.i18n.t('Live view request'),
      message: this.i18n.t('The situation room asks to see your polling unit through your camera.'),
      buttons: [
        { text: this.i18n.t('No'), role: 'cancel', handler: () => void this.api.post(`/live-view/${id}/answer`, { accept: false }).catch(() => undefined) },
        { text: this.i18n.t('Yes'), handler: () => void this.router.navigate(['/live', id]) },
      ],
    });
    await a.present();
  }
}
