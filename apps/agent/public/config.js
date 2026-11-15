// Deployment settings for the Rumfa Agent app (bundled into the APK at build time). One app for every client;
// no secrets here: the app talks only to the Rumfa API.
window.RUMFA_CONFIG = {
  apiUrl: 'http://localhost:3000',
  // Name shown before sign-in (after sign-in the organisation's own name is shown)
  brand: 'Rumfa',
  // Number the SMS fallback is sent to (Africa's Talking short code or long number)
  smsNumber: '+2340000000000',
  // Coordinator helpline shown on the help screen
  helpline: '',
  // Africa's Talking WebRTC client script, for internet calls (only used when the organisation turns them on)
  atWebrtcScript: '',
};
