// NOAA National Water Prediction Service gauge list -> flood category per gauge. The list carries the NWS id
// (lid) only; the seed puts ['nws:lid', lid] on the USGS-keyed object, so the store merges on that identity.
import type { IngestBatch, ObjectInput, PropValue } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { CFS_TO_M3S, FT_TO_M, num, parseTime, round } from '../util.ts';

export const NWPS_URL = 'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-67.99&bbox.ymin=17.6&bbox.xmax=-65.1&bbox.ymax=18.7&srid=EPSG_4326';
const SEVERITY: Record<string, number> = { no_flooding: 0, not_defined: 0, low_threshold: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const NOT_CURRENT = new Set(['fcst_not_current', 'obs_not_current', '']);

export function nwpsType(name: string): 'reservoir' | 'stream_gauge' {
  return /\b(lago|embalse|lake|reservoir)\b/i.test(name) ? 'reservoir' : 'stream_gauge';
}
const valid = (v: unknown) => { const n = num(v); return n != null && n > -900 ? n : null; };

export function mapNwps(payload: any, ctx: MapContext): IngestBatch[] {
  const objects: ObjectInput[] = [];
  let newest = 0;
  for (const g of payload?.gauges ?? []) {
    const lid = String(g?.lid ?? '').trim();
    if (!lid || /\s/.test(lid)) continue;
    const name = String(g.name ?? lid);
    const type = nwpsType(name);
    const o = g.status?.observed ?? {}, f = g.status?.forecast ?? {};
    const cat = String(o.floodCategory ?? ''), fcat = String(f.floodCategory ?? '');
    const t = parseTime(o.validTime);
    const at = t != null && t > 0 ? t : null;       // '0001-01-01T00:00:00Z' means "no reading"
    if (at != null && at > newest) newest = at;
    const primary = valid(o.primary), secondary = valid(o.secondary);
    const pe = String(g.pedts?.observed ?? '').slice(0, 2);   // SHEF physical element: HG stage, HP pool elevation
    const props: Record<string, PropValue | { value: PropValue; observedAt: number }> = {};
    const put = (k: string, v: PropValue) => { props[k] = at != null && v != null ? { value: v, observedAt: at } : v; };
    if (type === 'stream_gauge') {
      put('flood_category', NOT_CURRENT.has(cat) ? null : cat);
      put('forecast_category', NOT_CURRENT.has(fcat) ? null : fcat);
      props.nws_lid = lid;
      if (at != null && primary != null && o.primaryUnit === 'ft' && pe === 'HG') put('stage_m', round(primary * FT_TO_M, 3));
      if (at != null && secondary != null && o.secondaryUnit === 'kcfs') put('discharge_m3s', round(secondary * 1000 * CFS_TO_M3S, 4));
    } else if (at != null && primary != null && o.primaryUnit === 'ft' && pe === 'HP') {
      put('lake_elev_m', round(primary * FT_TO_M, 3));
    }
    const lon = num(g.longitude), lat = num(g.latitude);
    objects.push({
      type, key: 'nws-' + lid, name, identities: [['nws:lid', lid]],
      lon: lon != null && lat != null ? lon : null, lat: lon != null && lat != null ? lat : null,
      status: cat || null,
      severity: cat in SEVERITY ? SEVERITY[cat] : null,
      props,
    });
  }
  return [{ source: 'nwps', fetchedAt: ctx.now, observedAt: newest || ctx.now, objects }];
}
