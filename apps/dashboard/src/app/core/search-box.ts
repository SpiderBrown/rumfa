import { Component, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { Api } from './api';
import { label } from './ui';

interface Found {
  cases: { id: string; what: string; where: string; severity: string; status: string }[];
  people: { id: string; full_name: string; role: string; level: string; area_code: string; phone: string }[];
  places: { code: string; name: string; level: 'pu' | 'ward' | 'lga' | 'state'; parent: string | null }[];
}
interface Hit { kind: 'case' | 'person' | 'place'; title: string; sub: string; icon: string; go: () => void }

const LEVEL: Record<string, string> = { pu: 'Polling unit', ward: 'Ward', lga: 'LGA', state: 'State' };

/** The top bar's search: cases, people and places in one box. "/" focuses it; arrows and Return pick. */
@Component({
  selector: 'app-search-box',
  imports: [MatIconModule],
  template: `
  <div class="box" [class.open]="open() && q().length >= 2">
    <mat-icon aria-hidden="true">search</mat-icon>
    <input #inp type="search" placeholder="Search cases, people, polling units" aria-label="Search cases, people and polling units"
      [value]="q()" (input)="type($any($event.target).value)" (focus)="open.set(true)" (keydown)="key($event)" autocomplete="off" />
    @if (!q()) { <kbd aria-hidden="true">/</kbd> }
    @if (open() && q().length >= 2) {
      <div class="drop" role="listbox">
        @if (busy() && !hits().length) { <p class="muted">Searching…</p> }
        @for (g of groups(); track g.name) {
          <p class="g">{{ g.name }}</p>
          @for (h of g.hits; track $index) {
            <button role="option" class="hit" [class.on]="h === hits()[sel()]" (mousedown)="$event.preventDefault()" (click)="pick(h)">
              <mat-icon>{{ h.icon }}</mat-icon><span class="t"><b>{{ h.title }}</b><span class="muted">{{ h.sub }}</span></span></button>
          }
        }
        @if (!busy() && !hits().length) { <p class="muted">Nothing found for "{{ q() }}"</p> }
      </div>
    }
  </div>`,
  styles: `
    :host { display: block; width: min(420px, 40vw); }
    .box { position: relative; display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px; border: 1px solid var(--r-line); border-radius: 10px; background: #f7f8fa; }
    .box:focus-within { background: #fff; border-color: var(--r-accent); box-shadow: 0 0 0 3px rgba(15, 118, 110, .12); }
    .box mat-icon { color: var(--r-muted); font-size: 20px; width: 20px; height: 20px; }
    input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font: inherit; font-size: 14px; color: var(--r-ink); }
    kbd { font: inherit; font-size: 11px; color: var(--r-muted); border: 1px solid var(--r-line); border-radius: 4px; padding: 0 5px; }
    .drop { position: absolute; top: 44px; left: 0; right: 0; z-index: 30; background: #fff; border: 1px solid var(--r-line); border-radius: 12px;
      box-shadow: 0 12px 30px rgba(20, 23, 31, .14); padding: 6px; max-height: 70vh; overflow: auto; }
    .g { margin: 8px 8px 2px; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--r-muted); }
    .hit { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: none; text-align: left; padding: 7px 8px; border-radius: 8px; font: inherit; cursor: pointer; color: var(--r-ink); }
    .hit.on, .hit:hover { background: var(--r-accent-soft); }
    .hit mat-icon { color: var(--r-ink-2); font-size: 20px; width: 20px; height: 20px; flex: none; }
    .t { display: flex; flex-direction: column; min-width: 0; } .t b { font-size: 13.5px; } .t span { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: var(--r-muted); } p.muted { margin: 8px; font-size: 13px; }
  `,
})
export class SearchBox {
  private api = inject(Api);
  private router = inject(Router);
  private host = inject(ElementRef<HTMLElement>);
  private inp = viewChild.required<ElementRef<HTMLInputElement>>('inp');
  q = signal('');
  open = signal(false);
  busy = signal(false);
  sel = signal(0);
  private found = signal<Found>({ cases: [], people: [], places: [] });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private asked = '';

  groups = computed(() => {
    const f = this.found();
    const cases: Hit[] = f.cases.map((c) => ({ kind: 'case', icon: 'report', title: c.what, sub: `${c.where} · ${label(c.severity)} · ${label(c.status)}`,
      go: () => void this.router.navigate(['/room/case', c.id]) }));
    const people: Hit[] = f.people.map((p) => ({ kind: 'person', icon: 'person', title: p.full_name, sub: `${label(p.role)} · ${p.area_code} · ${p.phone}`,
      go: () => void this.router.navigate(['/people'], { queryParams: { q: p.full_name } }) }));
    const places: Hit[] = f.places.map((p) => ({ kind: 'place', icon: p.level === 'pu' ? 'how_to_vote' : 'place', title: p.name,
      sub: `${LEVEL[p.level]}${p.parent ? ' · ' + p.parent : ''} · ${p.code}`,
      go: () => void this.router.navigate(['/election-day'], { queryParams: { area: p.level === 'pu' ? p.code.slice(0, 8) : p.code } }) }));
    return [{ name: 'Cases', hits: cases }, { name: 'People', hits: people }, { name: 'Places', hits: places }].filter((g) => g.hits.length);
  });
  hits = computed(() => this.groups().flatMap((g) => g.hits));

  /** "/" anywhere (not while typing) focuses the box */
  @HostListener('document:keydown', ['$event'])
  slash(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && !t.isContentEditable) { e.preventDefault(); this.inp().nativeElement.focus(); }
  }
  @HostListener('document:click', ['$event'])
  away(e: MouseEvent) { if (!this.host.nativeElement.contains(e.target as Node)) this.open.set(false); }

  type(v: string) {
    this.q.set(v); this.open.set(true); this.sel.set(0);
    if (this.timer) clearTimeout(this.timer);
    if (v.trim().length < 2) { this.found.set({ cases: [], people: [], places: [] }); return; }
    this.timer = setTimeout(() => void this.search(v.trim()), 250);
  }
  private async search(v: string) {
    this.asked = v; this.busy.set(true);
    const r = await this.api.get<Found>('/search', { q: v }).catch(() => null);
    if (this.asked !== v) return;
    this.busy.set(false);
    if (r) this.found.set(r);
  }
  key(e: KeyboardEvent) {
    const n = this.hits().length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); this.sel.set((this.sel() + 1) % n); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); this.sel.set((this.sel() - 1 + n) % n); }
    else if (e.key === 'Enter' && n) { e.preventDefault(); this.pick(this.hits()[this.sel()]); }
    else if (e.key === 'Escape') { this.open.set(false); this.inp().nativeElement.blur(); }
  }
  pick(h: Hit) { h.go(); this.open.set(false); this.q.set(''); this.found.set({ cases: [], people: [], places: [] }); this.inp().nativeElement.blur(); }
}
