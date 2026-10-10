// NHC forecast points and cone from the NWS ArcGIS service (one group of layers per storm slot) -> the forecast
// attached to a tropical_cyclone object. Written from the service's recorded layer list (field names only): no
// query response was recorded, so every field is read defensively.
import type { IngestBatch } from '../../ontology/types.ts';
import { num, parseTime } from '../util.ts';

export const NHC_ARCGIS = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer';
/** Layer ids per Atlantic slot (tests/fixtures/nhc_arcgis_layers.json): slots are 26 layers apart. */
export const NHC_SLOT_LAYERS: Record<string, { points: number; track: number; cone: number; watchWarning: number }> = {
  AT1: { points: 6, track: 7, cone: 8, watchWarning: 9 }, AT2: { points: 32, track: 33, cone: 34, watchWarning: 35 },
  AT3: { points: 58, track: 59, cone: 60, watchWarning: 61 }, AT4: { points: 84, track: 85, cone: 86, watchWarning: 87 },
  AT5: { points: 110, track: 111, cone: 112, watchWarning: 113 },
};
/** Storms farther than this from Puerto Rico are not queried. */
export const NHC_FORECAST_MAX_KM = 3000;
const QUERY = 'query?where=1%3D1&outFields=*&outSR=4326&f=geojson';
export function nhcForecastUrls(binNumber: string): { points: string; cone: string } | null {
  const slot = NHC_SLOT_LAYERS[String(binNumber ?? '').toUpperCase()];
  return slot ? { points: `${NHC_ARCGIS}/${slot.points}/${QUERY}`, cone: `${NHC_ARCGIS}/${slot.cone}/${QUERY}` } : null;
}

export interface ForecastPoint { t: number; lat: number; lon: number; wind_kt: number; gust_kt: number | null; label: string }
export interface CycloneForecast { advisory: string; points: ForecastPoint[]; cone: any | null }

/** Property bag with lower-cased keys: the service has returned both 'STORMNAME' and 'stormname' styles over time. */
const lower = (props: any): Record<string, any> => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(props ?? {})) out[k.toLowerCase()] = v;
  return out;
};
const features = (fc: any): any[] => (fc && !fc.error && Array.isArray(fc.features) ? fc.features : []);
const text = (v: unknown) => (v == null ? '' : String(v).trim());

/**
 * When a forecast point is valid. NHC writes VALIDTIME as 'DD/HHMM' in UTC with no month or year; those come from
 * the advisory time. Also accepts epoch ms and ISO strings. Falls back to advisory time + TAU hours.
 */
export function forecastTime(validtime: unknown, tau: unknown, advisoryAt: number | null): number | null {
  if (typeof validtime === 'number' && validtime > 1e11) return validtime;
  const m = /^(\d{1,2})\/(\d{2})(\d{2})$/.exec(text(validtime));
  if (m && advisoryAt != null) {
    const ref = new Date(advisoryAt);
    let best: number | null = null;
    // the same day-of-month in the previous, current or next month: take the one nearest the advisory
    for (const dm of [-1, 0, 1]) {
      const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + dm, +m[1], +m[2], +m[3]));
      if (d.getUTCDate() !== +m[1]) continue;                       // e.g. the 31st in a 30-day month
      if (best == null || Math.abs(d.getTime() - advisoryAt) < Math.abs(best - advisoryAt)) best = d.getTime();
    }
    if (best != null) return best;
  }
  if (typeof validtime === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(validtime)) { const t = parseTime(validtime); if (t != null) return t; }
  const h = num(tau);
  return h != null && advisoryAt != null ? advisoryAt + h * 3600e3 : null;
}

/**
 * `storm` is the relay's CurrentStorms entry (name and lastUpdate). Returns null when the slot holds nothing usable
 * or holds a different storm (slots are reused).
 */
export function parseNhcForecast(pointsFc: any, coneFc: any, storm: { name?: string; lastUpdate?: string | number }): CycloneForecast | null {
  const advisoryAt = parseTime(storm.lastUpdate);
  const want = text(storm.name).toLowerCase();
  const same = (p: Record<string, any>) => { const n = text(p.stormname).toLowerCase(); return !want || !n || n === want || n.endsWith(' ' + want); };
  const points: ForecastPoint[] = [];
  let advisory = '';
  for (const f of features(pointsFc)) {
    const p = lower(f.properties ?? f.attributes);
    if (!same(p)) continue;
    const c = f.geometry?.coordinates;
    const lon = num(p.lon) ?? (Array.isArray(c) ? num(c[0]) : null), lat = num(p.lat) ?? (Array.isArray(c) ? num(c[1]) : null);
    const wind = num(p.maxwind);
    const t = forecastTime(p.validtime, p.tau ?? p.fcstprd, advisoryAt);
    if (lon == null || lat == null || wind == null || t == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const gust = num(p.gust);
    points.push({ t, lat, lon, wind_kt: wind, gust_kt: gust != null && gust > 0 && gust < 400 ? gust : null, label: text(p.datelbl) || text(p.fldatelbl) });
    if (!advisory && text(p.advisnum)) advisory = text(p.advisnum);
  }
  points.sort((a, b) => a.t - b.t);
  const polys: any[] = [];
  for (const f of features(coneFc)) {
    const p = lower(f.properties ?? f.attributes);
    const g = f.geometry;
    if (!same(p) || !g || !Array.isArray(g.coordinates) || !g.coordinates.length) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
    if (!advisory && text(p.advisnum)) advisory = text(p.advisnum);
  }
  const cone = polys.length === 0 ? null : polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  return points.length || cone ? { advisory, points, cone } : null;
}

/** Writes a forecast onto the storm's object in an `nhc` batch: cone as geometry, advisory and points as properties. */
export function attachForecast(batch: IngestBatch, stormId: string, forecast: CycloneForecast | null): void {
  const o = (batch.objects ?? []).find((x) => x.type === 'tropical_cyclone' && x.key === stormId);
  if (!o || !forecast) return;
  if (forecast.cone) o.geometry = forecast.cone;
  o.props = { ...o.props };
  if (forecast.advisory) o.props.advisory = forecast.advisory;
  if (forecast.points.length) o.props.forecast_points = JSON.stringify(forecast.points);
}
