import * as L from 'leaflet';
import { ISSUE_BANDS, REPORTING_BANDS, issueBand, leadOpacity, partyColour, reportingBand, type MapLayer } from '@rumfa/shared';

/**
 * The situation-room map (Leaflet): sub-areas of one area, coloured by open issues, leading party or
 * reporting. Outlines for states, LGAs and wards; points for polling units. Same file in the dashboard and
 * the agent app.
 */
export interface MapArea {
  code: string; name: string; shape: any | null; lat: number | null; lng: number | null;
  units: number; registered: number; reported: number; ec8a: number; irev: number; quick: number; live: number; verified: number; mismatch: number;
  votes: Record<string, number>; leader: { party: string; votes: number; share: number; margin: number } | null;
  open: number; critical: number; high: number; medium: number; low: number; escalated: number;
  agents: number; coordinator: { id: string; full_name: string } | null;
  /** No outline or location yet: lat/lng is a rough place inside the parent, drawn as a dashed circle of radius_m */
  approx?: boolean; radius_m?: number | null;
}
export interface MapData {
  scope: string; parent: string; level: string; childLevel: 'state' | 'senatorial' | 'lga' | 'ward' | 'pu'; group?: 'senatorial' | null; election: string | null;
  parties: string[]; partyColours: Record<string, string>; breadcrumb: { code: string; name: string }[];
  shape: any | null; center: { lat: number; lng: number } | null;
  /** The area itself has no outline: its rough place (as its children are placed around it) */
  approxArea?: { lat: number; lng: number; radius_m: number } | null; areaWide: { open: number; critical: number }; children: MapArea[];
}
export interface MapTiles { url: string; attribution?: string }

const NIGERIA: L.LatLngBoundsExpression = [[4.2, 2.6], [13.9, 14.7]];

export function fillFor(a: MapArea, layer: MapLayer, d: MapData): { colour: string; opacity: number } {
  if (layer === 'issues') return { colour: ISSUE_BANDS[issueBand(a)].colour, opacity: 0.75 };
  if (layer === 'reporting') return { colour: REPORTING_BANDS[reportingBand(a.reported, d.childLevel === 'pu' ? 1 : a.units)], opacity: 0.8 };
  if (!a.leader) return { colour: '#c9ced6', opacity: 0.35 };
  return { colour: partyColour(a.leader.party, d.parties, d.partyColours), opacity: leadOpacity(a.leader.margin) };
}

export function tipFor(a: MapArea, layer: MapLayer): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const line = layer === 'issues'
    ? (a.open ? `${a.open} open issue${a.open > 1 ? 's' : ''}${a.critical ? `, ${a.critical} critical` : ''}` : 'No open issues')
    : layer === 'votes'
      ? (a.leader ? `${a.leader.party} leads: ${Math.round(a.leader.share * 100)}% (${a.leader.votes.toLocaleString()} votes)` : 'No results yet')
      : `${a.reported} of ${a.units || 1} units reported`;
  return `<b>${esc(a.name)}</b><br>${esc(line)}` + (a.approx ? '<br><i>Rough place: no outline or location yet</i>' : '');
}

export class AreaMap {
  private map: L.Map;
  private layer = L.layerGroup();
  private lastParent = '';

  constructor(el: HTMLElement, tiles?: MapTiles | null) {
    this.map = L.map(el, { preferCanvas: true, zoomSnap: 0.5 });
    if (tiles?.url) L.tileLayer(tiles.url, { attribution: tiles.attribution ?? '', maxZoom: 18 }).addTo(this.map);
    // Credit the open boundary data (required by its licences)
    this.map.attributionControl.addAttribution('Boundaries: OCHA (CC BY-IGO), GRID3');
    this.map.fitBounds(NIGERIA);
    this.layer.addTo(this.map);
  }

  /** Draws the sub-areas. Zooms to them only when the area changes, not on live refreshes. */
  render(d: MapData, layer: MapLayer, onClick: (a: MapArea) => void, selected?: string | null) {
    this.layer.clearLayers();
    const bounds = L.latLngBounds([]);
    if (d.shape) {
      const o = L.geoJSON(d.shape, { style: { color: '#1f2937', weight: 2, dashArray: '6 4', fill: false }, interactive: false });
      o.addTo(this.layer);
      bounds.extend(o.getBounds());
    } else if (d.approxArea) {
      const o = L.circle([d.approxArea.lat, d.approxArea.lng], { radius: d.approxArea.radius_m, color: '#1f2937', weight: 2, dashArray: '6 4', fill: false, interactive: false });
      o.addTo(this.layer);
      bounds.extend(o.getBounds());
    }
    for (const a of d.children) {
      const f = fillFor(a, layer, d);
      const sel = a.code === selected;
      if (a.shape) {
        const g = L.geoJSON(a.shape, { style: { color: sel ? '#111827' : '#4b5563', weight: sel ? 3 : 1, fillColor: f.colour, fillOpacity: f.opacity } });
        g.bindTooltip(tipFor(a, layer), { sticky: true }).on('click', () => onClick(a)).addTo(this.layer);
        bounds.extend(g.getBounds());
      } else if (a.approx && a.lat != null && a.lng != null && d.childLevel !== 'pu' && a.radius_m) {
        // Rough place of an area with no outline: a dashed circle about its size
        const c = L.circle([a.lat, a.lng], { radius: a.radius_m, color: sel ? '#111827' : '#4b5563', weight: sel ? 3 : 1.5, dashArray: '5 4',
          fillColor: f.colour, fillOpacity: Math.max(f.opacity * 0.8, 0.45) });
        c.bindTooltip(tipFor(a, layer), { sticky: true }).on('click', () => onClick(a)).addTo(this.layer);
        bounds.extend(c.getBounds());
      } else if (a.lat != null && a.lng != null) {
        const m = L.circleMarker([a.lat, a.lng], { radius: d.childLevel === 'pu' ? 9 : 11, color: sel ? '#111827' : '#374151', weight: sel ? 3 : 1,
          fillColor: f.colour, fillOpacity: Math.max(f.opacity, 0.6), dashArray: a.approx ? '3 3' : undefined });
        m.bindTooltip(tipFor(a, layer)).on('click', () => onClick(a)).addTo(this.layer);
        bounds.extend(m.getLatLng());
      }
    }
    if (d.parent !== this.lastParent) {
      this.lastParent = d.parent;
      if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [16, 16], maxZoom: 15 });
      else if (d.center?.lat != null) this.map.setView([d.center.lat, d.center.lng], 9);
      else this.map.fitBounds(NIGERIA);
    }
  }

  resize() { this.map.invalidateSize(); }
  destroy() { this.map.remove(); }
}
