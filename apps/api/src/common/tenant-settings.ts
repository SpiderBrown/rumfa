import { ForbiddenException } from '@nestjs/common';
import type { Db } from '../database/db.service';

/**
 * How people in the agent app may call each other (tenants.settings.calls). Each client switches these on or off.
 *  - phone:  the phone's own dialler, on the caller's airtime (works on weak signal; the number is shown)
 *  - bridged: Rumfa call. The platform rings the caller first, then the other person (client pays; numbers stay hidden)
 *  - webrtc: internet call. The caller speaks over mobile data; the other person gets a normal phone call
 * Dashboard staff always have their own calling; these switches are for field users.
 */
export type CallMode = 'phone' | 'bridged' | 'webrtc';
export const CALL_MODES: CallMode[] = ['phone', 'bridged', 'webrtc'];
export type CallSettings = Record<CallMode, boolean>;

export function callSettings(settings: any): CallSettings {
  const c = settings?.calls ?? {};
  return { phone: c.phone ?? true, bridged: c.bridged ?? true, webrtc: c.webrtc ?? false };
}

export async function tenantCallSettings(db: Db, tenantId: string): Promise<CallSettings> {
  const [t] = await db.system<{ settings: any }>(`select settings from public.tenants where id = $1`, [tenantId]);
  return callSettings(t?.settings);
}

export async function requireCallMode(db: Db, tenantId: string, mode: CallMode) {
  if (!(await tenantCallSettings(db, tenantId))[mode]) {
    throw new ForbiddenException(({ phone: 'Phone calls', bridged: 'Rumfa calls', webrtc: 'Internet calls' } as const)[mode] + ' are turned off for your organisation');
  }
}
