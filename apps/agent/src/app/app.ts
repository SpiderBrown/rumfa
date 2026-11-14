import { Component, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonApp, IonRouterOutlet, AlertController } from '@ionic/angular';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Supa } from './core/supa';
import { I18n } from './core/i18n';

@Component({
  selector: 'app-root',
  imports: [IonApp, IonRouterOutlet],
  template: '<ion-app><ion-router-outlet /></ion-app>',
})
export class App {
  private supa = inject(Supa);
  private router = inject(Router);
  private alert = inject(AlertController);
  private i18n = inject(I18n);
  private rt?: RealtimeChannel;

  constructor() {
    // When signed in: register for push, and listen for live-view requests
    effect(() => {
      const me = this.supa.me();
      if (!me || !this.supa.session()) return;
      void this.registerPush();
      this.rt?.unsubscribe();
      this.rt = this.supa.client.channel(`lv-${me.id}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_view_requests', filter: `agent_id=eq.${me.id}` },
          (p) => void this.askLiveView((p.new as any).id))
        .subscribe();
    });
  }

  private async registerPush() {
    if (!Capacitor.isNativePlatform()) return;
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.addListener('registration', (t) => void this.supa.rpc('register_device', { p_token: t.value, p_platform: Capacitor.getPlatform() }));
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
        { text: this.i18n.t('No'), role: 'cancel', handler: () => void this.supa.rpc('answer_live_view', { p_id: id, p_accept: false }) },
        { text: this.i18n.t('Yes'), handler: () => void this.router.navigate(['/live', id]) },
      ],
    });
    await a.present();
  }
}
