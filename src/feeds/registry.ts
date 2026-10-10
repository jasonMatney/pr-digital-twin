// The Feed objects: fetch wrapper + signal writes around the pure mappers in sources/. Browser-side module
// (imports core/state); tests import the mappers directly.
import type { IngestBatch } from '../ontology/types.ts';
import * as S from '../core/state';
import type { Feed, FeedContext, MapContext } from './types.ts';
import { relayUrl } from './fixtures.ts';
import { unwrapRelay } from './util.ts';
import { mapNwsAlerts, NWS_ALERTS_URL } from './sources/nwsAlerts.ts';
import { mapUsgsQuakes, quakesUrl } from './sources/usgsQuakes.ts';
import { mapUsgsNwis, NWIS_URL } from './sources/usgsNwis.ts';
import { mapNwps, NWPS_URL } from './sources/nwps.ts';
import { COOPS_DEFAULT_STATIONS, coopsHistoryUrl, coopsLatestUrl, coopsPredictionsUrl, coopsSeries, mapCoopsDetailed, SAN_JUAN_STATION } from './sources/coops.ts';
import type { CoopsStationInput } from './sources/coops.ts';
import { mapOpenMeteoDetailed, omAirUrl, omForecastUrl, omMarineUrl } from './sources/openMeteo.ts';
import { mapNwsObs, NWS_OBS_STATIONS, nwsObsUrl } from './sources/nwsObs.ts';
import { mapNhc } from './sources/nhc.ts';
import { mapNdbc, parseNdbcLatestObs } from './sources/ndbc.ts';
import { mapLuma } from './sources/luma.ts';
import { mapAdsb } from './sources/adsb.ts';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const GEOJSON = { headers: { Accept: 'application/geo+json' } };

/** Resolves to null instead of rejecting: one station or one of three APIs failing must not sink the whole run. */
const soft = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
function requireSome<T>(items: (T | null)[], what: string): T[] {
  const ok = items.filter((x): x is T => x != null);
  if (!ok.length) throw new Error(`${what}: every request failed`);
  return ok;
}
async function municipios(ctx: FeedContext): Promise<MapContext['municipios']> {
  if (!ctx.store) return undefined;
  try {
    const rows = await ctx.store.listObjects('municipio', { limit: 200, props: [] });
    return rows.filter((m) => m.lon != null && m.lat != null).map((m) => ({ id: m.id, lon: m.lon as number, lat: m.lat as number }));
  } catch { return undefined; }
}

const nwsAlerts: Feed = {
  id: 'nws_alerts', label: 'NWS alerts', cadenceMs: 2 * MIN,
  async run(ctx) { return mapNwsAlerts(await ctx.fetchJson(NWS_ALERTS_URL, GEOJSON), { now: ctx.now() }); },
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
    // Which USGS sites the seed calls a reservoir and which a gauge (see NwisContext.knownTypes).
    const knownTypes: Record<string, 'stream_gauge' | 'reservoir'> = {};
    if (ctx.store) {
      try { for (const o of await ctx.store.listObjects(['stream_gauge', 'reservoir'], { limit: 5000, props: [] })) knownTypes[o.key] = o.type as 'stream_gauge' | 'reservoir'; } catch { /* fall back to the rule */ }
    }
    return mapUsgsNwis(await ctx.fetchJson(NWIS_URL), { now: ctx.now(), knownTypes });
  },
};

const nwps: Feed = {
  id: 'nwps', label: 'NWPS flood categories', cadenceMs: 15 * MIN,
  async run(ctx) { return mapNwps(await ctx.fetchJson(NWPS_URL), { now: ctx.now() }); },
};

const coopsCache = { predictions: new Map<string, [number, number][]>(), historyAt: 0 };
/** CO-OPS answers `{ error: { message } }` (often with HTTP 200/400) for a station without the product. */
const coopsOk = (p: any) => (p && !p.error ? p : null);
const coops: Feed = {
  id: 'coops', label: 'NOAA tides', cadenceMs: 6 * MIN,
  async run(ctx) {
    const now = ctx.now();
    let ids = COOPS_DEFAULT_STATIONS.map((s) => s.id);
    if (ctx.store) {
      try { const rows = await ctx.store.listObjects('tide_station', { limit: 100, props: [] }); if (rows.length) ids = rows.map((r) => r.key); } catch { /* keep the default set */ }
    }
    // 72 h of history plus predictions at start and hourly; only the latest reading in between.
    const full = now - coopsCache.historyAt >= HOUR;
    const hours = coopsCache.historyAt ? Math.min(72, Math.max(2, Math.ceil((now - coopsCache.historyAt) / HOUR) + 1)) : 72;
    const inputs = await Promise.all(ids.map(async (id): Promise<CoopsStationInput | null> => {
      const latest = coopsOk(await soft(ctx.fetchJson(coopsLatestUrl(id))));
      if (!latest && !full) return null;
      const input: CoopsStationInput = { id, latest: latest ?? undefined, cachedPredictions: coopsCache.predictions.get(id) };
      if (full) {
        const [history, predictions] = await Promise.all([
          soft(ctx.fetchJson(coopsHistoryUrl(id, hours))), soft(ctx.fetchJson(coopsPredictionsUrl(id, now - hours * HOUR, hours + 24))),
        ]);
        input.history = coopsOk(history) ?? undefined;
        input.predictions = coopsOk(predictions) ?? undefined;
        const series = coopsSeries(input.predictions?.predictions);
        if (series.length) coopsCache.predictions.set(id, series);
      }
      return input.latest || input.history ? input : null;
    }));
    const { batches, latest } = mapCoopsDetailed(requireSome(inputs, 'CO-OPS'), { now });
    if (full) coopsCache.historyAt = now;
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

const nwsObs: Feed = {
  id: 'nws_obs', label: 'NWS observations', cadenceMs: 10 * MIN,
  async run(ctx) {
    const payloads = await Promise.all(NWS_OBS_STATIONS.map((id) => soft(ctx.fetchJson(nwsObsUrl(id), GEOJSON))));
    return mapNwsObs(requireSome(payloads, 'NWS observations'), { now: ctx.now() });
  },
};

/** Relay feeds: one file on the `relay` branch each, written by pipeline/relay.mjs every ten minutes. */
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
const nhc = relayFeed('nhc', 'NHC tropical cyclones', 'nhc.json', mapNhc);
const ndbc = relayFeed('ndbc', 'NDBC buoys', 'ndbc.json', mapNdbc, parseNdbcLatestObs);
const luma = relayFeed('luma', 'LUMA outages', 'luma.json', mapLuma);
const adsb = relayFeed('adsb', 'Aircraft (ADS-B)', 'adsb.json', mapAdsb);

/** In first-run order: alerts, cyclones, quakes, gauges, tides, weather, outages, buoys, aircraft. */
export const FEEDS: Feed[] = [nwsAlerts, nhc, usgsQuakes, usgsNwis, nwps, coops, openMeteo, nwsObs, luma, ndbc, adsb];
