// Deployment settings for the agent app (bundled into the APK at build time).
window.RUMFA_CONFIG = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'replace-with-anon-key',
  // Name shown before sign-in (after sign-in the client's own name from tenant settings is shown)
  brand: 'Rumfa',
  // Number the SMS fallback is sent to (Africa's Talking short code or long number)
  smsNumber: '+2340000000000',
  // Coordinator helpline shown on the help screen
  helpline: '',
};
