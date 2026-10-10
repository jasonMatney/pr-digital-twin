// The Feed objects: fetch wrapper + signal writes around the pure mappers in sources/. Browser-side module
// (imports core/state); tests import the mappers directly.
import type { IngestBatch } from '../ontology/types.ts';
import * as S from '../core/state';
import type { Feed, FeedContext, MapContext } from './types.ts';
import { relayUrl } from './fixtures.ts';
import { unwrapRelay } from './util.ts';
import { cycloneForecasts } from './cyclones.ts';
import { mapNwsAlerts, NWS_ALERTS_URL } from './sources/nwsAlerts.ts';
import { mapUsgsQuakes, quakesUrl } from './sources/usgsQuakes.ts';
import { mapUsgsNwis, NWIS_URL } from './sources/usgsNwis.ts';
import { mapNwps, NWPS_URL } from './sources/nwps.ts';
import { COOPS_DEFAULT_STATIONS, coopsOutcome, coopsSeries, mapCoopsDetailed, newCoopsSession, planCoops, SAN_JUAN_STATION } from './sources/coops.ts';
import type { CoopsStationInput } from './sources/coops.ts';
import { mapOpenMeteoDetailed, omAirUrl, omForecastUrl, omMarineUrl } from './sources/openMeteo.ts';
import { chooseObsStations, mapNwsObs, NWS_OBS_MAX, NWS_OBS_STATIONS, nwsObsUrl } from './sources/nwsObs.ts';
import { mapNhc } from './sources/nhc.ts';
import { attachForecast, NHC_FORECAST_MAX_KM, nhcForecastUrls, parseNhcForecast } from './sources/nhcForecast.ts';
import type { CycloneForecast } from './sources/nhcForecast.ts';
import { mapNdbc, parseNdbcLatestObs } from './sources/ndbc.ts';
import { mapLuma } from './sources/luma.ts';
import { mapAdsb } from './sources/adsb.ts';

const MIN = 60_000, DAY = 86_400_000;
const GEOJSON = { headers: { Accept: 'application/geo+json' } };
type GaugeType = 'stream_gauge' | 'reservoir';

/** Resolves to null instead of rejecting: one station or one of three APIs failing must not sink the whole run. */
const soft = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
async function municipios(ctx: FeedContext): Promise<MapContext['municipios']> {
  if (!ctx.store) return undefined;
  try {
    const rows = await ctx.store.listObjects('municipio', { limit: 200, props: [] });
    return rows.filter((m) => m.lon != null && m.lat != null).map((m) => ({ id: m.id, lon: m.lon as number, lat: m.lat as number }));
  } catch { return undefined; }
}

const nwsAlerts: Feed = {
  id: 'nws_alerts', label: 'NWS alerts', cadenceMs: 2 * MIN,
  async run(ctx) {
    const batches = mapNwsAlerts(await ctx.fetchJson(NWS_ALERTS_URL, GEOJSON), { now: ctx.now() });
    // Recorded alerts have all ended: date the batch at the recording, not at the feed's last (older) update.
    if (ctx.fixtures) for (const b of batches) b.observedAt = ctx.now();
    return batches;
  },
};

let quakesPrimed = false;
const usgsQuakes: Feed = {
  id: 'usgs_quakes', label: 'USGS earthquakes', cadenceMs: 5 * MIN,
  async run(ctx) {
    // 30 days once (history for the timeline), then a 2-day window that still catches late magnitude revisions.
    const payload = await ctx.fetchJson(quakesUrl(ctx.now() - (quakesPrimed ? 2 : 30) * DAY));
    const batches = mapUsgsQuakes(payload, { now: ctx.now(), municipios: await municipios(ctx) });
    quakesPrimed = true;
    return batches;
  },
};

const usgsNwis: Feed = {
  id: 'usgs_nwis', label: 'USGS stream gauges', cadenceMs: 15 * MIN,
  async run(ctx) {
    // Which USGS sites the store holds, and as what. Sites it does not hold that report only rain are left out.
    const knownTypes: Record<string, GaugeType> = {};
    if (ctx.store) {
      try { for (const o of await ctx.store.listObjects(['stream_gauge', 'reservoir'], { limit: 5000, props: [] })) knownTypes[o.key] = o.type as GaugeType; } catch { /* fall back to the rule */ }
    }
    return mapUsgsNwis(await ctx.fetchJson(NWIS_URL), { now: ctx.now(), knownTypes });
  },
};

const nwps: Feed = {
  id: 'nwps', label: 'NWPS flood categories', cadenceMs: 15 * MIN,
  async run(ctx) {
    // The store merges on (scheme, key, type), so a gauge must be sent under the type the seed gave it.
    const knownTypes: Record<string, GaugeType> = {};
    if (ctx.store) {
      try {
        const rows = await ctx.store.query<{ key: string; type: string }>("SELECT key, type FROM identity WHERE scheme = 'nws:lid'");
        for (const r of rows) if (r.type === 'stream_gauge' || r.type === 'reservoir') knownTypes[r.key] = r.type;
      } catch { /* fall back to the name */ }
    }
    return mapNwps(await ctx.fetchJson(NWPS_URL), { now: ctx.now(), knownTypes });
  },
};

const coopsSession = newCoopsSession();
const coops: Feed = {
  id: 'coops', label: 'NOAA tides', cadenceMs: 6 * MIN,
  async run(ctx) {
    const now = ctx.now();
    let ids = COOPS_DEFAULT_STATIONS.map((s) => s.id);
    if (ctx.store) {
      try { const rows = await ctx.store.listObjects('tide_station', { limit: 100, props: [] }); if (rows.length) ids = rows.map((r) => r.key); } catch { /* keep the default set */ }
    }
    const plan = planCoops(ids, coopsSession, now);
    // Stations in parallel, a station's own requests in order: one that has no water level is not asked for
    // predictions either, which halves the refusals on the probing run.
    const byStation = new Map<string, typeof plan.requests>();
    for (const r of plan.requests) { const list = byStation.get(r.id); if (list) list.push(r); else byStation.set(r.id, [r]); }
    const results = (await Promise.all([...byStation.values()].map(async (requests) => {
      const out: { r: (typeof requests)[number]; payload: any; error: any }[] = [];
      for (const r of requests) {
        const res = await ctx.fetchJson(r.url).then((payload) => ({ r, payload, error: undefined }), (error) => ({ r, payload: undefined, error }));
        out.push(res);
        if (r.product !== 'predictions' && coopsOutcome(res) !== 'ok') break;
      }
      return out;
    }))).flat();
    const inputs = new Map<string, CoopsStationInput>();
    const noLevel: string[] = [], noPredictions: string[] = [];
    for (const { r, payload, error } of results) {
      const outcome = coopsOutcome({ payload, error });
      let input = inputs.get(r.id);
      if (!input) inputs.set(r.id, (input = { id: r.id, cachedPredictions: coopsSession.predictions.get(r.id) }));
      if (r.product === 'predictions') {
        if (outcome === 'ok') { input.predictions = payload; const series = coopsSeries(payload.predictions); if (series.length) coopsSession.predictions.set(r.id, series); }
        else if (outcome === 'unavailable') noPredictions.push(r.id);
      } else if (outcome === 'ok') input[r.product] = payload;
      else if (outcome === 'unavailable') noLevel.push(r.id);
    }
    const answered = [...inputs.values()].filter((i) => i.latest || i.history);
    if (plan.requests.length && !answered.length) throw new Error('CO-OPS: no station returned a water level');
    // Stations without the product are not asked again this session. Only believed when some station did answer:
    // if all of them refuse, the service is the problem, not thirteen sensors.
    for (const id of noLevel) coopsSession.noLevel.add(id);
    for (const id of noPredictions) coopsSession.noPredictions.add(id);
    if (plan.full) coopsSession.historyAt = now;
    const { batches, latest } = mapCoopsDetailed(answered, { now });
    const sj = latest[SAN_JUAN_STATION];
    if (sj) S.weather.value = { ...S.weather.value, tideM: sj.waterLevelM, source: 'live', observedAt: Math.max(S.weather.value.observedAt, sj.t) };
    return batches;
  },
};

const openMeteo: Feed = {
  id: 'open_meteo', label: 'Open-Meteo model', cadenceMs: 15 * MIN,
  async run(ctx) {
    const [forecast, marine, air] = await Promise.all([soft(ctx.fetchJson(omForecastUrl())), soft(ctx.fetchJson(omMarineUrl())), soft(ctx.fetchJson(omAirUrl()))]);
    if (!forecast) throw new Error('Open-Meteo forecast request failed');
    const { batches, weather } = mapOpenMeteoDetailed({ forecast, marine, air }, { now: ctx.now() });
    // Only the fields the model returned are replaced; the rest keep their last value.
    if (weather.windMs != null || weather.waveHeightM != null) S.weather.value = { ...S.weather.value, ...weather, source: 'live' } as S.Weather;
    return batches;
  },
};

/** dead: answered 404 this session. tried: every station asked so far (caps how many replacements are probed). */
const obsSession = { dead: new Set<string>(), tried: new Set<string>(), picked: [] as string[] };
const nwsObs: Feed = {
  id: 'nws_obs', label: 'NWS observations', cadenceMs: 10 * MIN,
  async run(ctx) {
    let ids = NWS_OBS_STATIONS.filter((id) => !obsSession.dead.has(id));
    if (ctx.store) {
      try {
        const pool = await ctx.store.listObjects('weather_station', { limit: 1000, props: [] });
        const picked = chooseObsStations(pool, { exclude: obsSession.dead, keep: obsSession.picked, budget: Math.max(0, 2 * NWS_OBS_MAX - obsSession.tried.size) });
        if (picked.length) ids = picked;
      } catch { /* keep the default set */ }
    }
    for (const id of ids) obsSession.tried.add(id);
    const payloads = await Promise.all(ids.map((id) => ctx.fetchJson(nwsObsUrl(id), GEOJSON).catch((e) => { if (e?.status === 404) obsSession.dead.add(id); return null; })));
    obsSession.picked = ids.filter((id) => !obsSession.dead.has(id));
    const ok = payloads.filter((p) => p != null);
    if (!ok.length) throw new Error('NWS observations: every request failed');
    return mapNwsObs(ok, { now: ctx.now() });
  },
};

/** Forecast per storm, kept while the advisory it belongs to is current so each advisory is fetched once. */
const forecastCache = new Map<string, { advisoryKey: string; settled: boolean; forecast: CycloneForecast }>();
const advNum = (v: unknown) => String(v ?? '').trim().replace(/^0+/, '').toUpperCase();
const nhc: Feed = {
  id: 'nhc', label: 'NHC tropical cyclones', cadenceMs: 10 * MIN,
  async run(ctx) {
    const relay = unwrapRelay(await ctx.fetchJson(relayUrl('nhc.json')), ctx.now());
    const batches = mapNhc(relay.data, { now: ctx.now(), fetchedAt: relay.fetchedAt });
    const forecasts: Record<string, CycloneForecast> = {};
    for (const o of batches[0]?.objects ?? []) {
      const storm = (relay.data?.activeStorms ?? []).find((s: any) => String(s?.id ?? '').toLowerCase() === o.key);
      const km = Number((o.props as any)?.distance_to_pr_km);
      if (!storm || !(km <= NHC_FORECAST_MAX_KM)) continue;
      const advisoryKey = String(storm.lastUpdate ?? '');
      let entry = forecastCache.get(o.key);
      const urls = ctx.fixtures ? null : nhcForecastUrls(storm.binNumber);      // no query response was recorded
      if (urls && (!entry || entry.advisoryKey !== advisoryKey || !entry.settled)) {
        const [points, cone] = await Promise.all([soft(ctx.fetchJson(urls.points)), soft(ctx.fetchJson(urls.cone))]);
        const forecast = parseNhcForecast(points, cone, storm);
        if (forecast) {
          // The map service can lag the advisory by a few minutes: keep asking until its advisory number matches.
          const want = advNum(storm.publicAdvisory?.advNum);
          entry = { advisoryKey, forecast, settled: !want || !forecast.advisory || advNum(forecast.advisory) === want };
          forecastCache.set(o.key, entry);
        }
      }
      if (entry) { attachForecast(batches[0], o.key, entry.forecast); forecasts[o.key] = entry.forecast; }
    }
    for (const id of forecastCache.keys()) if (!(batches[0]?.objects ?? []).some((o) => o.key === id)) forecastCache.delete(id);
    cycloneForecasts.value = forecasts;
    return batches;
  },
};

/** Relay feeds: one file on the `relay` branch each, written by pipeline/relay.mjs. */
function relayFeed(id: string, label: string, file: string, map: (data: any, ctx: MapContext & { fetchedAt?: number }) => IngestBatch[], parseFixture?: (text: string) => any): Feed {
  return {
    id, label, cadenceMs: 10 * MIN,
    async run(ctx) {
      const url = relayUrl(file);
      // In fixtures mode the recorded file is the raw upstream payload, which for NDBC is text.
      const payload = ctx.fixtures && parseFixture ? parseFixture(await ctx.fetchText(url)) : await ctx.fetchJson(url);
      const relay = unwrapRelay(payload, ctx.now());
      return map(relay.data, { now: ctx.now(), fetchedAt: relay.fetchedAt });
    },
  };
}
const ndbc = relayFeed('ndbc', 'NDBC buoys', 'ndbc.json', mapNdbc, parseNdbcLatestObs);
const luma = relayFeed('luma', 'LUMA outages', 'luma.json', mapLuma);
const adsb = relayFeed('adsb', 'Aircraft (ADS-B)', 'adsb.json', mapAdsb);

/** In first-run order: alerts, cyclones, quakes, gauges, tides, weather, outages, buoys, aircraft. */
export const FEEDS: Feed[] = [nwsAlerts, nhc, usgsQuakes, usgsNwis, nwps, coops, openMeteo, nwsObs, luma, ndbc, adsb];
