import { pointInGeometry, type Geo } from '../shared';

/**
 * Rough places for areas the map has no outline or location for yet (most wards, and polling units, until real
 * boundary data is loaded). They are made up from the parent's outline, only so people can see and open every
 * area; the map draws them as dashed circles and says they are approximate. Same inputs give the same places.
 */
export interface Spot { lat: number; lng: number; radius_m: number }

const M_PER_DEG = 111_320;

/** `n` places spread evenly inside an outline, each with a radius that roughly fills its share of the area. */
export function spreadInside(g: Geo, n: number): Spot[] {
  if (n <= 0) return [];
  const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((p) => p[0]);
  const pts = rings.flat();
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const [w, e, s, nth] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
  const cos = Math.cos(((s + nth) / 2) * Math.PI / 180) || 1;
  // A grid of candidate points inside the outline, fine enough for ~25 per place
  let cand: [number, number][] = [];
  let next = Math.sqrt(((e - w) * cos * (nth - s)) / Math.max(n * 25, 100)) || 0.001, cell = next;
  for (let tries = 0; tries < 6 && cand.length < n * 8; tries++, next /= 2) {
    cand = []; cell = next;
    for (let lat = s + cell / 2; lat < nth; lat += cell)
      for (let lng = w + cell / cos / 2; lng < e; lng += cell / cos) if (pointInGeometry(lat, lng, g)) cand.push([lat, lng]);
  }
  if (!cand.length) cand = [[(s + nth) / 2, (w + e) / 2]];
  const share = (cand.length * (cell * M_PER_DEG) ** 2) / n; // m² per place
  const radius_m = Math.round(Math.sqrt(share / Math.PI) * 0.7);
  const dist = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + ((a[1] - b[1]) * cos) ** 2;

  // Start far apart, then a few rounds of moving each place to the middle of the points nearest it (k-means)
  const centres: [number, number][] = [cand[Math.floor(cand.length / 2)]];
  while (centres.length < Math.min(n, cand.length)) {
    let best = cand[0], bestD = -1;
    for (const c of cand) { const d = Math.min(...centres.map((x) => dist(c, x))); if (d > bestD) { bestD = d; best = c; } }
    centres.push(best);
  }
  for (let round = 0; round < 12; round++) {
    const groups = centres.map(() => [] as [number, number][]);
    for (const c of cand) {
      let k = 0, kd = Infinity;
      centres.forEach((x, i) => { const d = dist(c, x); if (d < kd) { kd = d; k = i; } });
      groups[k].push(c);
    }
    groups.forEach((gr, i) => {
      if (!gr.length) return;
      const mid: [number, number] = [gr.reduce((a, p) => a + p[0], 0) / gr.length, gr.reduce((a, p) => a + p[1], 0) / gr.length];
      // Keep it inside the outline (a curved area's middle can fall outside): use its nearest own point
      centres[i] = pointInGeometry(mid[0], mid[1], g) ? mid : gr.reduce((b, p) => (dist(p, mid) < dist(b, mid) ? p : b));
    });
  }
  // Read top to bottom, left to right, so neighbouring codes tend to sit near each other
  centres.sort((a, b) => (Math.round((b[0] - a[0]) / (cell * 3)) || a[1] - b[1]));
  return Array.from({ length: n }, (_, i) => {
    const c = centres[i % centres.length];
    return { lat: c[0], lng: c[1], radius_m };
  });
}

/** `n` places in a circle around a point (a sunflower pattern, evenly filled), for units of a ward with no outline. */
export function spreadAround(centre: Spot, n: number): Spot[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = centre.radius_m * 0.85;
  const cos = Math.cos(centre.lat * Math.PI / 180) || 1;
  const each = Math.max(60, Math.round(r / Math.sqrt(Math.max(n, 1)) / 2));
  return Array.from({ length: n }, (_, i) => {
    const d = r * Math.sqrt((i + 0.5) / n), a = i * golden;
    return { lat: centre.lat + (d * Math.sin(a)) / M_PER_DEG, lng: centre.lng + (d * Math.cos(a)) / (M_PER_DEG * cos), radius_m: each };
  });
}
