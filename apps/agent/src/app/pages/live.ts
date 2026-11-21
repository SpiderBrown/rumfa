import { Component, ElementRef, OnDestroy, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular';
import { I18n } from '../core/i18n';
import { Api } from '../core/api';
import { Ui } from '../core/ui';

/**
 * Live view: one-way video from this phone (240-360p) to the situation room.
 * On a weak connection, record a 20-30 second clip instead and upload it when possible.
 */
@Component({
  selector: 'page-live',
  imports: [IonContent, IonIcon],
  template: `
  <ion-content [fullscreen]="true" class="black">
    <div class="stage">
      <video #preview autoplay playsinline muted class="v"></video>

      <div class="top">
        @switch (mode()) {
          @case ('live') { <span class="pill live"><i></i>LIVE {{ clock() }}</span><span class="pill"><ion-icon name="eye" />{{ t('Situation room') }}</span> }
          @case ('recording') { <span class="pill live"><i></i>{{ t('Recording') }} {{ left() }}s</span> }
          @default { <span class="pill"><ion-icon name="videocam" />{{ t('Live view request') }}</span> }
        }
      </div>

      @if (mode() === 'choose') {
        <div class="sheet">
          <span class="ico red"><ion-icon name="videocam" /></span>
          <h2>{{ t('The situation room wants to see your polling unit') }}</h2>
          <p>{{ t('Point the phone at what is happening. Only video is sent, at low quality to save data.') }}</p>
          <button class="primary" (click)="goLive()"><ion-icon name="videocam" />{{ t('Start live video') }}</button>
          <button class="ghost" (click)="recordClip()"><ion-icon name="radio-button-on" />{{ t('Weak network? Record a 25-second clip') }}</button>
          <button class="link" (click)="decline()">{{ t('Not now') }}</button>
        </div>
      } @else {
        <p class="hint">{{ state() }}</p>
        @if (mode() === 'recording') {
          <div class="ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" /><circle class="p" cx="18" cy="18" r="16" [attr.stroke-dasharray]="(left() / 25) * 100.5 + ' 100.5'" /></svg>
            <b>{{ left() }}</b></div>
        }
        @if (mode() === 'live') {
          <div class="controls">
            <button class="round" (click)="flip()" [attr.aria-label]="t('Switch camera')"><ion-icon name="camera-reverse" /></button>
            <button class="round end" (click)="stop()" [attr.aria-label]="t('Stop')"><ion-icon name="stop-circle" /></button>
            <span class="round ghost"></span>
          </div>
        }
      }
    </div>
  </ion-content>`,
  styles: `
    .black { --background: #000; }
    .stage { position: relative; height: 100%; color: #fff; }
    .v { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
    .top { position: absolute; top: calc(14px + env(safe-area-inset-top)); left: 14px; right: 14px; display: flex; justify-content: space-between; gap: 8px; }
    .pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: rgba(0,0,0,.55); font-size: 13px; font-weight: 700; }
    .pill.live { background: #b3261e; } .pill.live i { width: 8px; height: 8px; border-radius: 50%; background: #fff; animation: blink 1s infinite; }
    @keyframes blink { 50% { opacity: .2; } }
    .sheet { position: absolute; left: 0; right: 0; bottom: 0; background: #fff; color: var(--r-ink); border-radius: 26px 26px 0 0;
      padding: 22px 18px calc(18px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; }
    .sheet .ico { width: 56px; height: 56px; border-radius: 18px; } .sheet .ico ion-icon { font-size: 30px; }
    .sheet h2 { margin: 4px 0 0; font-size: 20px; } .sheet p { margin: 0 0 6px; color: var(--r-muted); }
    .primary, .ghost { width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 15px; border-radius: 16px; font: inherit; font-size: 16px; font-weight: 800; }
    .primary { border: 0; background: #b3261e; color: #fff; } .ghost { border: 1.5px solid #d5dae1; background: #fff; color: var(--r-ink); }
    .link { border: 0; background: none; color: var(--r-muted); font: inherit; font-weight: 700; padding: 8px; }
    .hint { position: absolute; left: 16px; right: 16px; bottom: calc(130px + env(safe-area-inset-bottom)); text-align: center; margin: 0;
      background: rgba(0,0,0,.5); padding: 10px 14px; border-radius: 14px; font-size: 14px; }
    .controls { position: absolute; left: 0; right: 0; bottom: calc(28px + env(safe-area-inset-bottom)); display: flex; justify-content: center; gap: 34px; }
    .round { width: 62px; height: 62px; border-radius: 50%; border: 0; background: rgba(255,255,255,.18); color: #fff; display: grid; place-items: center; font-size: 28px; }
    .round.end { background: #b3261e; width: 74px; height: 74px; font-size: 34px; } .round.ghost { background: none; }
    .ring { position: absolute; left: 50%; bottom: calc(30px + env(safe-area-inset-bottom)); transform: translateX(-50%); width: 80px; height: 80px; display: grid; place-items: center; }
    .ring svg { position: absolute; inset: 0; transform: rotate(-90deg); } .ring circle { fill: none; stroke: rgba(255,255,255,.25); stroke-width: 3; }
    .ring circle.p { stroke: #fff; transition: stroke-dasharray 1s linear; } .ring b { font-size: 24px; }
  `,
})
export default class LivePage implements OnDestroy {
  id = input.required<string>();
  private api = inject(Api);
  private ui = inject(Ui);
  private router = inject(Router);
  private preview = viewChild.required<ElementRef<HTMLVideoElement>>('preview');
  t = inject(I18n).t;
  mode = signal<'choose' | 'live' | 'recording'>('choose');
  /** Time live (m:ss), and seconds left while recording a clip */
  clock = signal('0:00');
  left = signal(25);
  private ticker: ReturnType<typeof setInterval> | null = null;
  private track: any;
  private facing: 'environment' | 'user' = 'environment';
  private tick(fn: () => void) { if (this.ticker) clearInterval(this.ticker); this.ticker = setInterval(fn, 1000); }
  /** Front or back camera while live */
  async flip() {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    try { await this.track?.restartTrack({ facingMode: this.facing }); } catch (e) { await this.ui.error(e); }
  }
  state = signal('The situation room wants to see your polling unit.');
  private room: any;
  private stream?: MediaStream;

  async goLive() {
    try {
      await this.api.post(`/live-view/${this.id()}/answer`, { accept: true, mode: 'live' }).catch(() => {});
      const { Room, createLocalVideoTrack, VideoPresets } = await import('livekit-client');
      const { url, token } = await this.api.post<{ url: string; token: string }>(`/live-view/${this.id()}/publish-token`);
      const track = await createLocalVideoTrack({ facingMode: 'environment', resolution: VideoPresets.h360.resolution });
      this.track = track;
      track.attach(this.preview().nativeElement);
      this.room = new Room({ adaptiveStream: false, dynacast: false });
      await this.room.connect(url, token);
      await this.room.localParticipant.publishTrack(track, { simulcast: false, videoEncoding: { maxBitrate: 300_000, maxFramerate: 15 } });
      this.mode.set('live');
      this.state.set(this.t('Live. The situation room can see your camera. Point it at what is happening.'));
      const start = Date.now();
      this.tick(() => { const sec = Math.floor((Date.now() - start) / 1000); this.clock.set(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`); });
    } catch (e) {
      this.state.set('The connection is too weak for live video. Record a clip instead.');
      await this.ui.error(e);
    }
  }

  async recordClip() {
    try {
      await this.api.post(`/live-view/${this.id()}/answer`, { accept: true, mode: 'clip' }).catch(() => {});
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 480 }, audio: true });
      this.preview().nativeElement.srcObject = this.stream;
      const rec = new MediaRecorder(this.stream, { videoBitsPerSecond: 250_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      this.mode.set('recording');
      this.state.set(this.t('Recording… keep the phone steady.'));
      this.left.set(25);
      this.tick(() => this.left.update((n) => Math.max(0, n - 1)));
      rec.start();
      await new Promise((r) => setTimeout(r, 25_000));
      rec.stop();
      await new Promise((r) => (rec.onstop = r));
      this.stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' });
      if (this.ticker) clearInterval(this.ticker);
      this.state.set(this.t('Uploading clip…'));
      const path = await this.api.upload('live_clip', blob, blob.type.includes('mp4') ? 'mp4' : 'webm');
      await this.api.post(`/live-view/${this.id()}/end`, { mediaPath: path });
      await this.ui.toast('Clip sent to the situation room');
      await this.router.navigateByUrl('/');
    } catch (e) { await this.ui.error(e); this.mode.set('choose'); }
  }

  async stop() {
    await this.room?.disconnect();
    await this.api.post(`/live-view/${this.id()}/end`, {}).catch(() => {});
    await this.router.navigateByUrl('/');
  }

  async decline() {
    await this.api.post(`/live-view/${this.id()}/answer`, { accept: false }).catch(() => {});
    await this.router.navigateByUrl('/');
  }

  ngOnDestroy() { if (this.ticker) clearInterval(this.ticker); void this.room?.disconnect(); this.stream?.getTracks().forEach((t) => t.stop()); }
}
