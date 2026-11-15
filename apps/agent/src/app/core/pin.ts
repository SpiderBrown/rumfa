import { Injectable, signal } from '@angular/core';

/** The 6-digit PIN, also checked on the phone so the app unlocks offline. Stored only as a salted hash; the server checks it too. */
@Injectable({ providedIn: 'root' })
export class Pin {
  readonly unlocked = signal(false);
  hasPin() { return !!localStorage.getItem('rumfa.pin'); }

  private async hash(pin: string, salt: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${pin}`));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async set(pin: string) {
    const salt = crypto.randomUUID();
    localStorage.setItem('rumfa.pin', JSON.stringify({ salt, h: await this.hash(pin, salt), fails: 0 }));
    this.unlocked.set(true);
  }
  /** After 5 wrong tries the person must activate the phone again. */
  async check(pin: string): Promise<'ok' | 'wrong' | 'locked'> {
    const rec = JSON.parse(localStorage.getItem('rumfa.pin') ?? 'null');
    if (!rec) return 'locked';
    if ((await this.hash(pin, rec.salt)) === rec.h) { rec.fails = 0; localStorage.setItem('rumfa.pin', JSON.stringify(rec)); this.unlocked.set(true); return 'ok'; }
    rec.fails = (rec.fails ?? 0) + 1;
    if (rec.fails >= 5) { localStorage.removeItem('rumfa.pin'); return 'locked'; }
    localStorage.setItem('rumfa.pin', JSON.stringify(rec));
    return 'wrong';
  }
}
