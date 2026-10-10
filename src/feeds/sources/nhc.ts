// NHC CurrentStorms.json (via the relay) -> tropical_cyclone objects for Atlantic-basin systems.
import type { IngestBatch, ObjectInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { compact, haversineKm, num, parseTime, PR_CENTER } from '../util.ts';

/** NHC classification codes as documented for CurrentStorms.json. */
const CLASS: Record<string, string> = {
  TD: 'Tropical Depression', TS: 'Tropical Storm', HU: 'Hurricane', STD: 'Subtropical Depression', STS: 'Subtropical Storm',
  PTC: 'Post-Tropical Cyclone', PC: 'Potential Tropical Cyclone', TY: 'Typhoon',
};
/** 0 beyond 1500 km; closer systems rank by wind: hurricane (>= 64 kt), tropical storm (>= 34 kt), weaker. */
export function cycloneSeverity(distanceKm: number, intensityKt: number | null): number {
  if (!(distanceKm <= 1500)) return 0;
  const rank = intensityKt == null ? 0 : intensityKt >= 64 ? 2 : intensityKt >= 34 ? 1 : 0;
  if (distanceKm <= 500) return 2 + rank;
  if (distanceKm <= 1000) return 1 + rank;
  return rank === 2 ? 2 : 1;
}

export function mapNhc(data: any, ctx: MapContext & { fetchedAt?: number }): IngestBatch[] {
  const objects: ObjectInput[] = [];
  let newest = 0;
  for (const s of data?.activeStorms ?? []) {
    const id = String(s?.id ?? '').toLowerCase();
    if (!/^al\d{6}$/.test(id)) continue;                       // Atlantic basin only
    const lat = num(s.latitudeNumeric), lon = num(s.longitudeNumeric);
    if (lat == null || lon == null) continue;
    const kt = num(s.intensity);
    const km = haversineKm(lat, lon, PR_CENTER.lat, PR_CENTER.lon);
    const updated = parseTime(s.lastUpdate);
    if (updated != null && updated > newest) newest = updated;
    const label = CLASS[s.classification] ?? s.classification ?? 'Tropical cyclone';
    objects.push({
      type: 'tropical_cyclone', key: id, name: `${label} ${s.name ?? id.toUpperCase()}`,
      lon, lat, status: 'active', severity: cycloneSeverity(km, kt),
      props: compact({
        classification: label, intensity_kt: kt, pressure_hpa: num(s.pressure), movement_dir_deg: num(s.movementDir), movement_kt: num(s.movementSpeed),
        distance_to_pr_km: Math.round(km), last_update: updated, advisory_url: s.publicAdvisory?.url,
      }),
    });
  }
  return [{ source: 'nhc', fetchedAt: ctx.fetchedAt ?? ctx.now, observedAt: newest || ctx.fetchedAt || ctx.now, objects, replaceTypes: ['tropical_cyclone'] }];
}
