// USGS NWIS instantaneous values (WaterML JSON) -> stream_gauge / reservoir readings in SI units.
import type { IngestBatch, ObjectInput, ObsInput, PropValue } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { CFS_TO_M3S, FT_TO_M, IN_TO_MM, num, parseTime, round } from '../util.ts';

export const NWIS_URL = 'https://waterservices.usgs.gov/nwis/iv/?format=json&stateCd=pr&parameterCd=00065,00060,00045,62614&siteStatus=active';

interface ParamMap { prop: string; metric: string; factor: number; digits: number }
const STREAM: Record<string, ParamMap> = {
  '00065': { prop: 'stage_m', metric: 'stage_m', factor: FT_TO_M, digits: 3 },
  '00060': { prop: 'discharge_m3s', metric: 'discharge_m3s', factor: CFS_TO_M3S, digits: 4 },
  '00045': { prop: 'precip_1h_mm', metric: 'precip_mm', factor: IN_TO_MM, digits: 2 },
};
const LAKE: Record<string, ParamMap> = { '62614': { prop: 'lake_elev_m', metric: 'lake_elev_m', factor: FT_TO_M, digits: 3 } };

export interface NwisContext extends MapContext {
  /**
   * site_no -> the type the store already holds for that site. The seed decides whether a USGS site is a gauge or a
   * reservoir; following it keeps a lake from appearing twice under two types. Sites not listed use the rule below.
   */
  knownTypes?: Record<string, 'stream_gauge' | 'reservoir'>;
}
export function mapUsgsNwis(payload: any, ctx: NwisContext): IngestBatch[] {
  const sites = new Map<string, { info: any; series: { code: string; noData: number | null; values: any[] }[] }>();
  for (const ts of payload?.value?.timeSeries ?? []) {
    const site = ts?.sourceInfo?.siteCode?.[0]?.value;
    const code = ts?.variable?.variableCode?.[0]?.value;
    if (!site || !code || /\s/.test(site)) continue;
    let s = sites.get(site);
    if (!s) sites.set(site, (s = { info: ts.sourceInfo, series: [] }));
    for (const block of ts.values ?? []) s.series.push({ code, noData: num(ts.variable?.noDataValue), values: block?.value ?? [] });
  }
  const objects: ObjectInput[] = [];
  const obs: ObsInput[] = [];
  let newest = 0;
  for (const [site, s] of sites) {
    const codes = new Set(s.series.map((x) => x.code));
    // A site that reports lake elevation and neither stage nor discharge is a reservoir; everything else is a gauge.
    const byRule = codes.has('62614') && !codes.has('00065') && !codes.has('00060') ? 'reservoir' : 'stream_gauge';
    const type = ctx.knownTypes?.[site] ?? byRule;
    // Only values the type has a property for are kept (a reservoir has no rain or stage property in the ontology).
    const table = type === 'reservoir' ? LAKE : STREAM;
    const props: Record<string, { value: PropValue; observedAt: number }> = {};
    for (const ser of s.series) {
      const m = table[ser.code];
      if (!m) continue;
      for (const v of ser.values) {
        const raw = num(v?.value);
        const t = parseTime(v?.dateTime);
        if (raw == null || t == null || raw === -999999 || (ser.noData != null && raw === ser.noData)) continue;
        const value = round(raw * m.factor, m.digits);
        obs.push({ object: `${type}:${site}`, metric: m.metric, t, value });
        if (!props[m.prop] || t >= props[m.prop].observedAt) props[m.prop] = { value, observedAt: t };
        if (t > newest) newest = t;
      }
    }
    if (!Object.keys(props).length) continue;
    const g = s.info?.geoLocation?.geogLocation;
    const lon = num(g?.longitude), lat = num(g?.latitude);
    objects.push({ type, key: site, name: s.info?.siteName, lon: lon != null && lat != null ? lon : null, lat: lon != null && lat != null ? lat : null, props });
  }
  return [{ source: 'usgs_nwis', fetchedAt: ctx.now, observedAt: newest || ctx.now, objects, obs }];
}
