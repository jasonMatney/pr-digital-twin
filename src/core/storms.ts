// Historical storm tracks (HURDAT2 best tracks published as data/replay/storms.json) and the maths to replay them.
// Pure functions: used by the scene layer that draws a storm and by the panel that reports who was inside its winds.
import { dataUrl } from './config';
import { haversineKm, DEG } from './geo.ts';

export interface StormPoint {
  t: number; lat: number; lon: number; status: string; wind_kt: number; pressure_mb: number | null;
  /** Wind radii in nautical miles by quadrant [NE, SE, SW, NW]; null when the best track has none (before 2004). */
  r34: number[] | null; r50: number[] | null; r64: number[] | null;
}
export interface Storm { id: string; name: string; year: number; points: StormPoint[]; closest_km: number; closest_t: number }

let cache: Promise<Storm[]> | null = null;
export function loadStorms(): Promise<Storm[]> {
  return (cache ??= fetch(dataUrl('data/replay/storms.json')).then((r) => { if (!r.ok) throw new Error('storm tracks unavailable'); return r.json(); }));
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
type RadiiKey = 'r34' | 'r50' | 'r64';
const RADII_GAP_MS = 12 * 3600e3;
/** Wind radii at time t, where p[i] is the first fix at or after t. The best track's off-synoptic fixes (landfalls,
 *  2004-2011) carry no radii: interpolate between the nearest fixes on each side that do, no further than 12 hours
 *  away, or carry the one side that has them. null only when the record has none nearby (storms before 2004). */
function radiiAt(p: StormPoint[], i: number, t: number, key: RadiiKey): number[] | null {
  let ia = i - 1, ib = i;
  while (ia >= 0 && !p[ia][key] && t - p[ia].t <= RADII_GAP_MS) ia--;
  while (ib < p.length && !p[ib][key] && p[ib].t - t <= RADII_GAP_MS) ib++;
  const fa = ia >= 0 && t - p[ia].t <= RADII_GAP_MS ? p[ia] : null, fb = ib < p.length && p[ib].t - t <= RADII_GAP_MS ? p[ib] : null;
  const a = fa ? fa[key] : null, b = fb ? fb[key] : null;
  if (a && b && fa && fb) { const k = fb.t === fa.t ? 0 : (t - fa.t) / (fb.t - fa.t); return a.map((v, j) => lerp(v, b[j], k)); }
  return a ?? b;
}

/** The storm at time t: position, intensity and radii interpolated linearly between best-track fixes. null outside the track. */
export function stormAt(storm: Storm, t: number): StormPoint | null {
  const p = storm.points;
  if (!p.length || t < p[0].t || t > p[p.length - 1].t) return null;
  let i = 1;
  while (i < p.length - 1 && p[i].t < t) i++;
  const a = p[i - 1], b = p[i], k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return {
    t, lat: lerp(a.lat, b.lat, k), lon: lerp(a.lon, b.lon, k), status: k < 0.5 ? a.status : b.status,
    wind_kt: lerp(a.wind_kt, b.wind_kt, k), pressure_mb: a.pressure_mb != null && b.pressure_mb != null ? lerp(a.pressure_mb, b.pressure_mb, k) : (a.pressure_mb ?? b.pressure_mb),
    r34: radiiAt(p, i, t, 'r34'), r50: radiiAt(p, i, t, 'r50'), r64: radiiAt(p, i, t, 'r64'),
  };
}

/** Radius of the given wind threshold toward a compass bearing (degrees clockwise from north), km. 0 when unknown. */
export function windRadiusKm(p: StormPoint, kt: 34 | 50 | 64, bearingDeg: number): number {
  const r = kt === 34 ? p.r34 : kt === 50 ? p.r50 : p.r64;
  if (!r) return 0;
  const q = Math.floor((((bearingDeg % 360) + 360) % 360) / 90);     // 0 NE, 1 SE, 2 SW, 3 NW
  return (r[q] ?? 0) * 1.852;
}
export function bearingDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}
/** Strongest wind threshold (64, 50, 34 or 0 kt) whose best-track radius covers the point. */
export function windBandAt(p: StormPoint, lon: number, lat: number): 0 | 34 | 50 | 64 {
  const d = haversineKm(p.lon, p.lat, lon, lat), b = bearingDeg(p.lon, p.lat, lon, lat);
  for (const kt of [64, 50, 34] as const) if (d <= windRadiusKm(p, kt, b) && windRadiusKm(p, kt, b) > 0) return kt;
  return 0;
}
export function saffirSimpson(windKt: number): { cat: number; label: string } {
  if (windKt >= 137) return { cat: 5, label: 'Category 5' };
  if (windKt >= 113) return { cat: 4, label: 'Category 4' };
  if (windKt >= 96) return { cat: 3, label: 'Category 3' };
  if (windKt >= 83) return { cat: 2, label: 'Category 2' };
  if (windKt >= 64) return { cat: 1, label: 'Category 1' };
  if (windKt >= 34) return { cat: 0, label: 'Tropical storm' };
  return { cat: -1, label: 'Tropical depression' };
}
