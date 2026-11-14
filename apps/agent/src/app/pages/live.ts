import { Component, ElementRef, OnDestroy, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { Supa } from '../core/supa';
import { Ui } from '../core/ui';

/**
 * Live view: one-way video from this phone (240-360p) to the situation room.
 * On a weak connection, record a 20-30 second clip instead and upload it when possible.
 */
@Component({
  selector: 'page-live',
  imports: [IonButton, IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
  <ion-header><ion-toolbar color="danger"><ion-title>Live view</ion-title></ion-toolbar></ion-header>
  <ion-content class="ion-padding">
    <video #preview autoplay playsinline muted class="v"></video>
    <p>{{ state() }}</p>
    @switch (mode()) {
      @case ('choose') {
        <ion-button expand="block" (click)="goLive()">Start live video</ion-button>
        <ion-button expand="block" fill="outline" (click)="recordClip()">Record a 25-second clip instead</ion-button>
        <ion-button expand="block" fill="clear" color="medium" (click)="decline()">Not now</ion-button>
      }
      @case ('live') { <ion-button expand="block" color="danger" (click)="stop()">Stop</ion-button> }
      @case ('recording') { <p>Recording… keep the phone steady.</p> }
    }
  </ion-content>`,
  styles: `.v { width: 100%; background: #000; border-radius: 12px; aspect-ratio: 3/4; object-fit: cover; }`,
})
export default class LivePage implements OnDestroy {
  id = input.required<string>();
  private supa = inject(Supa);
  private ui = inject(Ui);
  private router = inject(Router);
  private preview = viewChild.required<ElementRef<HTMLVideoElement>>('preview');
  mode = signal<'choose' | 'live' | 'recording'>('choose');
  state = signal('The situation room wants to see your polling unit.');
  private room: any;
  private stream?: MediaStream;

  async goLive() {
    try {
      await this.supa.rpc('answer_live_view', { p_id: this.id(), p_accept: true, p_mode: 'live' }).catch(() => {});
      const { Room, createLocalVideoTrack, VideoPresets } = await import('livekit-client');
      const { url, token } = await this.supa.fn<{ url: string; token: string }>('live-view', { action: 'publish', request_id: this.id() });
      const track = await createLocalVideoTrack({ facingMode: 'environment', resolution: VideoPresets.h360.resolution });
      track.attach(this.preview().nativeElement);
      this.room = new Room({ adaptiveStream: false, dynacast: false });
      await this.room.connect(url, token);
      await this.room.localParticipant.publishTrack(track, { simulcast: false, videoEncoding: { maxBitrate: 300_000, maxFramerate: 15 } });
      this.mode.set('live');
      this.state.set('Live. The situation room can see your camera.');
    } catch (e) {
      this.state.set('The connection is too weak for live video. Record a clip instead.');
      await this.ui.error(e);
    }
  }

  async recordClip() {
    try {
      await this.supa.rpc('answer_live_view', { p_id: this.id(), p_accept: true, p_mode: 'clip' }).catch(() => {});
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 480 }, audio: true });
      this.preview().nativeElement.srcObject = this.stream;
      const rec = new MediaRecorder(this.stream, { videoBitsPerSecond: 250_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      this.mode.set('recording');
      rec.start();
      await new Promise((r) => setTimeout(r, 25_000));
      rec.stop();
      await new Promise((r) => (rec.onstop = r));
      this.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
      this.state.set('Uploading clip…');
      const me = this.supa.me()!;
      const path = `${me.tenant_id}/live/${this.id()}.webm`;
      const { error } = await this.supa.client.storage.from('live-clips').upload(path, blob, { contentType: blob.type, upsert: true });
      if (error) throw new Error(error.message);
      await this.supa.fn('live-view', { action: 'end', request_id: this.id(), media_path: path });
      await this.ui.toast('Clip sent to the situation room');
      await this.router.navigateByUrl('/');
    } catch (e) { await this.ui.error(e); this.mode.set('choose'); }
  }

  async stop() {
    await this.room?.disconnect();
    await this.supa.fn('live-view', { action: 'end', request_id: this.id() }).catch(() => {});
    await this.router.navigateByUrl('/');
  }

  async decline() {
    await this.supa.rpc('answer_live_view', { p_id: this.id(), p_accept: false }).catch(() => {});
    await this.router.navigateByUrl('/');
  }

  ngOnDestroy() { void this.room?.disconnect(); this.stream?.getTracks().forEach((t) => t.stop()); }
}
