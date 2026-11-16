import { Component, ElementRef, OnDestroy, effect, input, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

type PdfDoc = { numPages: number; getPage(n: number): Promise<any>; destroy(): Promise<void> };

/**
 * Shows a result sheet for review: a photo as an image, a PDF (as IReV publishes many sheets) drawn page by page
 * with pdf.js. Zoom in to read small handwriting; drag or scroll to move around. pdf.js loads only when a PDF is shown.
 */
@Component({
  selector: 'app-sheet-viewer',
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
  <div class="bar">
    <button mat-icon-button (click)="zoomBy(-0.25)" [disabled]="zoom() <= 0.5" matTooltip="Zoom out"><mat-icon>zoom_out</mat-icon></button>
    <span class="z">{{ (zoom() * 100).toFixed(0) }}%</span>
    <button mat-icon-button (click)="zoomBy(0.25)" [disabled]="zoom() >= 4" matTooltip="Zoom in"><mat-icon>zoom_in</mat-icon></button>
    <button mat-icon-button (click)="zoom.set(1)" matTooltip="Fit width"><mat-icon>fit_screen</mat-icon></button>
    <button mat-icon-button (click)="rotate.set((rotate() + 90) % 360)" matTooltip="Rotate (many sheets are photographed sideways)"><mat-icon>rotate_right</mat-icon></button>
    @if (pages() > 1) {
      <span class="spacer"></span>
      <button mat-icon-button (click)="go(page() - 1)" [disabled]="page() <= 1" matTooltip="Previous page"><mat-icon>chevron_left</mat-icon></button>
      <span class="z">Page {{ page() }} of {{ pages() }}</span>
      <button mat-icon-button (click)="go(page() + 1)" [disabled]="page() >= pages()" matTooltip="Next page"><mat-icon>chevron_right</mat-icon></button>
    }
    <span class="spacer"></span>
    @if (url()) { <a mat-icon-button [href]="url()" target="_blank" rel="noopener" matTooltip="Open in a new tab"><mat-icon>open_in_new</mat-icon></a> }
  </div>
  <div class="view" #view>
    @switch (state()) {
      @case ('loading') { <p class="msg">Loading sheet…</p> }
      @case ('error') { <p class="msg bad">{{ error() }}</p> }
    }
    @if (kind() === 'image' && objectUrl()) {
      <img [src]="objectUrl()" alt="Result sheet" [style.width.%]="zoom() * 100" [style.transform]="'rotate(' + rotate() + 'deg)'"
        [style.transform-origin]="'center'" />
    }
    <canvas #canvas [hidden]="kind() !== 'pdf' || state() !== 'ready'"></canvas>
  </div>`,
  styles: `
    :host { display: block; }
    .bar { display: flex; align-items: center; gap: 2px; border: 1px solid var(--mat-sys-outline-variant); border-bottom: 0; padding: 0 4px;
      background: var(--mat-sys-surface-container); border-radius: 8px 8px 0 0; }
    .z { font-size: 13px; min-width: 44px; text-align: center; } .spacer { flex: 1; }
    .view { overflow: auto; max-height: 78vh; border: 1px solid var(--mat-sys-outline-variant); border-radius: 0 0 8px 8px; background: #f4f4f5; }
    img, canvas { display: block; max-width: none; } canvas { width: auto; }
    .msg { padding: 24px; color: var(--mat-sys-on-surface-variant); } .bad { color: #b3261e; }
  `,
})
export class SheetViewer implements OnDestroy {
  /** A signed link to the sheet (image or PDF) */
  url = input<string | null>(null);
  private view = viewChild.required<ElementRef<HTMLDivElement>>('view');
  private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  kind = signal<'image' | 'pdf' | null>(null);
  state = signal<'loading' | 'ready' | 'error'>('loading');
  error = signal('');
  objectUrl = signal<string | null>(null);
  zoom = signal(1);
  rotate = signal(0);
  page = signal(1);
  pages = signal(0);
  private pdf: PdfDoc | null = null;
  private task: { cancel(): void } | null = null;
  private loadId = 0;

  constructor() {
    effect(() => { void this.open(this.url()); });
    // Redraw the PDF page whenever the page or zoom changes
    effect(() => { const p = this.page(), z = this.zoom(), r = this.rotate(); if (this.kind() === 'pdf' && this.pdf) void this.draw(p, z, r); });
  }

  ngOnDestroy() { this.reset(); }

  zoomBy(d: number) { this.zoom.set(Math.min(4, Math.max(0.5, +(this.zoom() + d).toFixed(2)))); }
  go(n: number) { if (n >= 1 && n <= this.pages()) this.page.set(n); }

  private reset() {
    this.task?.cancel(); this.task = null;
    void this.pdf?.destroy(); this.pdf = null;
    const o = this.objectUrl(); if (o) URL.revokeObjectURL(o);
    this.objectUrl.set(null); this.kind.set(null); this.pages.set(0); this.page.set(1); this.zoom.set(1); this.rotate.set(0);
  }

  private async open(url: string | null) {
    const id = ++this.loadId;
    this.reset();
    if (!url) { this.state.set('loading'); return; }
    this.state.set('loading');
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status === 404 ? 'The sheet file is missing.' : `Could not load the sheet (${res.status}).`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (id !== this.loadId) return;
      const isPdf = (res.headers.get('content-type') ?? '').includes('pdf') || String.fromCharCode(...bytes.subarray(0, 4)) === '%PDF';
      if (!isPdf) {
        this.objectUrl.set(URL.createObjectURL(new Blob([bytes], { type: res.headers.get('content-type') || 'image/jpeg' })));
        this.kind.set('image');
        this.state.set('ready');
        return;
      }
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.mjs';
      const doc = (await pdfjs.getDocument({ data: bytes }).promise) as unknown as PdfDoc;
      if (id !== this.loadId) { void doc.destroy(); return; }
      this.pdf = doc;
      this.pages.set(doc.numPages);
      this.kind.set('pdf');
      await this.draw(1, this.zoom(), this.rotate());
    } catch (e) {
      if (id !== this.loadId) return;
      this.error.set((e as Error).message || 'Could not show this sheet. Use "Open in a new tab".');
      this.state.set('error');
    }
  }

  /** Draws a page sharp for the screen: fit to the viewer's width, times the zoom, at the screen's pixel density. */
  private async draw(n: number, zoom: number, rotate: number) {
    if (!this.pdf) return;
    const page = await this.pdf.getPage(n);
    const rotation = (page.rotate + rotate) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const width = Math.max(320, this.view().nativeElement.clientWidth - 2);
    const cssScale = (width / base.width) * zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: cssScale * dpr, rotation });
    const c = this.canvas().nativeElement;
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = `${Math.floor(vp.width / dpr)}px`; c.style.height = `${Math.floor(vp.height / dpr)}px`;
    this.task?.cancel();
    const task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp });
    this.task = task;
    try { await task.promise; this.state.set('ready'); }
    catch (e) { if ((e as Error)?.name !== 'RenderingCancelledException') { this.error.set('Could not draw this page.'); this.state.set('error'); } }
  }
}
