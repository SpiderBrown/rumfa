// Deployment settings for the Rumfa Agent app (bundled into the APK at build time). One app for every client;
// no secrets here: the app talks only to the Rumfa API.
window.RUMFA_CONFIG = {
  apiUrl: 'https://rumfa-production.up.railway.app',
  // Name shown before sign-in (after sign-in the organisation's own name is shown)
  brand: 'Rumfa',
  // Number the SMS fallback is sent to (Africa's Talking short code or long number)
  smsNumber: '+2340000000000',
  // Coordinator helpline shown on the help screen
  helpline: '',
  // Africa's Talking WebRTC client script, for internet calls (only used when the organisation turns them on)
  atWebrtcScript: '',
  // Party logos on the live count buttons. {party} is the lower-case party code, e.g. parties/apc.png.
  // Put the official logo files in public/parties/ so they work offline; set to '' to show codes only.
  partyLogos: 'parties/{party}.png',
  // Background map for the situation map. OpenStreetMap's free tiles by default (fine for a small team;
  // for heavy use run your own tile server or use a provider). Set url to '' for outlines only, no background.
  mapTiles: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
};
