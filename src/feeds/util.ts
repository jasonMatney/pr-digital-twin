// Small pure helpers shared by the mappers. No DOM, no signals: Node imports these in tests.
import type { PropValue } from '../ontology/types.ts';

export const FT_TO_M = 0.3048;
export const CFS_TO_M3S = 0.028316846592;
export const IN_TO_MM = 25.4;
export const KMH_TO_MS = 1 / 3.6;
export const FPM_TO_MS = 0.00508;
/** The reference point distances to "Puerto Rico" are measured from (the world-frame origin). */
export const PR_CENTER = { lat: 18.22, lon: -66.45 };

/** A finite number or null. Strings are parsed; '', 'MM', null and NaN give null. */
export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
export function parseTime(v: unknown): number | null {
  if (v == null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}
/** 'San Juan' -> 'san-juan', 'Mayagüez' -> 'mayaguez'. */
export function slug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
/** Drops null/undefined entries so a missing reading never overwrites a stored value with nothing. */
export function compact(props: Record<string, PropValue | undefined>): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [k, v] of Object.entries(props)) if (v != null && v !== '') out[k] = v;
  return out;
}
/** Stamps every property with the time the source says it was measured. */
export function stamped(props: Record<string, PropValue | undefined>, observedAt: number | null | undefined) {
  const c = compact(props);
  if (observedAt == null) return c;
  const out: Record<string, { value: PropValue; observedAt: number }> = {};
  for (const [k, v] of Object.entries(c)) out[k] = { value: v, observedAt };
  return out;
}
/** Centre of a GeoJSON geometry's bounding box: good enough to place a marker for an alert polygon. */
export function bboxCenter(geometry: any): { lon: number; lat: number } | null {
  if (!geometry || !geometry.coordinates) return null;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: any) => {
    if (typeof c[0] === 'number') { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; }
    else for (const x of c) walk(x);
  };
  walk(geometry.coordinates);
  return Number.isFinite(w) && Number.isFinite(s) ? { lon: (w + e) / 2, lat: (s + n) / 2 } : null;
}
export function nearest<T extends { lon: number; lat: number }>(lat: number, lon: number, pts: T[]): { item: T; km: number } | null {
  let best: T | null = null, bestKm = Infinity;
  for (const p of pts) { const d = haversineKm(lat, lon, p.lat, p.lon); if (d < bestKm) { bestKm = d; best = p; } }
  return best ? { item: best, km: bestKm } : null;
}
/** Relay files wrap the payload; fixtures are the raw upstream payload. Accept both. */
export function unwrapRelay<T = any>(payload: any, now: number): { fetchedAt: number; source: string; data: T } {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && typeof payload.fetchedAt === 'number' && 'data' in payload) return payload;
  return { fetchedAt: now, source: 'fixture', data: payload };
}
