// USGS ComCat (FDSN event service, GeoJSON) -> earthquake objects, linked to the nearest municipio when close.
import type { IngestBatch, LinkInput, ObjectInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { nearest, num, stamped } from '../util.ts';

export const QUAKE_BOX = { minlatitude: 16.8, maxlatitude: 19.8, minlongitude: -68.6, maxlongitude: -64.2 };
export function quakesUrl(sinceMs: number, minMagnitude = 2): string {
  const b = QUAKE_BOX;
  return `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=${b.minlatitude}&maxlatitude=${b.maxlatitude}` +
    `&minlongitude=${b.minlongitude}&maxlongitude=${b.maxlongitude}&starttime=${new Date(sinceMs).toISOString().slice(0, 10)}` +
    `&minmagnitude=${minMagnitude}&orderby=time`;
}
export function quakeSeverity(mag: number | null): number {
  if (mag == null) return 0;
  return mag >= 6 ? 4 : mag >= 5 ? 3 : mag >= 4 ? 2 : mag >= 3 ? 1 : 0;
}
/** An epicentre farther than this from every municipio centroid is offshore: no located_in link. */
export const QUAKE_LINK_KM = 25;

export function mapUsgsQuakes(payload: any, ctx: MapContext): IngestBatch[] {
  const objects: ObjectInput[] = [];
  const links: LinkInput[] = [];
  for (const f of payload?.features ?? []) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const key = f?.id;
    if (!key || /\s/.test(key) || !Array.isArray(c) || num(c[0]) == null || num(c[1]) == null) continue;
    const mag = num(p.mag);
    const t = num(p.time);
    objects.push({
      type: 'earthquake', key,
      name: p.title ?? `M ${mag ?? '?'} - ${p.place ?? ''}`,
      lon: c[0], lat: c[1],
      status: p.status ?? null,
      severity: quakeSeverity(mag),
      validFrom: t,
      props: stamped({
        magnitude: mag, depth_km: num(c[2]), place: p.place, mag_type: p.magType, felt_reports: num(p.felt),
        tsunami: p.tsunami == null ? undefined : p.tsunami === 1 || p.tsunami === true,
        network: p.net, status_text: p.status, url: p.url,
      }, num(p.updated) ?? t),
      text: p.place ?? undefined,
    });
    if (ctx.municipios?.length) {
      const n = nearest(c[1], c[0], ctx.municipios);
      if (n && n.km <= QUAKE_LINK_KM) links.push({ src: `earthquake:${key}`, type: 'located_in', dst: n.item.id, confidence: 0.6, note: `epicentre ${n.km.toFixed(1)} km from the municipio centroid` });
    }
  }
  return [{ source: 'usgs_quakes', fetchedAt: ctx.now, observedAt: num(payload?.metadata?.generated) ?? ctx.now, objects, links }];
}
