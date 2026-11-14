import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonListHeader, IonSegment, IonSegmentButton,
  IonTitle, IonToolbar } from '@ionic/angular';
import { Supa } from '../core/supa';
import { I18n, LANGUAGES } from '../core/i18n';

@Component({
  selector: 'page-help',
  imports: [IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonItem, IonLabel, IonList, IonListHeader, IonSegment, IonSegmentButton, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="primary"><ion-buttons slot="start"><ion-back-button defaultHref="/" /></ion-buttons>
    <ion-title>{{ t('Help') }}</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    <ion-list>
      <ion-list-header>{{ t('Language') }}</ion-list-header>
      <ion-segment [value]="i18n.lang()" (ionChange)="i18n.set($any($event.detail.value))">
        @for (l of langs; track l.code) { <ion-segment-button [value]="l.code"><ion-label>{{ l.name }}</ion-label></ion-segment-button> }
      </ion-segment>
      <ion-list-header>How it works</ion-list-header>
      <ion-item><ion-label class="ion-text-wrap">Everything you send is saved on your phone first. When there is no internet, it sends later by itself.</ion-label></ion-item>
      <ion-item><ion-label class="ion-text-wrap">If a result or report has not gone after 2 minutes, a <b>Send by SMS</b> button appears. The app writes the SMS for you; just tap Send.</ion-label></ion-item>
      <ion-item><ion-label class="ion-text-wrap">For danger, use <b>SOS</b>. For questions, use <b>Ask my coordinator to call me</b>.</ion-label></ion-item>
      <ion-item><ion-label>Your agent code: <b>{{ supa.me()?.agent_code ?? '—' }}</b></ion-label></ion-item>
    </ion-list>
    @if (helpline) { <ion-button expand="block" [href]="'tel:' + helpline">Call the helpdesk</ion-button> }
    <ion-button expand="block" fill="outline" color="medium" (click)="signOut()">Sign out</ion-button>
  </ion-content>`,
})
export default class HelpPage {
  supa = inject(Supa);
  i18n = inject(I18n);
  private router = inject(Router);
  t = this.i18n.t;
  langs = LANGUAGES;
  helpline = window.RUMFA_CONFIG.helpline;
  async signOut() { await this.supa.signOut(); await this.router.navigateByUrl('/login'); }
}
