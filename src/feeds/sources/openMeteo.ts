// Open-Meteo forecast, marine and air-quality APIs (model output, not observations) -> weather_station objects
// for a few named points, and the scene's wind / cloud / wave state.
import type { IngestBatch, ObjectInput, ObsInput } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { compact, haversineKm, nearest, num, parseTime, slug } from '../util.ts';

/** Request order matters: Open-Meteo answers with one entry per requested point, in order, at snapped grid coordinates. */
export const OM_POINTS: { name: string; lat: number; lon: number }[] = [
  { name: 'San Juan', lat: 18.46, lon: -66.1 }, { name: 'Ponce', lat: 18.01, lon: -66.61 }, { name: 'Mayagüez', lat: 18.2, lon: -67.14 },
  { name: 'Arecibo', lat: 18.47, lon: -66.72 }, { name: 'Vieques', lat: 18.15, lon: -65.44 }, { name: 'Fajardo', lat: 18.34, lon: -65.65 },
  { name: 'Caguas', lat: 18.23, lon: -66.04 }, { name: 'Aguadilla', lat: 18.43, lon: -67.15 },
];
/** Offshore points; the first (north of San Juan) drives the scene's sea state. */
export const OM_MARINE: { name: string; lat: number; lon: number }[] = [
  { name: 'north', lat: 18.6, lon: -66.1 }, { name: 'south', lat: 17.85, lon: -66.5 }, { name: 'west', lat: 18.25, lon: -67.4 }, { name: 'east', lat: 18.25, lon: -65.1 },
];
const list = (pts: { lat: number; lon: number }[], k: 'lat' | 'lon') => pts.map((p) => p[k]).join(',');
export const omForecastUrl = () => `https://api.open-meteo.com/v1/forecast?latitude=${list(OM_POINTS, 'lat')}&longitude=${list(OM_POINTS, 'lon')}` +
  '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,cloud_cover,pressure_msl&wind_speed_unit=ms&timezone=GMT';
export const omMarineUrl = () => `https://marine-api.open-meteo.com/v1/marine?latitude=${list(OM_MARINE, 'lat')}&longitude=${list(OM_MARINE, 'lon')}` +
  '&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,sea_surface_temperature,sea_level_height_msl&timezone=GMT';
export const omAirUrl = () => `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${list(OM_POINTS, 'lat')}&longitude=${list(OM_POINTS, 'lon')}` +
  '&current=pm10,pm2_5,dust,us_aqi,aerosol_optical_depth&timezone=GMT';

const arr = (x: any): any[] => (Array.isArray(x) ? x : x && typeof x === 'object' && x.current ? [x] : []);
/** A response entry belongs to the requested point only if it sits on a nearby grid cell (guards against a reordered or shorter reply). */
const matches = (entry: any, p: { lat: number; lon: number }, km: number) => entry && num(entry.latitude) != null && num(entry.longitude) != null && haversineKm(p.lat, p.lon, entry.latitude, entry.longitude) <= km;
/** Open-Meteo times are 'YYYY-MM-DDTHH:MM' in the requested zone (GMT here). */
const omTime = (t: unknown) => (typeof t === 'string' ? parseTime(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z') : null);

export interface OmWeather { windMs?: number; windDirDeg?: number; cloudCover?: number; waveHeightM?: number; wavePeriodS?: number; waveDirDeg?: number; observedAt?: number }
export interface OmResult { batches: IngestBatch[]; weather: OmWeather }

export function mapOpenMeteoDetailed(payload: { forecast?: any; marine?: any; air?: any }, ctx: MapContext): OmResult {
  const fc = arr(payload.forecast), marine = arr(payload.marine), air = arr(payload.air);
  const marinePts = OM_MARINE.map((p, i) => ({ ...p, entry: marine[i] })).filter((m) => matches(m.entry, m, 30) && num(m.entry.current?.wave_height) != null);
  const objects: ObjectInput[] = [];
  const obs: ObsInput[] = [];
  const weather: OmWeather = {};
  let u = 0, v = 0, speed = 0, cloud = 0, nWind = 0, nCloud = 0, newest = 0;
  OM_POINTS.forEach((p, i) => {
    const e = fc[i];
    if (!matches(e, p, 30) || !e.current) return;
    const c = e.current;
    const t = omTime(c.time) ?? ctx.now;
    if (t > newest) newest = t;
    const key = 'om-' + slug(p.name);
    const sea = nearest(p.lat, p.lon, marinePts);
    const a = matches(air[i], p, 40) ? air[i].current : null;
    const props: NonNullable<ObjectInput['props']> = compact({
      temp_c: num(c.temperature_2m), wind_ms: num(c.wind_speed_10m), wind_dir_deg: num(c.wind_direction_10m), gust_ms: num(c.wind_gusts_10m),
      pressure_hpa: num(c.pressure_msl), humidity_pct: num(c.relative_humidity_2m), cloud_cover_pct: num(c.cloud_cover), precip_mm: num(c.precipitation),
    });
    for (const k of Object.keys(props)) props[k] = { value: props[k] as number, observedAt: t };
    if (sea) props.wave_height_m = { value: sea.item.entry.current.wave_height, observedAt: omTime(sea.item.entry.current.time) ?? t };
    if (a) {
      const at = omTime(a.time) ?? t;
      if (num(a.dust) != null) props.dust_ugm3 = { value: a.dust, observedAt: at };
      if (num(a.us_aqi) != null) props.us_aqi = { value: a.us_aqi, observedAt: at };
    }
    objects.push({ type: 'weather_station', key, name: `${p.name} (Open-Meteo model)`, lon: p.lon, lat: p.lat, props });
    const object = `weather_station:${key}`;
    if (num(c.temperature_2m) != null) obs.push({ object, metric: 'temp_c', t, value: c.temperature_2m });
    if (num(c.wind_speed_10m) != null) obs.push({ object, metric: 'wind_ms', t, value: c.wind_speed_10m });
    if (num(c.pressure_msl) != null) obs.push({ object, metric: 'pressure_hpa', t, value: c.pressure_msl });
    const ws = num(c.wind_speed_10m), wd = num(c.wind_direction_10m), cc = num(c.cloud_cover);
    if (ws != null && wd != null) { u += ws * Math.sin((wd * Math.PI) / 180); v += ws * Math.cos((wd * Math.PI) / 180); speed += ws; nWind++; }
    if (cc != null) { cloud += cc; nCloud++; }
  });
  if (nWind) {
    weather.windMs = speed / nWind;                                             // mean speed, vector-mean direction
    weather.windDirDeg = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  }
  if (nCloud) weather.cloudCover = cloud / nCloud / 100;
  const north = matches(marine[0], OM_MARINE[0], 30) ? marine[0].current : null;
  if (north) {
    if (num(north.wave_height) != null) weather.waveHeightM = north.wave_height;
    if (num(north.wave_period) != null) weather.wavePeriodS = north.wave_period;
    if (num(north.wave_direction) != null) weather.waveDirDeg = north.wave_direction;
  }
  if (newest) weather.observedAt = newest;
  return { batches: [{ source: 'open_meteo', fetchedAt: ctx.now, observedAt: newest || ctx.now, objects, obs, note: 'model output' }], weather };
}
export function mapOpenMeteo(payload: { forecast?: any; marine?: any; air?: any }, ctx: MapContext): IngestBatch[] {
  return mapOpenMeteoDetailed(payload, ctx).batches;
}
