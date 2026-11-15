// Small GeoJSON helpers for the boundary import: simplify outlines and find a label point.

type Ring = [number, number][];
export type Geometry = { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] };

/** Douglas–Peucker on one ring, keeping it closed and at least 4 points. */
export function simplifyRing(ring: Ring, tol: number): Ring {
  if (ring.length <= 5) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let max = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(ring[i], ring[a], ring[b]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > tol && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

const round = (r: Ring): Ring => r.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);

/** Simplified copy; tiny islands (smaller than the tolerance) are dropped from multipolygons. */
export function simplify(g: Geometry, tol: number): Geometry {
  const poly = (p: Ring[]) => p.map((r) => round(simplifyRing(r, tol)));
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: poly(g.coordinates) };
  const parts = g.coordinates.filter((p) => Math.abs(ringArea(p[0])) > tol * tol).map(poly);
  return { type: 'MultiPolygon', coordinates: parts.length ? parts : g.coordinates.map(poly) };
}

function ringArea(r: Ring): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return s / 2;
}

/** Centre of the largest outer ring (area-weighted centroid), as a label/zoom point. */
export function center(g: Geometry): { lat: number; lng: number } {
  const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
  const big = rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = big.length - 1; i < big.length; j = i++) {
    const f = big[j][0] * big[i][1] - big[i][0] * big[j][1];
    a += f; cx += (big[j][0] + big[i][0]) * f; cy += (big[j][1] + big[i][1]) * f;
  }
  if (!a) return { lng: big[0][0], lat: big[0][1] };
  return { lng: cx / (3 * a), lat: cy / (3 * a) };
}

/** Name matching: case, punctuation, "LGA", "Ward" and spacing differences between data sources. */
export function normName(s: string): string {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(local government area|lga|ward|state|municipal council)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}
