import { Injectable, NgZone, Pipe, PipeTransform, inject, signal } from '@angular/core';

/**
 * One shared clock for every "x ago" label, so they move on their own without a refresh.
 * Two signals keep it cheap: labels under a minute old follow `sec` (every second); older ones
 * follow `min` (every 30 s), so a screen of old timestamps redraws twice a minute, not every second.
 * Only screens that show a label redraw; the timer runs outside Angular's zone and pauses while the
 * tab or app is hidden, catching up as soon as it is visible again.
 * (Kept identical in the dashboard and agent apps.)
 */
@Injectable({ providedIn: 'root' })
export class Clock {
  readonly sec = signal(Date.now());
  readonly min = signal(Date.now());

  constructor() {
    inject(NgZone).runOutsideAngular(() => {
      let ticks = 0;
      setInterval(() => {
        if (document.hidden) return;
        const now = Date.now();
        this.sec.set(now);
        if (++ticks % 30 === 0) this.min.set(now);
      }, 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        const now = Date.now();
        this.sec.set(now);
        this.min.set(now);
      });
    });
  }

  /** "12s ago", "3 min ago", "in 2 min"; subscribes the caller's view to the right tick. */
  ago(v: string | number | Date | null | undefined): string {
    if (v === null || v === undefined || v === '') return '';
    const at = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    if (Number.isNaN(at)) return '';
    const s = Math.round((Date.now() - at) / 1000);
    const a = Math.abs(s);
    (a < 60 ? this.sec : this.min)();
    const t = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
    return s >= 0 ? `${t} ago` : `in ${t}`;
  }
}

/**
 * `{{ t | ago }}`. Not pure on purpose: a pure pipe would cache the first answer. The work per call is
 * a subtraction, and the view only redraws when the clock tick it read changes.
 */
@Pipe({ name: 'ago', pure: false })
export class AgoPipe implements PipeTransform {
  private clock = inject(Clock);
  transform(v: string | number | Date | null | undefined): string { return this.clock.ago(v); }
}
