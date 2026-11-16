import { Injectable, inject } from '@angular/core';
import { Geolocation } from '@capacitor/geolocation';
import { judgeCheckin } from '@rumfa/shared';
import { Api } from './api';
import { Checkin } from './checkin';
import { Checklist } from './checklist';
import { I18n } from './i18n';
import { Outbox } from './outbox';
import { Ui } from './ui';

const PLACE: Record<string, string> = { ward: 'your ward', unit: 'your polling unit', lga: 'your LGA', state: 'your state' };
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
const dayTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

/**
 * Checking in at the polling unit, with its confirmations: not before check-in opens, a warning (and a reason)
 * when away from the agent's area or without a location, and "check in again" to correct. Used from the home
 * screen and from the day's first stage. Also answers "arrived by 7:30 am" from the check-in time.
 */
@Injectable({ providedIn: 'root' })
export class CheckinFlow {
  private api = inject(Api);
  private ci = inject(Checkin);
  private checklist = inject(Checklist);
  private outbox = inject(Outbox);
  private ui = inject(Ui);
  private t = inject(I18n).t;

  /** Returns true when a check-in was recorded. */
  async run(): Promise<boolean> {
    const open = this.ci.openNow();
    const s = this.ci.state();
    if (open === 'early' && s.window) {
      await this.ui.alert('Not yet', `${this.t('Check-in opens at')} ${dayTime(s.window.opensAt)} ${this.t('on election day. Check in when you reach your polling unit.')}`);
      return false;
    }
    if (open === 'closed') { await this.ui.alert('Check-in has closed', 'Check-in is closed for this election.'); return false; }
    const ok = this.ci.onlyOutside()
      ? await this.ui.confirm('Check in again?', 'Your last check-in was outside your area. Check in again now that you are there. The earlier one is kept.', 'Check in again', 'Cancel')
      : s.first
        ? await this.ui.confirm('Check in again?', `${this.t('You checked in at')} ${time(s.arrival ?? s.first)}. ${this.t('Only check in again if you left and came back, or your unit moved to a new place.')}`, 'Check in again', 'Cancel')
        : await this.ui.confirm('Check in now?', `${this.t('Only check in when you are at your polling unit')} (${this.api.me()!.area_code}). ${this.t('The situation room sees the time and your location.')}`, 'I am here', 'Cancel');
    if (!ok) return false;
    const at = new Date();
    let pos: { lat?: number; lng?: number; accuracy?: number } = {};
    try {
      const p = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
    } catch { /* no location: asked for a reason below */ }

    // Within their own area? (the server checks again). Outside, or no location: allowed, with a reason
    const fence = s.fence ?? null;
    const j = judgeCheckin(fence, pos);
    let note: string | null = null;
    if (fence && pos.lat == null) {
      note = await this.ui.prompt('No location', 'We could not get your location. Turn on location and try again, or check in now and say why.',
        { placeholder: 'Reason', ok: 'Check in anyway', required: true });
      if (note === null) return false;
    } else if (j.inside === false) {
      const where = `${fence!.name} (${this.t(PLACE[fence!.level])})`;
      const away = j.distance != null ? ` ${this.t('about')} ${km(j.distance)} ${this.t('from it')}` : '';
      note = await this.ui.prompt('Outside your area',
        `${this.t('You seem to be outside')} ${where}${away}. ${this.t('You can still check in, but tell the situation room why (for example, the unit was moved).')}`,
        { placeholder: 'Reason', ok: 'Check in anyway', required: true });
      if (note === null) return false;
    }
    await this.outbox.add('checkin', { pu: this.api.me()!.area_code, ...pos, at: at.toISOString(), note }, 'Check in');
    const firstArrival = !s.first || (!s.arrival && j.inside !== false);
    this.ci.recorded(at, j.inside);
    // Arrival question answered by the check-in itself: by 7:30 am Lagos time (when INEC officials arrive)
    if (firstArrival && j.inside !== false) {
      const hhmm = at.toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false });
      await this.checklist.answer('arrived', hhmm <= '07:30' ? 'yes' : 'no');
    }
    await this.ui.toast(j.inside === false ? 'Checked in outside your area. Check in again when you get there.' : 'Checked in',
      j.inside === false ? 'medium' : 'success');
    return true;
  }

}
