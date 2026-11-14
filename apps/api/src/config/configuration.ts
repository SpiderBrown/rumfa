const bool = (v: string | undefined, def: boolean) =>
  v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
const int = (v: string | undefined, def: number) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
};

/** `*` (default) lets any site call the API; or a comma-separated list. Tokens are Bearer, not cookies. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw === undefined || raw.trim() === '' ? '*' : raw)
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^['"]+|['"]+$/g, '').replace(/\/+$/, ''))
    .filter(Boolean);
}

export type OtpMode = 'sms' | 'console' | 'fixed';

export default function configuration() {
  const env = process.env.NODE_ENV ?? 'development';
  const otpMode = (process.env.OTP_MODE ?? 'sms') as OtpMode;
  const jwtSecret = process.env.JWT_SECRET ?? 'dev-only-secret-change-me';
  if (env === 'production') {
    if (otpMode !== 'sms') throw new Error(`OTP_MODE=${otpMode} is not allowed in production`);
    if (jwtSecret.length < 32 || jwtSecret.startsWith('dev-only')) throw new Error('Set a JWT_SECRET of at least 32 characters');
  }
  return {
    env,
    port: int(process.env.PORT, 3000),
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    db: {
      /** Full connection string (Supabase Session pooler). Takes precedence over the separate settings. */
      url: process.env.DATABASE_URL?.trim() || undefined,
      host: process.env.DB_HOST ?? 'localhost',
      port: int(process.env.DB_PORT, 5432),
      username: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? 'postgres',
      database: process.env.DB_NAME ?? 'rumfa',
      ssl: bool(process.env.DB_SSL, !!process.env.DATABASE_URL?.trim()),
      poolMax: int(process.env.DB_POOL_MAX, 10),
      runMigrations: bool(process.env.DB_RUN_MIGRATIONS, true),
      logging: bool(process.env.DB_LOGGING, false),
    },
    auth: {
      jwtSecret,
      accessTtlSeconds: int(process.env.ACCESS_TOKEN_TTL_SECONDS, 900),
      refreshTtlDays: int(process.env.REFRESH_TOKEN_TTL_DAYS, 30),
      otpMode,
      fixedOtp: process.env.FIXED_OTP ?? '123456',
      otpTtlMinutes: 10,
      activationCodeTtlHours: 48,
      pinLength: 6,
      maxPinFails: 5,
      totpIssuer: process.env.TOTP_ISSUER ?? 'Rumfa',
    },
    at: {
      username: process.env.AT_USERNAME ?? 'sandbox',
      apiKey: process.env.AT_API_KEY ?? '',
      senderId: process.env.AT_SENDER_ID || undefined,
    },
    whatsapp: {
      token: process.env.WHATSAPP_TOKEN ?? '',
      phoneId: process.env.WHATSAPP_PHONE_ID ?? '',
      codeTemplate: process.env.WHATSAPP_CODE_TEMPLATE ?? 'rumfa_code',
    },
    webhookKey: process.env.WEBHOOK_KEY ?? '',
  };
}

export type AppConfig = ReturnType<typeof configuration>;
