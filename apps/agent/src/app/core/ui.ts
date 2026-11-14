import { Injectable, inject } from '@angular/core';
import { AlertController, ToastController } from '@ionic/angular';
import { I18n } from './i18n';

@Injectable({ providedIn: 'root' })
export class Ui {
  private toastCtl = inject(ToastController);
  private alertCtl = inject(AlertController);
  private i18n = inject(I18n);

  async toast(msg: string, color: 'success' | 'danger' | 'medium' = 'success') {
    const t = await this.toastCtl.create({ message: this.i18n.t(msg), duration: 3500, color, position: 'top' });
    await t.present();
  }
  async error(e: unknown) { await this.toast(e instanceof Error ? e.message : String(e), 'danger'); }

  async confirm(header: string, message: string, ok = 'Yes'): Promise<boolean> {
    return new Promise((resolve) => {
      void this.alertCtl.create({
        header: this.i18n.t(header), message: this.i18n.t(message),
        buttons: [{ text: this.i18n.t('No'), role: 'cancel', handler: () => resolve(false) }, { text: this.i18n.t(ok), handler: () => resolve(true) }],
      }).then((a) => a.present());
    });
  }
}
