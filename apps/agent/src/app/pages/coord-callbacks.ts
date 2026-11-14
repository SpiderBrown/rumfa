import { Component, OnDestroy, inject, signal } from '@angular/core';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonTitle, IonToolbar } from '@ionic/angular';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { CALLBACK_REASONS } from '@rumfa/shared';
import { Supa } from '../core/supa';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';

/** Coordinator's callback queue. Call rings the coordinator's phone first, then connects the agent (normal phone lines). */
@Component({
  selector: 'page-coord-callbacks',
  imports: [IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Callback requests') }}</ion-title></ion-toolbar></ion-header>
  <ion-content>
    <ion-list>
      @for (r of rows(); track r.id) {
        <ion-item>
          <ion-label class="ion-text-wrap"><h2>{{ r.requester?.full_name }}</h2>
            <p>{{ reason(r.reason) }} · {{ r.requester?.area_code }} · {{ waiting(r.created_at) }}</p>
            @if (r.status === 'no_answer') { <p>No answer last time</p> }</ion-label>
          @if (r.status === 'calling') {
            <ion-button slot="end" color="success" (click)="done(r, true)">Talked</ion-button>
            <ion-button slot="end" fill="outline" (click)="done(r, false)">No answer</ion-button>
          } @else { <ion-button slot="end" (click)="call(r)">{{ t('Call') }}</ion-button> }
        </ion-item>
      } @empty { <ion-item><ion-label>No requests waiting.</ion-label></ion-item> }
    </ion-list>
  </ion-content>`,
})
export default class CoordCallbacksPage implements OnDestroy {
  private supa = inject(Supa);
  private ui = inject(Ui);
  t = inject(I18n).t;
  rows = signal<any[]>([]);
  private rt: RealtimeChannel;

  constructor() {
    void this.load();
    this.rt = this.supa.client.channel('coord-cb')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'callback_requests' }, () => void this.load()).subscribe();
  }
  ngOnDestroy() { void this.supa.client.removeChannel(this.rt); }

  reason(c: string) { return CALLBACK_REASONS.find((r) => r.code === c)?.label ?? c; }
  waiting(t: string) { return `${Math.round((Date.now() - new Date(t).getTime()) / 60000)} min ago`; }

  async load() {
    const { data } = await this.supa.client.from('callback_requests')
      .select('*, requester:volunteers!callback_requests_requester_id_fkey(full_name, phone, area_code)')
      .eq('assigned_to', this.supa.me()!.id).in('status', ['waiting', 'calling', 'no_answer']).order('due_at');
    this.rows.set(data ?? []);
  }

  async call(r: any) {
    try {
      const res = await this.supa.fn<{ bridged: boolean; dial_direct?: string }>('calls', { action: 'callback', callback_id: r.id });
      if (res.bridged) await this.ui.toast('Your phone will ring now. Answer it and we connect the agent.');
      else if (res.dial_direct) window.location.href = `tel:${res.dial_direct}`;
    } catch {
      // No internet: call directly on the phone line
      window.location.href = `tel:${r.requester?.phone}`;
    }
    await this.load();
  }

  async done(r: any, answered: boolean) {
    await this.supa.rpc('complete_callback', { p_id: r.id, p_answered: answered, p_outcome: answered ? 'Talked' : null }).catch((e) => this.ui.error(e));
    await this.load();
  }
}
