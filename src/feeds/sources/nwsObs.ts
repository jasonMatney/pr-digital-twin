// NWS latest surface observation per station (GeoJSON, SI with unitCode) -> weather_station readings.
import type { IngestBatch, ObjectInput, ObsInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { haversineKm, KMH_TO_MS, num, parseTime, round, stamped } from '../util.ts';

/** Used when the store has no weather stations. TJMZ and TJRV answer 404 on the live API and are not asked. */
export const NWS_OBS_STATIONS = ['TJSJ', 'TJBQ', 'TJPS', 'TJIG', 'TJNR'];
export const NWS_OBS_MAX = 12;
/**
 * Which stations to poll: every airport (id starts with TJ), then others chosen one at a time as the station
 * farthest from all those already chosen, so the picks spread around the island. `keep` are earlier picks that
 * still answer (kept so the set is stable); `budget` caps how many untried stations may be added this run.
 */
export function chooseObsStations(pool: { key: string; lon: number | null; lat: number | null }[], opts: { max?: number; keep?: string[]; budget?: number; exclude?: Iterable<string> } = {}): string[] {
  const max = opts.max ?? NWS_OBS_MAX;
  const exclude = new Set(opts.exclude ?? []);
  // Open-Meteo model points share the object type; they are not NWS stations. Stay on and around the main island.
  const ok = pool.filter((s) => /^[A-Z0-9]{3,8}$/.test(s.key) && !exclude.has(s.key) && s.lon != null && s.lat != null && s.lat >= 17.6 && s.lat <= 18.7 && s.lon >= -67.5 && s.lon <= -65.1)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) as { key: string; lon: number; lat: number }[];
  const byKey = new Map(ok.map((s) => [s.key, s]));
  const chosen: { key: string; lon: number; lat: number }[] = [];
  const add = (k: string) => { const s = byKey.get(k); if (s && chosen.length < max && !chosen.includes(s)) chosen.push(s); };
  for (const s of ok) if (s.key.startsWith('TJ')) add(s.key);
  for (const k of opts.keep ?? []) add(k);
  let budget = opts.budget ?? max;
  while (chosen.length < max && budget > 0) {
    let best: { key: string; lon: number; lat: number } | null = null, bestD = -1;
    for (const s of ok) {
      if (chosen.includes(s)) continue;
      let d = Infinity;
      for (const c of chosen) d = Math.min(d, haversineKm(s.lat, s.lon, c.lat, c.lon));
      if (d > bestD) { bestD = d; best = s; }
    }
    if (!best || bestD <= 0) break;
    chosen.push(best); budget--;
  }
  return chosen.map((s) => s.key);
}
export const nwsObsUrl = (station: string) => `https://api.weather.gov/stations/${station}/observations/latest`;

/** Reads a `{ unitCode, value }` quantity and converts it to the unit we store. Null when missing or in an unknown unit. */
export function quantity(q: any, want: 'm/s' | 'hPa' | 'degC' | 'km' | 'deg' | '%' | 'mm'): number | null {
  const v = num(q?.value);
  if (v == null) return null;
  const unit = String(q.unitCode ?? '').replace(/^(wmoUnit|unit|nwsUnit|uc):/, '');
  switch (want) {
    case 'm/s': return unit === 'km_h-1' ? v * KMH_TO_MS : unit === 'm_s-1' ? v : unit === 'kn' || unit === '[kn_i]' ? v * 0.514444 : null;
    case 'hPa': return unit === 'Pa' ? v / 100 : unit === 'hPa' ? v : null;
    case 'degC': return unit === 'degC' ? v : unit === 'degF' || unit === '[degF]' ? (v - 32) / 1.8 : null;
    case 'km': return unit === 'm' ? v / 1000 : unit === 'km' ? v : null;
    case 'deg': return unit === 'degree_(angle)' ? v : null;
    case '%': return unit === 'percent' ? v : null;
    case 'mm': return unit === 'mm' ? v : unit === 'm' ? v * 1000 : null;
  }
}
const r = (v: number | null, d: number) => (v == null ? null : round(v, d));

export function mapNwsObs(payloads: any[], ctx: MapContext): IngestBatch[] {
  const objects: ObjectInput[] = [];
  const obs: ObsInput[] = [];
  let newest = 0;
  for (const f of payloads) {
    const p = f?.properties;
    const id = p?.stationId ?? String(p?.station ?? '').split('/').pop();
    const t = parseTime(p?.timestamp);
    if (!id || /\s/.test(id) || t == null) continue;
    if (t > newest) newest = t;
    const temp = r(quantity(p.temperature, 'degC'), 1);
    const wind = r(quantity(p.windSpeed, 'm/s'), 2);
    const pressure = r(quantity(p.seaLevelPressure, 'hPa') ?? quantity(p.barometricPressure, 'hPa'), 1);
    const c = f.geometry?.coordinates;
    const o: ObjectInput = {
      type: 'weather_station', key: id,
      props: stamped({
        temp_c: temp, wind_ms: wind, wind_dir_deg: quantity(p.windDirection, 'deg'), gust_ms: r(quantity(p.windGust, 'm/s'), 2),
        pressure_hpa: pressure, humidity_pct: r(quantity(p.relativeHumidity, '%'), 0), conditions: p.textDescription,
        visibility_km: r(quantity(p.visibility, 'km'), 2), precip_mm: quantity(p.precipitationLastHour, 'mm'),
      }, t),
    };
    if (p.stationName) o.name = p.stationName;
    if (Array.isArray(c) && num(c[0]) != null && num(c[1]) != null) { o.lon = c[0]; o.lat = c[1]; }
    objects.push(o);
    const object = `weather_station:${id}`;
    if (temp != null) obs.push({ object, metric: 'temp_c', t, value: temp });
    if (wind != null) obs.push({ object, metric: 'wind_ms', t, value: wind });
    if (pressure != null) obs.push({ object, metric: 'pressure_hpa', t, value: pressure });
  }
  return [{ source: 'nws_obs', fetchedAt: ctx.now, observedAt: newest || ctx.now, objects, obs }];
}
