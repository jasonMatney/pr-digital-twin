// NWS active alerts (GeoJSON) -> weather_alert objects with `affects` links to municipios and forecast zones.
import type { IngestBatch, LinkInput, ObjectInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { bboxCenter, compact, parseTime } from '../util.ts';

export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?area=PR';
const SEVERITY: Record<string, number> = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

/** 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc.001.1' -> '2.49.0.1.840.0.abc.001.1' */
export function alertKey(id: string): string {
  return String(id).replace(/^.*urn:oid:/, '').replace(/^.*\//, '').replace(/[^A-Za-z0-9._-]+/g, '_');
}
/** SAME '072127' -> '72127' (county FIPS without the leading subdivision digit). Only Puerto Rico codes pass. */
export function sameToGeoid(same: string): string | null {
  const m = /^0?(72\d{3})$/.exec(String(same).trim());
  return m ? m[1] : null;
}

export function mapNwsAlerts(payload: any, ctx: MapContext): IngestBatch[] {
  const objects: ObjectInput[] = [];
  const links: LinkInput[] = [];
  const seen = new Set<string>();
  for (const f of payload?.features ?? []) {
    const p = f?.properties ?? {};
    const rawId = p.id ?? f.id;
    if (!rawId) continue;
    const key = alertKey(rawId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const onset = parseTime(p.onset) ?? parseTime(p.effective) ?? parseTime(p.sent);
    const until = parseTime(p.ends) ?? parseTime(p.expires);
    const c = bboxCenter(f.geometry);
    const area = String(p.areaDesc ?? '');
    objects.push({
      type: 'weather_alert', key,
      name: `${p.event ?? 'Alert'}: ${area.length > 90 ? area.slice(0, 87) + '...' : area}`,
      lon: c?.lon ?? null, lat: c?.lat ?? null,
      status: until != null && until <= ctx.now ? 'expired' : 'active',
      severity: SEVERITY[p.severity] ?? 0,
      validFrom: onset, validTo: until,
      geometry: f.geometry ?? null,
      props: compact({
        event: p.event, severity_text: p.severity, urgency: p.urgency, certainty: p.certainty, headline: p.headline,
        description: p.description, instruction: p.instruction, area_desc: p.areaDesc, sender: p.senderName,
        onset, expires: parseTime(p.expires),
      }),
      text: [p.headline, p.areaDesc].filter(Boolean).join(' '),
    });
    const src = `weather_alert:${key}`;
    const geoids = new Set<string>();
    for (const s of p.geocode?.SAME ?? []) { const g = sameToGeoid(s); if (g) geoids.add(g); }
    for (const u of p.geocode?.UGC ?? []) {
      const ugc = String(u);
      // County-type UGC (PRC097) names the same municipio as SAME 072097; PRZ001..013 are the forecast zones in the seed.
      // Zones outside Puerto Rico (VIZ001, marine AMZ) have no object to link to.
      const county = /^PRC(\d{3})$/.exec(ugc);
      if (county) geoids.add('72' + county[1]);
      else if (/^PRZ\d{3}$/.test(ugc)) links.push({ src, type: 'affects', dst: `forecast_zone:${ugc}` });
    }
    for (const g of geoids) links.push({ src, type: 'affects', dst: `municipio:${g}` });
  }
  const updated = parseTime(payload?.updated);
  return [{ source: 'nws_alerts', fetchedAt: ctx.now, observedAt: updated ?? ctx.now, objects, links, replaceTypes: ['weather_alert'] }];
}
