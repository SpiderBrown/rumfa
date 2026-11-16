import { Component, OnDestroy, inject, signal } from '@angular/core';
import { IonButton, IonContent, IonItem, IonLabel, IonList } from '@ionic/angular';
import { CALLBACK_REASONS } from '@rumfa/shared';
import { Api } from '../core/api';
import { AppBar } from '../core/app-bar';
import { I18n } from '../core/i18n';
import { Ui } from '../core/ui';
import { AgoPipe } from '../core/clock';

/** Coordinator's callback queue. Call rings the coordinator's phone first, then connects the agent (normal phone lines). */
@Component({
  selector: 'page-coord-callbacks',
  imports: [AppBar, IonButton, IonContent, IonItem, IonLabel, IonList, AgoPipe],
  template: `
  <app-bar [title]="t('Callback requests')" [sos]="false" />
  <ion-content>
    <ion-list>
      @for (r of rows(); track r.id) {
        <ion-item>
          <ion-label class="ion-text-wrap"><h2>{{ r.requester?.full_name }}</h2>
            <p>{{ reason(r.reason) }} · {{ r.requester?.area_code }} · {{ r.created_at | ago }}</p>
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
  private api = inject(Api);
  private ui = inject(Ui);
  t = inject(I18n).t;
  rows = signal<any[]>([]);
  private stopLive: () => void;

  constructor() {
    void this.load();
    this.stopLive = this.api.onChange(() => void this.load(), ['callback_requests']);
  }
  ngOnDestroy() { this.stopLive(); }

  reason(c: string) { return CALLBACK_REASONS.find((r) => r.code === c)?.label ?? c; }

  async load() {
    this.rows.set(await this.api.get<any[]>('/callbacks', { mine: true, status: 'waiting,calling,no_answer' }).catch(() => this.rows()));
  }

  async call(r: any) {
    try {
      const res = await this.api.post<{ bridged: boolean; dialDirect?: string }>(`/callbacks/${r.id}/call`);
      if (res.bridged) await this.ui.toast('Your phone will ring now. Answer it and we connect the agent.');
      else if (res.dialDirect) window.location.href = `tel:${res.dialDirect}`;
    } catch {
      // No internet: call directly on the phone line
      window.location.href = `tel:${r.requester?.phone}`;
    }
    await this.load();
  }

  async done(r: any, answered: boolean) {
    await this.api.post(`/callbacks/${r.id}/complete`, { answered, outcome: answered ? 'Talked' : undefined }).catch((e) => this.ui.error(e));
    await this.load();
  }
}
