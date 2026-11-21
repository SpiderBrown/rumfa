import { Component, HostListener, Injectable, computed, inject, input, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Api } from './api';

/** What to ask /media/view-url for: an incident photo, a chat attachment, a live clip, an EC8A sheet… */
export type MediaRef = Record<string, unknown>;
export type MediaType = 'image' | 'video' | 'audio';
export interface MediaItem {
  ref: MediaRef;
  type: MediaType;
  /** Shown under the photo in the viewer: who sent it, when, where */
  caption?: string;
  meta?: { label: string; value: string }[];
}

/** image, video or audio, from a stored path or a message kind */
export function mediaType(pathOrKind?: string | null): MediaType {
  const s = (pathOrKind ?? '').toLowerCase();
  if (s === 'video' || /\.(mp4|webm|mov)$/.test(s)) return 'video';
  if (s === 'voice' || s === 'audio' || /\.(m4a|aac|ogg|mp3|wav)$/.test(s)) return 'audio';
  return 'image';
}

/** Signed view links, fetched once and reused for a few minutes (the server signs them for 5). */
@Injectable({ providedIn: 'root' })
export class MediaLinks {
  private api = inject(Api);
  private cache = new Map<string, { url: Promise<string>; at: number }>();
  url(ref: MediaRef): Promise<string> {
    const key = JSON.stringify(ref);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 4 * 60_000) return hit.url;
    const url = this.api.viewUrl(ref);
    url.catch(() => this.cache.delete(key));
    this.cache.set(key, { url, at: Date.now() });
    return url;
  }
}

/** Opens photos, videos and voice notes in a preview over the page. */
@Injectable({ providedIn: 'root' })
export class MediaViewer {
  private dialog = inject(MatDialog);
  open(items: MediaItem[], index = 0) {
    if (!items.length) return;
    this.dialog.open(MediaViewerDialog, {
      data: { items, index }, panelClass: 'media-viewer-panel', backdropClass: 'media-viewer-backdrop',
      maxWidth: '100vw', width: '100vw', height: '100vh', autoFocus: 'dialog', ariaLabel: 'Photo preview',
    });
  }
}

/** A small preview of one attachment; click to open the viewer at it. */
@Component({
  selector: 'app-media-thumb',
  imports: [MatIconModule],
  template: `
  <button type="button" class="thumb r-focus" [style.width.px]="size()" [style.height.px]="height()" (click)="open()"
          [attr.aria-label]="'Open ' + (item().type === 'image' ? 'photo' : item().type) + (item().caption ? ': ' + item().caption : '')">
    @if (failed()) { <span class="ph"><mat-icon>broken_image</mat-icon><small>Can't load</small></span> }
    @else if (item().type === 'image' && url()) { <img [src]="url()" alt="" loading="lazy" (error)="failed.set(true)" /> }
    @else if (item().type === 'video' && url()) { <video [src]="url() + '#t=0.1'" muted preload="metadata"></video><span class="play"><mat-icon>play_arrow</mat-icon></span> }
    @else if (item().type === 'audio') { <span class="ph"><mat-icon>graphic_eq</mat-icon><small>Voice note</small></span> }
    @else { <span class="ph loading"></span> }
  </button>`,
  styles: `
    :host { display: inline-block; }
    .thumb { position: relative; display: block; padding: 0; border: 1px solid var(--r-line); border-radius: 10px; overflow: hidden; background: #eef1f4; cursor: zoom-in; }
    .thumb:hover { border-color: var(--r-accent); box-shadow: 0 0 0 1px var(--r-accent); }
    img, video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ph { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: var(--r-muted); font-size: 11px; }
    .loading { background: linear-gradient(90deg, #eef1f4, #f7f8fa, #eef1f4); background-size: 200% 100%; animation: sh 1.2s infinite linear; }
    @keyframes sh { to { background-position: -200% 0; } }
    .play { position: absolute; inset: 0; display: grid; place-items: center; }
    .play mat-icon { background: rgba(0,0,0,.55); color: #fff; border-radius: 50%; width: 36px; height: 36px; font-size: 26px; display: grid; place-items: center; }
  `,
})
export class MediaThumb {
  private links = inject(MediaLinks);
  private viewer = inject(MediaViewer);
  /** The whole set this thumb belongs to, so the viewer can step through them */
  items = input.required<MediaItem[]>();
  index = input(0);
  size = input(120);
  height = input<number | undefined>(undefined);
  item = computed(() => this.items()[this.index()]);
  url = signal<string | null>(null);
  failed = signal(false);

  ngOnInit() {
    const it = this.item();
    if (it.type !== 'audio') this.links.url(it.ref).then((u) => this.url.set(u), () => this.failed.set(true));
  }
  open() { this.viewer.open(this.items(), this.index()); }
}

@Component({
  selector: 'app-media-viewer',
  imports: [MatDialogModule, MatIconModule],
  template: `
  <div class="viewer">
    <header>
      <b>{{ kindWord() }} {{ i() + 1 }} of {{ data.items.length }}</b>
      @if (cur().caption) { <span class="cap">{{ cur().caption }}</span> }
      <span class="grow"></span>
      @if (cur().type === 'image') {
        <button type="button" class="ib" (click)="zoom.set(!zoom())" [attr.aria-label]="zoom() ? 'Fit to screen' : 'Zoom in'"><mat-icon>{{ zoom() ? 'zoom_out' : 'zoom_in' }}</mat-icon></button>
        <button type="button" class="ib" (click)="rotate()" aria-label="Rotate"><mat-icon>rotate_right</mat-icon></button>
      }
      @if (url()) { <a class="ib" [href]="url()" target="_blank" rel="noopener" aria-label="Open the original in a new tab"><mat-icon>open_in_new</mat-icon></a> }
      <button type="button" class="ib" (click)="ref.close()" aria-label="Close"><mat-icon>close</mat-icon></button>
    </header>
    <div class="stage" [class.zoomed]="zoom()">
      @if (data.items.length > 1) {
        <button type="button" class="nav prev" (click)="step(-1)" aria-label="Previous"><mat-icon>chevron_left</mat-icon></button>
        <button type="button" class="nav next" (click)="step(1)" aria-label="Next"><mat-icon>chevron_right</mat-icon></button>
      }
      <div class="media">
      @if (failed()) { <p class="msg">This file couldn't be loaded. It may still be uploading from the agent's phone.</p> }
      @else if (!url()) { <p class="msg">Loading…</p> }
      @else if (cur().type === 'image') { <img [src]="url()" [alt]="cur().caption ?? 'Photo'" [style.transform]="'rotate(' + turn() + 'deg)'" (click)="zoom.set(!zoom())" (error)="failed.set(true)" /> }
      @else if (cur().type === 'video') { <video [src]="url()" controls autoplay playsinline></video> }
      @else { <audio [src]="url()" controls autoplay></audio> }
      </div>
      @if (cur().meta?.length) {
        <aside>@for (m of cur().meta; track m.label) { <div><small>{{ m.label }}</small><span>{{ m.value }}</span></div> }</aside>
      }
    </div>
    @if (data.items.length > 1) {
      <footer>
        @for (it of data.items; track $index) {
          <button type="button" class="mini" [class.on]="$index === i()" (click)="go($index)" [attr.aria-label]="'Show ' + ($index + 1)">
            @if (it.type === 'image' && minis()[$index]) { <img [src]="minis()[$index]" alt="" /> } @else { <mat-icon>{{ it.type === 'video' ? 'movie' : it.type === 'audio' ? 'graphic_eq' : 'image' }}</mat-icon> }
          </button>
        }
      </footer>
    }
  </div>`,
  styles: `
    :host { display: block; height: 100%; }
    .viewer { height: 100%; display: flex; flex-direction: column; background: #0b0f16; color: #fff; }
    header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #1e2836; }
    .cap { color: #9aa6b6; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .grow { flex: 1; }
    .ib { display: inline-grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; border: 0; background: none; color: #fff; cursor: pointer; text-decoration: none; }
    .ib:hover, .ib:focus-visible { background: #1e2836; outline: none; }
    .stage { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; padding: 20px 72px; gap: 20px; }
    .media { flex: 1; min-width: 0; height: 100%; display: flex; align-items: center; justify-content: center; }
    .media img { width: 100%; height: 100%; object-fit: contain; cursor: zoom-in; transition: transform .2s; }
    .stage.zoomed .media { overflow: auto; display: block; }
    .stage.zoomed .media img { width: auto; height: auto; min-width: 200%; cursor: zoom-out; }
    .media video { max-width: 100%; max-height: 100%; }
    .msg { color: #9aa6b6; }
    .nav { position: absolute; top: 50%; transform: translateY(-50%); width: 46px; height: 46px; border-radius: 50%; border: 0; background: #1e2836; color: #fff; display: grid; place-items: center; cursor: pointer; z-index: 1; }
    .nav:hover, .nav:focus-visible { background: #2b3a4e; outline: none; }
    .prev { left: 16px; } .next { right: 16px; }
    aside { flex: none; width: 240px; align-self: center; display: flex; flex-direction: column; gap: 12px; background: #121a24; border-radius: 10px; padding: 14px; }
    aside small { display: block; color: #8693a4; font-size: 11.5px; } aside span { font-weight: 600; font-size: 13.5px; }
    footer { display: flex; gap: 8px; padding: 10px 16px; border-top: 1px solid #1e2836; overflow-x: auto; }
    .mini { flex: none; width: 76px; height: 52px; border-radius: 6px; border: 2px solid transparent; padding: 0; overflow: hidden; background: #1e2836; color: #9aa6b6; cursor: pointer; display: grid; place-items: center; }
    .mini.on { border-color: #2dd4bf; } .mini img { width: 100%; height: 100%; object-fit: cover; }
  `,
})
export class MediaViewerDialog {
  data = inject<{ items: MediaItem[]; index: number }>(MAT_DIALOG_DATA);
  ref = inject(MatDialogRef<MediaViewerDialog>);
  private links = inject(MediaLinks);
  i = signal(this.data.index);
  cur = computed(() => this.data.items[this.i()]);
  url = signal<string | null>(null);
  failed = signal(false);
  zoom = signal(false);
  turn = signal(0);
  minis = signal<(string | null)[]>([]);
  kindWord = computed(() => ({ image: 'Photo', video: 'Video', audio: 'Voice note' })[this.cur().type]);

  constructor() {
    this.load();
    this.data.items.forEach((it, n) => {
      if (it.type === 'image') this.links.url(it.ref).then((u) => this.minis.update((m) => { const c = [...m]; c[n] = u; return c; }), () => {});
    });
  }

  private load() {
    this.url.set(null); this.failed.set(false); this.zoom.set(false); this.turn.set(0);
    const at = this.i();
    this.links.url(this.cur().ref).then((u) => { if (this.i() === at) this.url.set(u); }, () => { if (this.i() === at) this.failed.set(true); });
  }
  go(n: number) { this.i.set(n); this.load(); }
  step(d: number) { const n = this.data.items.length; this.go((this.i() + d + n) % n); }
  rotate() { this.turn.update((t) => (t + 90) % 360); }

  @HostListener('document:keydown', ['$event'])
  key(e: KeyboardEvent) {
    if (e.key === 'ArrowRight') { this.step(1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { this.step(-1); e.preventDefault(); }
  }
}

/** A small photo from a stored file, for lists (a case's first photo). Not clickable: the row opens the case. */
@Component({
  selector: 'app-ref-img',
  template: `@if (url(); as u) { <img [src]="u" alt="" loading="lazy" (error)="url.set(null)" /> } @else { <span class="ph" aria-hidden="true"></span> }`,
  styles: `:host { display: block; width: var(--w, 88px); height: var(--h, 66px); border-radius: 8px; overflow: hidden; background: #eef1f4; flex: none; }
    img { width: 100%; height: 100%; object-fit: cover; display: block; } .ph { display: block; width: 100%; height: 100%; }`,
})
export class RefImg {
  private links = inject(MediaLinks);
  ref = input.required<MediaRef>();
  url = signal<string | null>(null);
  ngOnInit() { this.links.url(this.ref()).then((u) => this.url.set(u), () => this.url.set(null)); }
}
