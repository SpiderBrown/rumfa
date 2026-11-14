// Deployment settings, read at start-up. Replace per environment; never put
// the service-role key here (the anon key is public by design).
window.ALAWA_CONFIG = {
  supabaseUrl: 'http://127.0.0.1:54321',
  supabaseAnonKey: 'replace-with-anon-key',
  // Africa's Talking WebRTC client script; without it, calls ring the operator's own phone first (bridged).
  atWebrtcScript: '',
};
