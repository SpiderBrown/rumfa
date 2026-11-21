import { ForbiddenException } from '@nestjs/common';
import type { Db } from '../database/db.service';

/**
 * How people in the agent app may call each other (tenants.settings.calls). Each client switches these on or off.
 *  - phone:  the phone's own dialler, on the caller's airtime (works on weak signal; the number is shown)
 *  - bridged: Rumfa call. The platform rings the caller first, then the other person (client pays; numbers stay hidden)
 *  - webrtc: internet call. The caller speaks over mobile data; the other person gets a normal phone call
 *  - inapp:  app call. Free voice call over the internet between two people in the Rumfa apps (agent app or
 *            dashboard), through LiveKit; no phone network, so no per-minute charge
 * phone, bridged and webrtc are for field users (dashboard staff have their own phone calling);
 * inapp applies to both apps.
 */
export type CallMode = 'phone' | 'bridged' | 'webrtc' | 'inapp';
export const CALL_MODES: CallMode[] = ['phone', 'bridged', 'webrtc', 'inapp'];
export type CallSettings = Record<CallMode, boolean>;

export function callSettings(settings: any): CallSettings {
  const c = settings?.calls ?? {};
  return { phone: c.phone ?? true, bridged: c.bridged ?? true, webrtc: c.webrtc ?? false, inapp: c.inapp ?? false };
}

/** The tenant's raw settings object. */
export async function tenantSettings(db: Db, tenantId: string): Promise<any> {
  const [t] = await db.system<{ settings: any }>(`select settings from public.tenants where id = $1`, [tenantId]);
  return t?.settings ?? {};
}

export async function tenantCallSettings(db: Db, tenantId: string): Promise<CallSettings> {
  return callSettings(await tenantSettings(db, tenantId));
}

export async function requireCallMode(db: Db, tenantId: string, mode: CallMode) {
  if (!(await tenantCallSettings(db, tenantId))[mode]) {
    throw new ForbiddenException(({ phone: 'Phone calls', bridged: 'Rumfa calls', webrtc: 'Internet calls', inapp: 'App calls' } as const)[mode] + ' are turned off for your organisation');
  }
}

/**
 * When field people may check in (tenants.settings.checkin). Check-in opens on election day at `opens`
 * (Lagos time) and closes at midnight. `anyDay` allows it on other days too, for training and mock drills.
 */
export interface CheckinSettings { opens: string; anyDay: boolean }
export function checkinSettings(settings: any): CheckinSettings {
  const c = settings?.checkin ?? {};
  return { opens: /^\d{2}:\d{2}$/.test(c.opens ?? '') ? c.opens : '06:00', anyDay: !!c.anyDay };
}

/** The organisation's own party (tenants.settings.party): shown first and largest on the live count. */
export function ownParty(settings: any): string | null {
  return typeof settings?.party === 'string' && /^[A-Z]{1,8}$/.test(settings.party) ? settings.party : null;
}

/**
 * Add-ons, switched per client in Rumfa Console (tenants.settings.addons).
 *  - voice:        Voice outreach (recorded messages called out to supporters). Off unless switched on.
 *  - airtime:      Airtime and data top-ups for field people. Off unless switched on.
 *  - liveVideo:    The room can ask an agent to stream live video from the unit. On unless switched off.
 *  - sheetReading: Rumfa reads the figures from agents' EC8A photos automatically. On unless switched off.
 * liveVideo and sheetReading were part of every client before they became switches, so they stay on by default.
 */
export type Addon = 'voice' | 'airtime' | 'liveVideo' | 'sheetReading';
export const ADDONS: Record<Addon, string> = { voice: 'Voice outreach', airtime: 'Airtime and data', liveVideo: 'Live video from the field', sheetReading: 'Sheet reading' };
export function addonSettings(settings: any): Record<Addon, boolean> {
  const a = settings?.addons ?? {};
  return { voice: a.voice === true, airtime: a.airtime === true, liveVideo: a.liveVideo !== false, sheetReading: a.sheetReading !== false };
}
