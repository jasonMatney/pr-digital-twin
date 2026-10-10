// Formatting for numbers, units, times (always AST) and coordinates. An unknown value is an em dash, never 0.
import type { PropertyDef, PropValue } from '../ontology/types';
import { t, locale } from '../i18n/index';

export const DASH = '—';
const TZ = 'America/Puerto_Rico';
export const AST_OFFSET_MS = -4 * 3600e3;
export const SAN_JUAN = { lat: 18.4655, lon: -66.1057 };

const UNIT: Record<string, string> = { 'm3/s': 'm³/s', degC: '°C', km2: 'km²', 'ug/m3': 'µg/m³', deg: '°', USD: '', '%': '%' };
export const unitLabel = (u?: string | null) => (u == null ? '' : u in UNIT ? UNIT[u] : u);

export function num(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function compact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + ' M';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + ' k';
  return num(v);
}

export function toMs(v: PropValue | undefined): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string') { const ms = Date.parse(v); return Number.isFinite(ms) ? ms : null; }
  return null;
}
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, opts: Intl.DateTimeFormatOptions) {
  const k = locale() + key;
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat(locale(), { timeZone: TZ, ...opts }); fmtCache.set(k, f); }
  return f;
}
export const fmtTime = (ms: number | null | undefined, sec = false) =>
  ms == null ? DASH : dtf('t' + sec, { hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined, hourCycle: 'h23' }).format(ms);
export const fmtDate = (ms: number | null | undefined) =>
  ms == null ? DASH : dtf('d', { year: 'numeric', month: 'short', day: 'numeric' }).format(ms);
export const fmtDay = (ms: number | null | undefined) =>
  ms == null ? DASH : dtf('day', { weekday: 'short', day: 'numeric', month: 'short' }).format(ms);
export const fmtDateTime = (ms: number | null | undefined) =>
  ms == null ? DASH : dtf('dt', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return DASH;
  const d = now - ms;
  if (d < 0 && d > -90e3) return t('ago.now');   // clock skew between a fetch and our coarse tick
  if (d < 0) { // in the future (an expiry)
    const m = Math.round(-d / 60e3);
    return t('in.pre') + (m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);
  }
  const m = Math.floor(d / 60e3);
  if (m < 1) return t('ago.now');
  if (m < 90) return `${t('ago.pre')}${m} ${t('ago.min')}`;
  if (m < 2880) return `${t('ago.pre')}${Math.round(m / 60)} ${t('ago.h')}`;
  return `${t('ago.pre')}${Math.round(m / 1440)} ${t('ago.d')}`;
}
export function duration(s: number | null | undefined): string {
  if (s == null) return DASH;
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** A property value as text plus its unit, using the PropertyDef's format. `numeric` tells tables to right-align. */
export function formatProp(def: PropertyDef | undefined, value: PropValue | undefined, unitOverride?: string | null): { text: string; unit: string; numeric: boolean } {
  if (value == null || value === '') return { text: DASH, unit: '', numeric: def?.type === 'number' };
  const f = def?.format;
  const unit = unitLabel(unitOverride ?? def?.unit);
  if (typeof value === 'boolean') return { text: value ? t('yes') : t('no'), unit: '', numeric: false };
  if (f === 'date' || f === 'datetime' || def?.type === 'date') {
    const ms = toMs(value);
    return { text: ms == null ? String(value) : f === 'date' ? fmtDate(ms) : fmtDateTime(ms), unit: '', numeric: true };
  }
  if (typeof value === 'number') {
    if (f === 'usd') return { text: '$' + num(value), unit: '', numeric: true };
    if (f === 'pct') return { text: num(value, 1) + '%', unit: '', numeric: true };
    if (f === 'fixed1') return { text: num(value, 1), unit, numeric: true };
    if (f === 'fixed2') return { text: num(value, 2), unit, numeric: true };
    if (f === 'int') return { text: num(value), unit, numeric: true };
    return { text: Number.isInteger(value) ? num(value) : num(value, Math.abs(value) < 10 ? 2 : 1), unit, numeric: true };
  }
  if (def?.type === 'json') return { text: '{…}', unit: '', numeric: false };
  return { text: String(value).replace(/_/g, ' '), unit: f ? '' : unit && def?.type === 'number' ? unit : '', numeric: false };
}

/** Degrees and decimal minutes: 18°27.930′ N */
export function dmm(v: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (v >= 0 ? 'N' : 'S') : v >= 0 ? 'E' : 'W';
  const a = Math.abs(v); let d = Math.floor(a); let m = (a - d) * 60;
  if (m >= 59.9995) { d += 1; m = 0; }
  return `${String(d).padStart(axis === 'lat' ? 2 : 3, '0')}°${m.toFixed(3).padStart(6, '0')}′ ${hemi}`;
}
export const dd = (v: number | null | undefined, n = 4) => (v == null ? DASH : v.toFixed(n));

const COMPASS_EN = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const COMPASS_ES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const compass = (deg: number) => (locale().startsWith('es') ? COMPASS_ES : COMPASS_EN)[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Start of the AST calendar day that contains `ms`, as epoch ms. */
export const astDayStart = (ms: number) => Math.floor((ms + AST_OFFSET_MS) / 864e5) * 864e5 - AST_OFFSET_MS;

/** Sunrise and sunset (minutes after AST midnight) from the NOAA low-accuracy solar equations; good to about a minute. */
export function sunTimes(ms: number, lat = SAN_JUAN.lat, lon = SAN_JUAN.lon): { rise: number; set: number } {
  const d = new Date(astDayStart(ms) + 12 * 3600e3);
  const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
  const g = (2 * Math.PI / 365) * (doy - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const r = Math.PI / 180;
  const ha = Math.acos(Math.cos(90.833 * r) / (Math.cos(lat * r) * Math.cos(decl)) - Math.tan(lat * r) * Math.tan(decl)) / r;
  const riseUtc = 720 - 4 * (lon + ha) - eq, setUtc = 720 - 4 * (lon - ha) - eq;
  return { rise: riseUtc + AST_OFFSET_MS / 60e3, set: setUtc + AST_OFFSET_MS / 60e3 };
}
export const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
