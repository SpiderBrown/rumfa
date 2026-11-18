/** The signed-in person on a request, read from the access token. One tenant per token. */
export interface AuthUser {
  sub: string; // identities.id
  tid: string; // tenant chosen at sign-in
  mid: string; // membership: volunteers.id in that tenant
  role: string;
  level: string;
  area: string;
  dev?: string; // auth_devices.id for field users
}

export type TokenType = 'access' | 'select' | 'platform';

/** A Rumfa staff member signed in to the console (belongs to no client). */
export interface PlatformUser {
  sub: string; // identities.id
  sid: string; // platform_staff.id
  role: 'owner' | 'staff' | 'support';
}
export const PLATFORM_ROLES = ['owner', 'staff', 'support'] as const;

export interface Membership {
  mid: string;
  tid: string;
  brand: string;
  name: string;
  role: string;
  level: string;
  area: string;
}

export const FIELD_ROLES = ['agent', 'volunteer', 'coordinator'];
export const STAFF_ROLES = ['operator', 'supervisor', 'analyst', 'legal', 'security', 'voice_ops', 'admin'];

export interface TenantAuthSettings {
  /** Ways a field user may activate a device */
  activation: ('sms' | 'whatsapp' | 'code')[];
}

export function tenantAuthSettings(settings: any): TenantAuthSettings {
  const a = settings?.auth ?? {};
  return {
    activation: Array.isArray(a.activation) && a.activation.length ? a.activation : ['sms', 'whatsapp', 'code'],
  };
}
