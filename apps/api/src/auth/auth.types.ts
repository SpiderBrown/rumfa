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

export type TokenType = 'access' | 'select' | 'mfa' | 'mfa_setup';

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
  /** Staff roles that must use an authenticator code */
  mfaRoles: string[];
}

export function tenantAuthSettings(settings: any): TenantAuthSettings {
  const a = settings?.auth ?? {};
  return {
    activation: Array.isArray(a.activation) && a.activation.length ? a.activation : ['sms', 'whatsapp', 'code'],
    mfaRoles: Array.isArray(a.mfa_roles) ? a.mfa_roles : ['supervisor', 'admin'],
  };
}
