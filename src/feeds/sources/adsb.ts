// Aircraft near Puerto Rico (adsb.lol v2 shape, via the relay) -> aircraft tracks. The relay runs every ten
// minutes, so positions are old by the time they are read: observedAt is the relay's fetch time, not "now".
import type { IngestBatch, ObjectInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { compact, FPM_TO_MS, FT_TO_M, num, round } from '../util.ts';

export function mapAdsb(data: any, ctx: MapContext & { fetchedAt?: number }): IngestBatch[] {
  const fetchedAt = ctx.fetchedAt ?? ctx.now;
  const list: any[] = Array.isArray(data) ? data : data?.ac ?? data?.aircraft ?? [];
  const objects: ObjectInput[] = [];
  const seen = new Set<string>();
  for (const a of list) {
    const hex = String(a?.hex ?? '').trim().toLowerCase();
    const lat = num(a?.lat), lon = num(a?.lon);
    if (!hex || /\s/.test(hex) || lat == null || lon == null || seen.has(hex)) continue;
    seen.add(hex);
    const onGround = a.alt_baro === 'ground';
    const altFt = num(a.alt_geom) ?? (onGround ? 0 : num(a.alt_baro));
    const callsign = String(a.flight ?? '').trim();
    const emergency = a.emergency && a.emergency !== 'none' ? String(a.emergency) : null;
    objects.push({
      type: 'aircraft', key: hex, name: callsign || a.r || hex.toUpperCase(), lon, lat,
      status: onGround ? 'ground' : 'airborne', severity: emergency ? 3 : 0,
      props: compact({
        callsign, aircraft_type: a.t, registration: a.r, altitude_m: altFt == null ? null : Math.round(altFt * FT_TO_M),
        ground_speed_kt: num(a.gs), track_deg: num(a.track), vertical_rate_ms: num(a.baro_rate) == null ? null : round((a.baro_rate as number) * FPM_TO_MS, 2),
        squawk: a.squawk == null ? null : String(a.squawk), emergency: a.emergency == null ? null : String(a.emergency),
      }),
    });
  }
  return [{ source: 'adsb', fetchedAt, observedAt: fetchedAt, objects, replaceTypes: ['aircraft'] }];
}
