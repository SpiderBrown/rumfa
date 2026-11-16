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
    if ((process.env.WEBHOOK_KEY ?? '').length < 24) throw new Error('Set a WEBHOOK_KEY of at least 24 characters');
    if ((process.env.STORAGE_DRIVER ?? 'supabase') === 'local') throw new Error('STORAGE_DRIVER=local is for development only');
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
    /** Public base URL of this API (used in callback URLs given to providers) */
    publicUrl: (process.env.API_PUBLIC_URL ?? `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
    at: {
      username: process.env.AT_USERNAME ?? 'sandbox',
      apiKey: process.env.AT_API_KEY ?? '',
      senderId: process.env.AT_SENDER_ID || undefined,
      voiceNumber: process.env.AT_VOICE_NUMBER ?? '',
    },
    whatsapp: {
      token: process.env.WHATSAPP_TOKEN ?? '',
      phoneId: process.env.WHATSAPP_PHONE_ID ?? '',
      codeTemplate: process.env.WHATSAPP_CODE_TEMPLATE ?? 'rumfa_code',
      appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
    },
    vtpass: {
      baseUrl: process.env.VTPASS_BASE_URL ?? 'https://sandbox.vtpass.com/api',
      apiKey: process.env.VTPASS_API_KEY ?? '',
      secretKey: process.env.VTPASS_SECRET_KEY ?? '',
    },
    livekit: {
      url: process.env.LIVEKIT_URL ?? '',
      apiKey: process.env.LIVEKIT_API_KEY ?? '',
      apiSecret: process.env.LIVEKIT_API_SECRET ?? '',
    },
    storage: {
      /** supabase: private Supabase Storage buckets via the service key. local: files on disk (development, tests). */
      driver: (process.env.STORAGE_DRIVER ?? (process.env.SUPABASE_URL ? 'supabase' : 'local')) as 'supabase' | 'local',
      supabaseUrl: (process.env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      localDir: process.env.STORAGE_DIR ?? '.storage',
      /** Buckets kept on local disk (under localDir) even when the driver is supabase, e.g. "irev" while the
       *  connection is too weak to upload large IReV sheets. Comma-separated. */
      localBuckets: (process.env.STORAGE_LOCAL_BUCKETS ?? '').split(',').map((b) => b.trim()).filter(Boolean),
      uploadTtlSeconds: 600,
      viewTtlSeconds: 300,
      maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
    },
    webhookKey: process.env.WEBHOOK_KEY ?? '',
  };
}

export type AppConfig = ReturnType<typeof configuration>;
