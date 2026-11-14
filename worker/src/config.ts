// Worker configuration from environment variables. See worker/.env.example.

function req(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`Missing environment variable ${k}`);
  return v;
}
const opt = (k: string, d = ''): string => process.env[k] ?? d;
const num = (k: string, d: number): number => (process.env[k] ? Number(process.env[k]) : d);

export const config = {
  supabaseUrl: () => req('SUPABASE_URL'),
  serviceKey: () => req('SUPABASE_SERVICE_ROLE_KEY'),

  irev: {
    baseUrl: opt('IREV_BASE_URL', 'https://dolphin-app-sleqh.ondigitalocean.app/api/v1'),
    requestsPerSecond: num('IREV_RPS', 1.5),
    downloadsPerSecond: num('IREV_DOWNLOAD_RPS', 5),
    userAgent: opt('IREV_USER_AGENT', 'Rumfa-situation-room/1.0'),
    maxImageWidth: num('IREV_MAX_WIDTH', 1024),
  },

  ocr: {
    provider: opt('OCR_PROVIDER', 'manual') as 'manual' | 'google' | 'azure',
    googleApiKey: opt('GOOGLE_VISION_API_KEY'),
    azureEndpoint: opt('AZURE_DI_ENDPOINT'),
    azureKey: opt('AZURE_DI_KEY'),
    minConfidence: num('OCR_MIN_CONFIDENCE', 0.85),
  },

  at: {
    username: opt('AT_USERNAME', 'sandbox'),
    apiKey: opt('AT_API_KEY'),
    senderId: opt('AT_SENDER_ID'),
    voiceNumber: opt('AT_VOICE_NUMBER'),
  },

  fcm: {
    projectId: opt('FCM_PROJECT_ID'),
    clientEmail: opt('FCM_CLIENT_EMAIL'),
    privateKey: opt('FCM_PRIVATE_KEY').replace(/\\n/g, '\n'),
  },

  whatsapp: {
    token: opt('WHATSAPP_TOKEN'),
    phoneNumberId: opt('WHATSAPP_PHONE_NUMBER_ID'),
  },

  vtpass: {
    baseUrl: opt('VTPASS_BASE_URL', 'https://sandbox.vtpass.com/api'),
    apiKey: opt('VTPASS_API_KEY'),
    secretKey: opt('VTPASS_SECRET_KEY'),
  },

  voiceWebhookUrl: () => `${req('SUPABASE_URL')}/functions/v1/voice-events?key=${encodeURIComponent(req('WEBHOOK_KEY'))}`,

  tickSeconds: num('TICK_SECONDS', 20),
};
