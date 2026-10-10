// NWS latest surface observation per station (GeoJSON, SI with unitCode) -> weather_station readings.
import type { IngestBatch, ObjectInput, ObsInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { KMH_TO_MS, num, parseTime, round, stamped } from '../util.ts';

export const NWS_OBS_STATIONS = ['TJSJ', 'TJBQ', 'TJPS', 'TJMZ', 'TJIG', 'TJNR', 'TJRV'];
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
