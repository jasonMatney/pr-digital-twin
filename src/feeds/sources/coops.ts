// NOAA CO-OPS water levels and tide predictions (datum MSL, metric, GMT) -> tide_station readings.
import type { IngestBatch, ObjectInput, ObsInput, PropValue } from '../../ontology/types.ts';
import type { MapContext } from '../types.ts';
import { num, round } from '../util.ts';

/** Used when the store has no tide_station objects yet. */
export const COOPS_DEFAULT_STATIONS: { id: string; name: string }[] = [
  { id: '9755371', name: 'San Juan' }, { id: '9759110', name: 'Magueyes Island' }, { id: '9753216', name: 'Fajardo' },
  { id: '9757809', name: 'Arecibo' }, { id: '9759394', name: 'Mayagüez' }, { id: '9752235', name: 'Culebra' },
  { id: '9752695', name: 'Esperanza (Vieques)' }, { id: '9759938', name: 'Mona Island' }, { id: '9754228', name: 'Yabucoa Harbor' },
  { id: '9758053', name: 'Peñuelas' },
];
export const SAN_JUAN_STATION = '9755371';
const API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const COMMON = 'datum=MSL&time_zone=gmt&units=metric&format=json&application=garita';
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace(/-/g, '').replace('T', ' ');   // 'yyyyMMdd HH:mm'
export const coopsLatestUrl = (station: string) => `${API}?date=latest&station=${station}&product=water_level&${COMMON}`;
export const coopsHistoryUrl = (station: string, hours = 72) => `${API}?range=${hours}&station=${station}&product=water_level&${COMMON}`;
/** Predictions from `fromMs` for `hours` hours: reaches past "now" so later 6-minute readings have a prediction to compare with. */
export const coopsPredictionsUrl = (station: string, fromMs: number, hours: number) =>
  `${API}?begin_date=${encodeURIComponent(stamp(fromMs))}&range=${hours}&station=${station}&product=predictions&interval=6&${COMMON}`;

/** 'YYYY-MM-DD HH:MM' in GMT -> epoch ms. */
export function coopsTime(t: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(t).trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}
export function coopsSeries(rows: any[] | undefined): [t: number, v: number][] {
  const out: [number, number][] = [];
  for (const r of rows ?? []) { const t = coopsTime(r?.t), v = num(r?.v); if (t != null && v != null) out.push([t, v]); }
  return out.sort((a, b) => a[0] - b[0]);
}
/** Prediction at time t: exact sample, or linear interpolation between neighbours at most 1 h apart. */
export function predictedAt(pred: [number, number][], t: number): number | null {
  let lo = 0, hi = pred.length - 1;
  if (hi < 0 || t < pred[0][0] || t > pred[hi][0]) return null;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pred[mid][0] <= t) lo = mid; else hi = mid; }
  if (pred[lo][0] === t) return pred[lo][1];
  if (pred[hi][0] === t) return pred[hi][1];
  if (pred[hi][0] - pred[lo][0] > 3600e3) return null;
  return pred[lo][1] + ((pred[hi][1] - pred[lo][1]) * (t - pred[lo][0])) / (pred[hi][0] - pred[lo][0]);
}

export interface CoopsStationInput {
  id: string;
  /** datagetter payloads; any may be missing (a station without a sensor answers `{ error }`). */
  latest?: any; history?: any; predictions?: any;
  /** Predictions kept from an earlier run, used when `predictions` was not fetched this time. */
  cachedPredictions?: [number, number][];
}
export interface CoopsResult { batches: IngestBatch[]; latest: Record<string, { t: number; waterLevelM: number; predictedM: number | null }> }

export function mapCoopsDetailed(stations: CoopsStationInput[], ctx: MapContext): CoopsResult {
  const objects: ObjectInput[] = [];
  const obs: ObsInput[] = [];
  const latest: CoopsResult['latest'] = {};
  let newest = 0;
  for (const s of stations) {
    const id = String(s.id);
    const meta = s.latest?.metadata ?? s.history?.metadata;
    const observed = coopsSeries([...(s.history?.data ?? []), ...(s.latest?.data ?? [])]);
    const fresh = coopsSeries(s.predictions?.predictions);
    const pred = fresh.length ? fresh : s.cachedPredictions ?? [];
    const object = `tide_station:${id}`;
    let lastT = -1;
    for (const [t, v] of observed) { if (t === lastT) continue; lastT = t; obs.push({ object, metric: 'water_level_m', t, value: v }); }
    for (const [t, v] of fresh) obs.push({ object, metric: 'predicted_m', t, value: v });
    if (!observed.length) continue;       // predictions alone do not make a reading
    const [t, level] = observed[observed.length - 1];
    const p = predictedAt(pred, t);
    const props: Record<string, { value: PropValue; observedAt: number }> = { water_level_m: { value: level, observedAt: t } };
    if (p != null) {
      props.predicted_m = { value: round(p, 3), observedAt: t };
      props.residual_m = { value: round(level - p, 3), observedAt: t };
    }
    latest[id] = { t, waterLevelM: level, predictedM: p };
    if (t > newest) newest = t;
    const lon = num(meta?.lon), lat = num(meta?.lat);
    const o: ObjectInput = { type: 'tide_station', key: id, props };
    if (meta?.name) o.name = meta.name;
    if (lon != null && lat != null) { o.lon = lon; o.lat = lat; }
    objects.push(o);
  }
  return { batches: [{ source: 'coops', fetchedAt: ctx.now, observedAt: newest || ctx.now, objects, obs }], latest };
}
export function mapCoops(stations: CoopsStationInput[], ctx: MapContext): IngestBatch[] {
  return mapCoopsDetailed(stations, ctx).batches;
}
