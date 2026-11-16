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

  async confirm(header: string, message: string, ok = 'Yes', cancel = 'No'): Promise<boolean> {
    return new Promise((resolve) => {
      void this.alertCtl.create({
        header: this.i18n.t(header), message: this.i18n.t(message), backdropDismiss: false,
        buttons: [{ text: this.i18n.t(cancel), role: 'cancel', handler: () => resolve(false) }, { text: this.i18n.t(ok), handler: () => resolve(true) }],
      }).then((a) => a.present());
    });
  }

  /** A message with one OK button. */
  async alert(header: string, message: string): Promise<void> {
    const a = await this.alertCtl.create({ header: this.i18n.t(header), message: this.i18n.t(message), buttons: [this.i18n.t('OK')] });
    await a.present();
    await a.onDidDismiss();
  }

  /** Asks for a short text; null when cancelled. `required` keeps asking until something is typed. */
  async prompt(header: string, message: string, opts: { placeholder?: string; ok?: string; required?: boolean } = {}): Promise<string | null> {
    for (;;) {
      const a = await this.alertCtl.create({
        header: this.i18n.t(header), message: this.i18n.t(message), backdropDismiss: false,
        inputs: [{ name: 'text', type: 'textarea', placeholder: this.i18n.t(opts.placeholder ?? ''), attributes: { maxlength: 500 } }],
        buttons: [{ text: this.i18n.t('Cancel'), role: 'cancel' }, { text: this.i18n.t(opts.ok ?? 'OK'), role: 'ok' }],
      });
      await a.present();
      const r = await a.onDidDismiss();
      if (r.role !== 'ok') return null;
      const text = String(r.data?.values?.text ?? '').trim();
      if (text || !opts.required) return text;
      await this.toast('Please write a short reason', 'danger');
    }
  }
}
