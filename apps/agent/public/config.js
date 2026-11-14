// Deployment settings for the agent app (bundled into the APK at build time).
window.ALAWA_CONFIG = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'replace-with-anon-key',
  // Number the SMS fallback is sent to (Africa's Talking short code or long number)
  smsNumber: '+2340000000000',
  // Coordinator helpline shown on the help screen
  helpline: '',
};
