// Deployment settings for one client's dashboard site. The same build is hosted on each client's domain;
// only this file differs. No secrets here: the site talks only to the Rumfa API.
window.RUMFA_CONFIG = {
  // Rumfa API (one for all clients)
  apiUrl: 'https://rumfa-production.up.railway.app',
  // The client this site belongs to; staff of other clients cannot sign in here
  tenantId: 'a1a1a1a1-0000-4000-8000-000000000001',
  // Name shown before sign-in (after sign-in the client's own name from its settings is shown)
  brand: 'ALAWA',
  // Africa's Talking WebRTC client script; without it, calls ring the operator's own phone first (bridged).
  atWebrtcScript: '',
  // Background map for the situation map. OpenStreetMap's free tiles by default (fine for a small team;
  // for heavy use run your own tile server or use a provider). Set url to '' for outlines only, no background.
  mapTiles: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
};
