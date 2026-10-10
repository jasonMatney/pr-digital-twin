// NDBC latest observations near Puerto Rico (parsed and filtered by the relay) -> buoy readings.
import type { IngestBatch, ObjectInput, ObsInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { num, parseTime, stamped } from '../util.ts';

export const NDBC_BOX = { south: 16.5, north: 20, west: -69, east: -63.5 };
export interface NdbcRecord {
  station: string; lat: number; lon: number; time: string;
  wdir: number | null; wspd: number | null; gst: number | null; wvht: number | null; dpd: number | null; apd: number | null; mwd: number | null;
  pres: number | null; ptdy: number | null; atmp: number | null; wtmp: number | null; dewp: number | null; vis: number | null; tide: number | null;
}
/**
 * Parses NDBC latest_obs.txt (whitespace-separated columns, two '#' header lines, 'MM' = missing) and keeps the
 * stations inside the box. Same logic as pipeline/relay.mjs; used here for fixtures mode and tests.
 */
export function parseNdbcLatestObs(text: string, box = NDBC_BOX): NdbcRecord[] {
  const lines = text.split(/\r?\n/);
  const header = (lines.find((l) => l.startsWith('#STN')) ?? '').replace(/^#/, '').trim().split(/\s+/);
  // An HTML error page or a truncated download must fail the run, not read as "no buoys".
  if (header.length < 8) throw new Error('NDBC latest_obs: header line not found');
  const col = (name: string) => header.indexOf(name);
  const out: NdbcRecord[] = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < header.length) continue;
    const g = (name: string) => { const i = col(name); const v = i < 0 ? 'MM' : f[i]; return v === 'MM' ? null : num(v); };
    const lat = g('LAT'), lon = g('LON');
    if (lat == null || lon == null || lat < box.south || lat > box.north || lon < box.west || lon > box.east) continue;
    const [y, mo, d, h, mi] = ['YYYY', 'MM', 'DD', 'hh', 'mm'].map((n) => num(f[col(n)]));
    if (y == null || mo == null || d == null || h == null || mi == null) continue;
    out.push({
      station: f[col('STN')], lat, lon, time: new Date(Date.UTC(y, mo - 1, d, h, mi)).toISOString(),
      wdir: g('WDIR'), wspd: g('WSPD'), gst: g('GST'), wvht: g('WVHT'), dpd: g('DPD'), apd: g('APD'), mwd: g('MWD'),
      pres: g('PRES'), ptdy: g('PTDY'), atmp: g('ATMP'), wtmp: g('WTMP'), dewp: g('DEWP'), vis: g('VIS'), tide: g('TIDE'),
    });
  }
  return out;
}

export function mapNdbc(records: NdbcRecord[], ctx: MapContext & { fetchedAt?: number }): IngestBatch[] {
  const objects: ObjectInput[] = [];
  const obs: ObsInput[] = [];
  let newest = 0;
  for (const r of Array.isArray(records) ? records : []) {
    const t = parseTime(r?.time);
    if (!r?.station || /\s/.test(r.station) || t == null || num(r.lat) == null || num(r.lon) == null) continue;
    if (t > newest) newest = t;
    // No `name`: latest_obs.txt has none, and the seed's station name must not be overwritten by a bare id.
    objects.push({
      type: 'buoy', key: r.station, lon: r.lon, lat: r.lat,
      props: stamped({
        wave_height_m: num(r.wvht), dominant_period_s: num(r.dpd), wind_ms: num(r.wspd), wind_dir_deg: num(r.wdir), gust_ms: num(r.gst),
        pressure_hpa: num(r.pres), water_temp_c: num(r.wtmp), air_temp_c: num(r.atmp),
      }, t),
    });
    const object = `buoy:${r.station}`;
    if (num(r.wvht) != null) obs.push({ object, metric: 'wave_height_m', t, value: r.wvht as number });
    if (num(r.wspd) != null) obs.push({ object, metric: 'wind_ms', t, value: r.wspd as number });
    if (num(r.pres) != null) obs.push({ object, metric: 'pressure_hpa', t, value: r.pres as number });
  }
  return [{ source: 'ndbc', fetchedAt: ctx.fetchedAt ?? ctx.now, observedAt: newest || ctx.fetchedAt || ctx.now, objects, obs }];
}
