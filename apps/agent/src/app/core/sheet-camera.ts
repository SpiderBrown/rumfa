import { Component, ElementRef, OnDestroy, OnInit, inject, input, output, signal, viewChild } from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { I18n } from './i18n';
import { shrink, takeSheetPhoto } from './photo';

export interface SheetShot { original: Blob; small: Blob; url: string }

/**
 * The in-app camera for the result sheet: a live preview with a frame to line the sheet up in, the torch, then
 * "Use this photo?" before it is kept. Time and place are printed on the photo. If the phone's browser cannot show
 * a live camera, it falls back to the phone's own camera app.
 */
@Component({
  selector: 'sheet-camera',
  imports: [IonIcon],
  template: `
  <div class="cam">
    @if (!shot()) {
      <video #video autoplay playsinline muted></video>
      <div class="top">
        <button class="round" (click)="closed.emit()" [attr.aria-label]="t('Close')"><ion-icon name="close" /></button>
        <span class="pill"><ion-icon name="location" /> {{ place() }}@if (accuracy()) { · ±{{ accuracy() }} m }</span>
        @if (torchOk()) { <button class="round" (click)="toggleTorch()" [attr.aria-label]="t('Light')"><ion-icon [name]="torch() ? 'flash' : 'flash-off'" /></button> }
        @else { <span class="round ghost"></span> }
      </div>
      <div class="frame"><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
        <span class="tip">{{ t('Fit the whole sheet inside the frame') }}</span></div>
      <p class="stamp">Rumfa · {{ clock() }} · {{ label() }} · {{ t('printed on the photo') }}</p>
      <div class="bottom">
        <button class="alt" (click)="fallback()">{{ t('Phone camera') }}</button>
        <button class="shutter" (click)="capture()" [disabled]="!ready()" [attr.aria-label]="t('Take photo')"><span></span></button>
        <span class="alt"></span>
      </div>
      @if (error()) { <p class="err">{{ error() }}</p> }
    } @else {
      <img class="review" [src]="shot()!.url" alt="" />
      <p class="saved"><ion-icon name="shield-checkmark" /> {{ t('Time and place saved with the photo') }}</p>
      <p class="q">{{ t('Can you read every figure?') }}</p>
      <div class="bottom two">
        <button class="ghostbtn" (click)="retake()"><ion-icon name="refresh" />{{ t('Retake') }}</button>
        <button class="use" (click)="use()"><ion-icon name="checkmark" />{{ t('Use photo') }}</button>
      </div>
    }
  </div>`,
  styles: `
    .cam { position: fixed; inset: 0; z-index: 1000; background: #000; color: #fff; display: flex; flex-direction: column; }
    video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .top { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: calc(12px + env(safe-area-inset-top)) 14px 10px; }
    .round { width: 42px; height: 42px; border-radius: 50%; border: 0; background: rgba(0,0,0,.45); color: #fff; display: grid; place-items: center; font-size: 22px; }
    .round.ghost { background: none; }
    .pill { display: flex; align-items: center; gap: 4px; background: rgba(0,0,0,.5); padding: 6px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
    .frame { position: relative; flex: 1; margin: 10px 26px; }
    .c { position: absolute; width: 34px; height: 34px; border: 4px solid #fbbf24; }
    .tl { top: 0; left: 0; border-right: 0; border-bottom: 0; border-radius: 10px 0 0 0; } .tr { top: 0; right: 0; border-left: 0; border-bottom: 0; border-radius: 0 10px 0 0; }
    .bl { bottom: 0; left: 0; border-right: 0; border-top: 0; border-radius: 0 0 0 10px; } .br { bottom: 0; right: 0; border-left: 0; border-top: 0; border-radius: 0 0 10px 0; }
    .tip { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,.5); padding: 6px 12px; border-radius: 999px; font-size: 13px; white-space: nowrap; }
    .stamp { position: relative; margin: 0 16px; text-align: center; font-size: 12px; opacity: .85; }
    .bottom { position: relative; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 16px 20px calc(20px + env(safe-area-inset-bottom)); }
    .alt { font: inherit; font-size: 13px; font-weight: 700; color: #fff; background: none; border: 0; justify-self: start; }
    .shutter { width: 78px; height: 78px; border-radius: 50%; border: 4px solid #fff; background: none; padding: 5px; }
    .shutter span { display: block; width: 100%; height: 100%; border-radius: 50%; background: #fff; } .shutter:active span { background: #e5e7eb; }
    .shutter:disabled { opacity: .4; }
    .err { position: absolute; left: 16px; right: 16px; top: 45%; text-align: center; background: rgba(0,0,0,.7); padding: 12px; border-radius: 12px; }
    .review { flex: 1; min-height: 0; width: 100%; object-fit: contain; margin-top: env(safe-area-inset-top); }
    .saved { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 10px 0 0; font-size: 13px; color: #86efac; }
    .q { text-align: center; margin: 6px 0 0; font-weight: 700; font-size: 17px; }
    .bottom.two { grid-template-columns: 1fr 1fr; gap: 12px; }
    .ghostbtn, .use { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 15px; border-radius: 16px; font: inherit; font-weight: 800; font-size: 16px; }
    .ghostbtn { background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.3); } .use { background: #0f766e; color: #fff; border: 0; }
  `,
})
export class SheetCamera implements OnInit, OnDestroy {
  /** Printed on the photo, e.g. "PU 006 Agalawa" */
  label = input('');
  taken = output<SheetShot>();
  closed = output<void>();
  t = inject(I18n).t;
  private video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private stream: MediaStream | null = null;
  ready = signal(false);
  error = signal('');
  shot = signal<SheetShot | null>(null);
  torch = signal(false);
  torchOk = signal(false);
  accuracy = signal<number | null>(null);
  private coords: GeolocationCoordinates | null = null;
  clock = signal(this.now());
  private tick = setInterval(() => this.clock.set(this.now()), 1000);
  place = () => this.label() || this.t('Your polling unit');

  ngOnInit() {
    void this.start();
    navigator.geolocation?.getCurrentPosition((p) => { this.coords = p.coords; this.accuracy.set(Math.round(p.coords.accuracy)); },
      () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  ngOnDestroy() { this.stop(); clearInterval(this.tick); }

  private now() { return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

  private async start() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
      // The view child appears after the first render
      await new Promise((r) => setTimeout(r));
      const v = this.video()?.nativeElement;
      if (!v) return;
      v.srcObject = this.stream;
      await v.play().catch(() => undefined);
      this.ready.set(true);
      const caps = (this.stream.getVideoTracks()[0]?.getCapabilities?.() ?? {}) as { torch?: boolean };
      this.torchOk.set(!!caps.torch);
    } catch {
      this.error.set(this.t('The live camera is not available on this phone. Use the phone camera instead.'));
    }
  }
  private stop() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; this.ready.set(false); }

  async toggleTorch() {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return;
    const on = !this.torch();
    try { await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }); this.torch.set(on); } catch { this.torchOk.set(false); }
  }

  /** Full-resolution frame with time and place printed along the bottom */
  async capture() {
    const v = this.video()?.nativeElement;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0);
    this.stampOn(g, c.width, c.height);
    const original = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.92));
    if (!original) return;
    navigator.vibrate?.(20);
    this.stop();
    this.shot.set({ original, small: await shrink(original, 1280, 0.6), url: URL.createObjectURL(original) });
  }

  private stampOn(g: CanvasRenderingContext2D, w: number, h: number) {
    const size = Math.max(14, Math.round(w / 55));
    const where = this.coords ? ` · ${this.coords.latitude.toFixed(5)}, ${this.coords.longitude.toFixed(5)} ±${Math.round(this.coords.accuracy)} m` : '';
    const text = `Rumfa · ${new Date().toLocaleString('en-GB')} · ${this.label()}${where}`;
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(0, h - size * 2, w, size * 2);
    g.fillStyle = '#fff';
    g.font = `600 ${size}px sans-serif`;
    g.textBaseline = 'middle';
    g.fillText(text, size * 0.6, h - size, w - size * 1.2);
  }

  async retake() {
    const s = this.shot();
    if (s) URL.revokeObjectURL(s.url);
    this.shot.set(null);
    await this.start();
  }
  use() { const s = this.shot(); if (s) this.taken.emit(s); }

  /** The phone's own camera app (no live frame or printed stamp) */
  async fallback() {
    this.stop();
    const p = await takeSheetPhoto();
    if (p) this.shot.set(p); else await this.start();
  }
}
