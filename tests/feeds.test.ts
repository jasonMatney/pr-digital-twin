// Every feed's mapper against the payload recorded from its real endpoint (tests/fixtures, 2026-10-10 04:32Z).
// Spot values below were read from the fixture files by hand; the comment next to each says where.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { IngestBatch, Ontology } from '../src/ontology/types.ts';
import { validateBatch } from '../src/ontology/validate.ts';
import { fixtureFor, relayUrl } from '../src/feeds/fixtures.ts';
import { haversineKm, slug, unwrapRelay } from '../src/feeds/util.ts';
import { alertKey, mapNwsAlerts, NWS_ALERTS_URL, sameToGeoid } from '../src/feeds/sources/nwsAlerts.ts';
import { mapUsgsQuakes, quakeSeverity, quakesUrl } from '../src/feeds/sources/usgsQuakes.ts';
import { mapUsgsNwis, NWIS_URL } from '../src/feeds/sources/usgsNwis.ts';
import { mapNwps, NWPS_URL, nwpsType } from '../src/feeds/sources/nwps.ts';
import { coopsHistoryUrl, coopsLatestUrl, coopsPredictionsUrl, coopsTime, mapCoopsDetailed, predictedAt } from '../src/feeds/sources/coops.ts';
import { mapOpenMeteoDetailed, omAirUrl, omForecastUrl, omMarineUrl } from '../src/feeds/sources/openMeteo.ts';
import { mapNwsObs, nwsObsUrl, quantity } from '../src/feeds/sources/nwsObs.ts';
import { cycloneSeverity, mapNhc } from '../src/feeds/sources/nhc.ts';
import { mapNdbc, parseNdbcLatestObs } from '../src/feeds/sources/ndbc.ts';
import { lumaTime, mapLuma, outageSeverity } from '../src/feeds/sources/luma.ts';
import { mapAdsb } from '../src/feeds/sources/adsb.ts';

const dir = new URL('./fixtures/', import.meta.url);
const text = (name: string) => readFileSync(new URL(name, dir), 'utf8');
const json = (name: string) => JSON.parse(text(name));
const ontology: Ontology = JSON.parse(readFileSync(new URL('../src/ontology/ontology.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-10T04:32:17Z');     // tests/fixtures/recorded_at.txt
const ctx = { now: NOW };

function valid(batches: IngestBatch[], source: string): IngestBatch {
  assert.equal(batches.length, 1);
  const b = batches[0];
  assert.equal(b.source, source);
  assert.deepEqual(validateBatch(b, ontology, { maxProblems: 5 }), []);
  return b;
}
const obj = (b: IngestBatch, id: string) => {
  const o = (b.objects ?? []).find((x) => `${x.type}:${x.key}` === id);
  assert.ok(o, `${id} missing from batch`);
  return o;
};
/** Property value, whether given bare or as { value, observedAt }. */
const val = (o: any, k: string) => { const p = o.props?.[k]; return p != null && typeof p === 'object' ? p.value : p; };
const at = (o: any, k: string) => o.props?.[k]?.observedAt;
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const count = <T>(xs: T[], f: (x: T) => unknown) => xs.filter(f).length;

test('nws_alerts: 40 recorded PR alerts', () => {
  const b = valid(mapNwsAlerts(json('nws_alerts_all_recent.json'), ctx), 'nws_alerts');
  assert.equal(b.objects!.length, 40);
  assert.deepEqual(b.replaceTypes, ['weather_alert']);
  // severities in the file: 26 Minor, 10 Moderate, 4 Severe
  assert.deepEqual([1, 2, 3].map((s) => count(b.objects!, (o) => o.severity === s)), [26, 10, 4]);
  assert.equal(count(b.objects!, (o) => o.geometry == null), 6);            // 6 zone-only alerts carry no polygon
  // features[0]: Flood Advisory, Mayaguez, SAME 072097, onset 17:51 AST, ends 18:00 AST
  const a = obj(b, 'weather_alert:2.49.0.1.840.0.49613e02dc29d5efe35163324c9a90fad247f9c3.001.1');
  assert.equal(a.name, 'Flood Advisory: Mayaguez, PR');
  assert.equal(a.severity, 1);
  assert.equal(a.validFrom, Date.parse('2026-10-09T21:51:00Z'));
  assert.equal(a.validTo, Date.parse('2026-10-09T22:00:00Z'));
  assert.equal(val(a, 'expires'), Date.parse('2026-10-09T22:01:00Z'));
  assert.equal(a.status, 'expired');
  assert.equal(a.geometry.type, 'Polygon');
  assert.equal(val(a, 'sender'), 'NWS San Juan PR');
  assert.deepEqual(b.links!.filter((l) => l.src.endsWith('49613e02dc29d5efe35163324c9a90fad247f9c3.001.1')), [
    { src: 'weather_alert:2.49.0.1.840.0.49613e02dc29d5efe35163324c9a90fad247f9c3.001.1', type: 'affects', dst: 'municipio:72097' },
  ]);
  // features[5]: Special Weather Statement, 19 SAME codes, UGC PRZ008..010, no `ends` -> validTo is `expires`
  const sws = b.links!.filter((l) => l.src.endsWith('34bd56e9681129289f789ec87a8adbc67d83d98d.001.1'));
  assert.equal(count(sws, (l) => l.dst.startsWith('municipio:72')), 19);
  assert.deepEqual(sws.filter((l) => l.dst.startsWith('forecast_zone:')).map((l) => l.dst), ['forecast_zone:PRZ008', 'forecast_zone:PRZ009', 'forecast_zone:PRZ010']);
  assert.equal(obj(b, 'weather_alert:2.49.0.1.840.0.34bd56e9681129289f789ec87a8adbc67d83d98d.001.1').validTo, Date.parse('2026-10-08T19:45:00Z'));
  assert.ok(b.links!.every((l) => /^municipio:72\d{3}$|^forecast_zone:PRZ\d{3}$/.test(l.dst)));
});
test('nws_alerts: the empty live file expires everything', () => {
  const b = valid(mapNwsAlerts(json('nws_alerts.json'), ctx), 'nws_alerts');
  assert.equal(b.objects!.length, 0);
  assert.deepEqual(b.replaceTypes, ['weather_alert']);
  assert.equal(b.observedAt, Date.parse('2026-10-10T04:30:32Z'));
  assert.equal(sameToGeoid('072127'), '72127');
  assert.equal(sameToGeoid('078010'), null);                                 // US Virgin Islands
  assert.equal(alertKey('https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc.001.1'), '2.49.0.1.840.0.abc.001.1');
});

test('usgs_quakes: 30 days, M>=2', () => {
  // A centroid near Las Marías (the first event is "2 km S of Las Marías") and one far away.
  const municipios = [{ id: 'municipio:72083', lon: -66.99, lat: 18.25 }, { id: 'municipio:72147', lon: -65.44, lat: 18.12 }];
  const b = valid(mapUsgsQuakes(json('usgs_quakes_30d.json'), { ...ctx, municipios }), 'usgs_quakes');
  assert.equal(b.objects!.length, 263);                                      // metadata.count
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => count(b.objects!, (o) => o.severity === s)), [194, 68, 1, 0, 0]);
  const big = obj(b, 'earthquake:pr2026261000');                             // M 4.8, 5 km SW of Guánica, depth 7 km, felt 86
  assert.equal(val(big, 'magnitude'), 4.8);
  assert.equal(big.severity, 2);
  assert.equal(val(big, 'depth_km'), 7);
  assert.equal(val(big, 'felt_reports'), 86);
  assert.equal(val(big, 'tsunami'), false);
  assert.equal(val(big, 'place'), '5 km SW of Guánica, Puerto Rico');
  const first = obj(b, 'earthquake:pr71536333');                             // features[0]
  assert.deepEqual([first.lon, first.lat], [-66.9921666666667, 18.2261666666667]);
  assert.equal(val(first, 'depth_km'), 18.11);
  assert.equal(first.validFrom, 1791601308900);
  assert.equal(at(first, 'magnitude'), 1791605424360);                       // properties.updated
  assert.equal(val(first, 'felt_reports'), undefined);                       // felt: null is left out, not written as 0
  assert.equal(val(first, 'url'), 'https://earthquake.usgs.gov/earthquakes/eventpage/pr71536333');
  const link = b.links!.find((l) => l.src === 'earthquake:pr71536333');
  assert.equal(link?.dst, 'municipio:72083');
  assert.ok(b.links!.every((l) => l.type === 'located_in') && b.links!.length < 263);
  assert.equal(mapUsgsQuakes(json('usgs_quakes_30d.json'), ctx)[0].links!.length, 0);   // no store, no links
  assert.deepEqual([2.99, 3, 3.9, 4, 4.9, 5, 5.9, 6, 7.1].map(quakeSeverity), [0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.match(quakesUrl(Date.parse('2026-10-08T12:00:00Z')), /starttime=2026-10-08&minmagnitude=2/);
});

test('usgs_nwis: instantaneous values in SI', () => {
  const b = valid(mapUsgsNwis(json('usgs_nwis_iv.json'), ctx), 'usgs_nwis');
  assert.equal(b.objects!.length, 157);                                      // 158 sites; 50038100 reports only -999999
  const g = obj(b, 'stream_gauge:50043800');                                 // RIO DE LA PLATA AT COMERIO: 5.42 ft, 39.5 ft3/s, 0.00 in
  assert.equal(g.name, 'RIO DE LA PLATA AT COMERIO, PR');
  assert.equal(val(g, 'stage_m'), 1.652);                                    // 5.42 * 0.3048 = 1.652016
  assert.equal(val(g, 'discharge_m3s'), 1.1185);                             // 39.5 * 0.028316846592 = 1.118515
  assert.equal(val(g, 'precip_1h_mm'), 0);
  assert.equal(at(g, 'stage_m'), Date.parse('2026-10-10T03:30:00Z'));        // 23:30 -04:00
  assert.ok(b.obs!.some((o) => o.object === 'stream_gauge:50043800' && o.metric === 'discharge_m3s' && o.value === 1.1185 && o.t === Date.parse('2026-10-10T03:30:00Z')));
  // -999999 (no data) at 50038100 and 50129254 must not become a reading
  assert.ok(b.obs!.every((o) => o.value > -1000));
  assert.ok(!b.obs!.some((o) => o.object === 'stream_gauge:50038100' && (o.metric === 'stage_m' || o.metric === 'discharge_m3s')));
  assert.ok(!b.obs!.some((o) => o.object === 'stream_gauge:50129254' && o.metric === 'stage_m'));
  // 62614 (lake elevation) with no stage or discharge makes a reservoir; none was reporting when the fixture was taken
  const lake = mapUsgsNwis({ value: { timeSeries: [{ sourceInfo: { siteName: 'X', siteCode: [{ value: '50059000' }], geoLocation: { geogLocation: { latitude: 18.3, longitude: -66 } } },
    variable: { variableCode: [{ value: '62614' }], noDataValue: -999999 }, values: [{ value: [{ value: '100.00', dateTime: '2026-10-10T00:00:00.000-04:00' }] }] }] } }, ctx)[0];
  assert.deepEqual(validateBatch(lake, ontology), []);
  assert.equal(val(obj(lake, 'reservoir:50059000'), 'lake_elev_m'), 30.48);
  // the store's type for a site wins: a site the seed holds as a reservoir never also appears as a gauge
  // (50043800 is a river; it stands in here because no lake reported 62614 in the fixture)
  const known = mapUsgsNwis(json('usgs_nwis_iv.json'), { ...ctx, knownTypes: { '50043800': 'reservoir' } })[0];
  assert.deepEqual(validateBatch(known, ontology), []);
  assert.equal(known.objects!.length, 156);
  assert.ok(!known.objects!.some((o) => o.key === '50043800') && !known.obs!.some((o) => o.object.endsWith(':50043800')));
});

test('nwps: flood category per gauge', () => {
  const b = valid(mapNwps(json('nwps_gauges.json'), ctx), 'nwps');
  assert.equal(b.objects!.length, 118);
  assert.equal(count(b.objects!, (o) => o.type === 'reservoir'), 27);
  assert.ok(b.objects!.every((o) => o.key.startsWith('nws-') && o.identities!.length === 1 && o.identities![0][0] === 'nws:lid' && 'nws-' + o.identities![0][1] === o.key));
  const c = obj(b, 'stream_gauge:nws-CRBP4');                                // action; 1.83 ft, 0.017 kcfs at 03:45Z
  assert.equal(c.severity, 1);
  assert.equal(val(c, 'flood_category'), 'action');
  assert.equal(val(c, 'forecast_category'), null);                           // fcst_not_current
  assert.equal(val(c, 'stage_m'), 0.558);                                    // 1.83 * 0.3048 = 0.557784
  assert.equal(val(c, 'discharge_m3s'), 0.4814);                             // 17 ft3/s * 0.028316846592 = 0.481386
  assert.equal(at(c, 'stage_m'), Date.parse('2026-10-10T03:45:00Z'));
  const q = obj(b, 'reservoir:nws-QUEP4');                                   // Lago Guajataca at Damsite: minor, 654.67 ft pool
  assert.equal(q.severity, 2);
  assert.equal(q.status, 'minor');
  assert.equal(val(q, 'lake_elev_m'), 199.543);                              // 654.67 * 0.3048 = 199.543416
  const stale = obj(b, 'stream_gauge:nws-NGIP4');                            // obs_not_current, primary -999
  assert.equal(stale.severity, null);
  assert.equal(val(stale, 'flood_category'), null);
  assert.equal(val(stale, 'stage_m'), undefined);
  assert.equal(obj(b, 'stream_gauge:nws-FAJP4').severity, 0);                // low_threshold
  assert.equal(nwpsType('Embalse La Plata'), 'reservoir');
  assert.equal(nwpsType('Rio Fajardo near Fajardo'), 'stream_gauge');
});

test('coops: San Juan water level, prediction and residual', () => {
  const input = { id: '9755371', latest: json('coops_latest_9755371.json'), history: json('coops_wl_9755371.json'), predictions: json('coops_pred_9755371.json') };
  const r = mapCoopsDetailed([input], ctx);
  const b = valid(r.batches, 'coops');
  const s = obj(b, 'tide_station:9755371');
  assert.equal(val(s, 'water_level_m'), 0.065);                              // latest: 2026-10-10 04:18 v 0.065
  assert.equal(val(s, 'predicted_m'), -0.07);                                // predictions at 04:18
  assert.equal(val(s, 'residual_m'), 0.135);
  assert.equal(at(s, 'water_level_m'), Date.parse('2026-10-10T04:18:00Z'));
  assert.deepEqual([s.lon, s.lat], [-66.1164, 18.4589]);
  assert.equal(count(b.obs!, (o) => o.metric === 'water_level_m'), 712);     // 718 rows, 6 with an empty value; the latest row is a duplicate
  assert.equal(count(b.obs!, (o) => o.metric === 'predicted_m'), 721);
  assert.deepEqual(r.latest['9755371'], { t: Date.parse('2026-10-10T04:18:00Z'), waterLevelM: 0.065, predictedM: -0.07 });
  // 6-minute runs fetch only the latest reading and reuse the cached predictions
  const cached: [number, number][] = [[Date.parse('2026-10-10T04:12:00Z'), -0.06], [Date.parse('2026-10-10T04:24:00Z'), -0.08]];
  const quick = mapCoopsDetailed([{ id: '9755371', latest: input.latest, cachedPredictions: cached }], ctx);
  assert.deepEqual(validateBatch(quick.batches[0], ontology), []);
  near(val(quick.batches[0].objects![0], 'predicted_m'), -0.07, 1e-9);       // interpolated half way
  assert.equal(quick.batches[0].obs!.length, 1);
  assert.equal(predictedAt(cached, Date.parse('2026-10-10T05:00:00Z')), null);
  assert.equal(coopsTime('2026-10-07 04:36'), Date.parse('2026-10-07T04:36:00Z'));
  // a station without a sensor answers { error }: no object, no throw
  assert.equal(mapCoopsDetailed([{ id: '9759938' }], ctx).batches[0].objects!.length, 0);
  assert.match(coopsPredictionsUrl('9755371', Date.parse('2026-10-07T04:30:00Z'), 96), /begin_date=20261007%2004%3A30&range=96&station=9755371&product=predictions/);
});

test('open_meteo: named points and the scene weather', () => {
  const r = mapOpenMeteoDetailed({ forecast: json('open_meteo_grid.json'), marine: json('open_meteo_marine.json'), air: json('open_meteo_air.json') }, ctx);
  const b = valid(r.batches, 'open_meteo');
  // the fixture holds 6 of the 8 points (recorded before Caguas and Aguadilla were added)
  assert.deepEqual(b.objects!.map((o) => o.key), ['om-san-juan', 'om-ponce', 'om-mayaguez', 'om-arecibo', 'om-vieques', 'om-fajardo']);
  const sj = obj(b, 'weather_station:om-san-juan');                          // [0].current
  assert.deepEqual(['temp_c', 'wind_ms', 'wind_dir_deg', 'gust_ms', 'pressure_hpa', 'humidity_pct', 'cloud_cover_pct', 'precip_mm'].map((k) => val(sj, k)), [27.8, 4.38, 97, 6.2, 1016, 78, 35, 0.1]);
  assert.equal(at(sj, 'temp_c'), Date.parse('2026-10-10T04:30:00Z'));
  assert.equal(val(sj, 'wave_height_m'), 1.18);                              // north marine point
  assert.deepEqual([val(sj, 'dust_ugm3'), val(sj, 'us_aqi')], [0, 18]);
  const ponce = obj(b, 'weather_station:om-ponce');
  assert.equal(val(ponce, 'wave_height_m'), 1.12);                           // south marine point
  assert.equal(val(ponce, 'us_aqi'), 16);
  assert.equal(val(obj(b, 'weather_station:om-mayaguez'), 'wave_height_m'), 0.84);   // west
  assert.equal(val(obj(b, 'weather_station:om-vieques'), 'wave_height_m'), 1.28);    // east
  assert.equal(val(obj(b, 'weather_station:om-arecibo'), 'us_aqi'), undefined);       // no air-quality point recorded there
  assert.equal(b.obs!.length, 18);
  near(r.weather.windMs!, (4.38 + 1.75 + 2.09 + 2.72 + 7.91 + 4.57) / 6, 1e-9);
  near(r.weather.cloudCover!, (35 + 4 + 0 + 22 + 46 + 74) / 600, 1e-9);
  assert.ok(r.weather.windDirDeg! > 70 && r.weather.windDirDeg! < 95, `dir ${r.weather.windDirDeg}`);   // easterly trades
  assert.deepEqual([r.weather.waveHeightM, r.weather.wavePeriodS, r.weather.waveDirDeg], [1.18, 5.45, 60]);
  assert.equal(r.weather.observedAt, Date.parse('2026-10-10T04:30:00Z'));
  // forecast alone still maps
  assert.equal(mapOpenMeteoDetailed({ forecast: json('open_meteo_grid.json') }, ctx).batches[0].objects!.length, 6);
});

test('nws_obs: TJSJ latest observation', () => {
  const b = valid(mapNwsObs([json('nws_obs_TJSJ.json')], ctx), 'nws_obs');
  const s = obj(b, 'weather_station:TJSJ');
  assert.equal(s.name, 'San Juan, Luis Munoz Marin International Airport');
  assert.equal(val(s, 'temp_c'), 27.8);
  assert.equal(val(s, 'wind_ms'), 2.1);                                      // 7.56 km/h / 3.6
  assert.equal(val(s, 'wind_dir_deg'), 130);
  assert.equal(val(s, 'pressure_hpa'), 1016.8);                              // seaLevelPressure 101680 Pa
  assert.equal(val(s, 'humidity_pct'), 79);                                  // 79.37
  assert.equal(val(s, 'visibility_km'), 16.09);                              // 16090 m
  assert.equal(val(s, 'conditions'), 'Partly Cloudy');
  assert.equal(val(s, 'gust_ms'), undefined);                                // windGust.value is null
  assert.equal(val(s, 'precip_mm'), undefined);
  assert.equal(at(s, 'temp_c'), Date.parse('2026-10-10T03:56:00Z'));
  assert.equal(b.obs!.length, 3);
  near(quantity({ unitCode: 'wmoUnit:km_h-1', value: 36 }, 'm/s')!, 10, 1e-12);
  assert.equal(quantity({ unitCode: 'wmoUnit:Pa', value: 101325 }, 'hPa'), 1013.25);
  assert.equal(quantity({ unitCode: 'wmoUnit:furlong', value: 1 }, 'km'), null);
  assert.equal(mapNwsObs([{ properties: {} }, null], ctx)[0].objects!.length, 0);
});

test('nhc: Atlantic storms only', () => {
  const relay = unwrapRelay(json('nhc_current.json'), NOW);
  const b = valid(mapNhc(relay.data, { ...ctx, fetchedAt: relay.fetchedAt }), 'nhc');
  assert.deepEqual(b.objects!.map((o) => o.key), ['al092026']);              // ep182026 and ep202026 are East Pacific
  assert.deepEqual(b.replaceTypes, ['tropical_cyclone']);
  const s = b.objects![0];
  assert.equal(s.name, 'Hurricane Isaias');
  assert.deepEqual([s.lat, s.lon], [30.8, -86.5]);
  assert.deepEqual(['classification', 'intensity_kt', 'pressure_hpa', 'movement_dir_deg', 'movement_kt'].map((k) => val(s, k)), ['Hurricane', 80, 982, 5, 20]);
  assert.equal(val(s, 'last_update'), Date.parse('2026-10-10T03:00:00Z'));
  assert.equal(val(s, 'advisory_url'), 'https://www.nhc.noaa.gov/text/MIATCPAT4.shtml');
  const km = haversineKm(30.8, -86.5, 18.22, -66.45);
  assert.equal(val(s, 'distance_to_pr_km'), Math.round(km));
  assert.ok(km > 2300 && km < 2600, `distance ${km}`);                       // Florida panhandle to Puerto Rico
  assert.equal(s.severity, 0);
  assert.deepEqual([[1501, 150], [1400, 80], [1400, 40], [900, 80], [900, 40], [900, 25], [400, 80], [400, 50], [400, 25]].map(([d, k]) => cycloneSeverity(d, k)), [0, 2, 1, 3, 2, 1, 4, 3, 2]);
  near(haversineKm(0, 0, 0, 1), 111.195, 0.01);
});

test('ndbc: buoys in the Puerto Rico box', async () => {
  const records = parseNdbcLatestObs(text('ndbc_latest_obs.txt'));
  const relay = await import('../pipeline/relay.mjs');
  assert.deepEqual(relay.parseNdbcLatestObs(text('ndbc_latest_obs.txt')), records);   // the relay and the browser parse alike
  assert.deepEqual(records.map((r) => r.station), ['41053', '41056', '41121', '42085', 'CHAV3', 'CHSV3', 'CLBP4', 'ESPP4', 'JOXP4', 'LAMV3', 'LTBV3', 'MGIP4', 'MGZP4', 'MISP4', 'SJNP4']);
  const b = valid(mapNdbc(records, { ...ctx, fetchedAt: NOW }), 'ndbc');
  assert.equal(b.objects!.length, 15);
  const sj = obj(b, 'buoy:41053');                                           // 18.474 -66.099 03:30Z WDIR 110 WSPD 7.0 GST 10.0 PRES 1016.0 ATMP 29.3
  assert.deepEqual([sj.lat, sj.lon], [18.474, -66.099]);
  assert.deepEqual(['wind_dir_deg', 'wind_ms', 'gust_ms', 'pressure_hpa', 'air_temp_c'].map((k) => val(sj, k)), [110, 7, 10, 1016, 29.3]);
  assert.equal(val(sj, 'wave_height_m'), undefined);                         // MM
  assert.equal(at(sj, 'wind_ms'), Date.parse('2026-10-10T03:30:00Z'));
  const wave = obj(b, 'buoy:41121');                                         // WVHT 1.0 DPD 6 WTMP 29.7, wind MM
  assert.deepEqual(['wave_height_m', 'dominant_period_s', 'water_temp_c', 'wind_ms'].map((k) => val(wave, k)), [1, 6, 29.7, undefined]);
  assert.equal(Object.keys(obj(b, 'buoy:MISP4').props!).join(), 'pressure_hpa');
  assert.equal(count(b.obs!, (o) => o.metric === 'wave_height_m'), 1);
});

test('luma: customers without service by region', () => {
  const b = valid(mapLuma(json('luma_regions.json'), { ...ctx, fetchedAt: NOW }), 'luma');
  assert.deepEqual(b.objects!.map((o) => o.key), ['arecibo', 'bayamon', 'carolina', 'caguas', 'mayaguez', 'ponce', 'san-juan']);
  const m = obj(b, 'power_region:mayaguez');                                 // 216605 clients, 2410 out, 1.11 %
  assert.deepEqual(['customers', 'customers_out', 'pct_out', 'customers_planned', 'customers_load_shed'].map((k) => val(m, k)), [216605, 2410, 1.11, 0, 0]);
  assert.equal(m.severity, 1);
  assert.equal(obj(b, 'power_region:san-juan').severity, 0);                 // 0.04 %
  assert.equal(b.observedAt, Date.parse('2026-10-10T04:30:00Z'));            // '10/10/2026 12:30 AM' AST
  assert.equal(b.obs!.length, 14);
  assert.equal(b.obs!.filter((o) => o.metric === 'customers_out').reduce((a, o) => a + o.value, 0), 3167);   // totals.totalClientsWithoutService
  assert.deepEqual([0, 0.49, 0.5, 1.99, 2, 9.9, 10, 29, 30, 100].map(outageSeverity), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(lumaTime('10/10/2026 12:30 PM'), Date.parse('2026-10-10T16:30:00Z'));
  assert.equal(slug('San Juan'), 'san-juan');
  assert.equal(slug('Mayagüez'), 'mayaguez');
});

test('adsb: aircraft through the relay trim', async () => {
  const relay = await import('../pipeline/relay.mjs');
  const fetchedAt = NOW - 7 * 60_000;                                        // read seven minutes after the relay ran
  const b = valid(mapAdsb(relay.trimAdsb(json('adsb_lol.json')), { ...ctx, fetchedAt }), 'adsb');
  assert.deepEqual(b.objects!.map((o) => o.key), ['e4935a', 'e49b51', 'ac2ba0', 'a825a6', 'aa9f76']);
  assert.deepEqual(b.replaceTypes, ['aircraft']);
  assert.equal(b.observedAt, fetchedAt);                                     // position age is the relay's, not ours
  const a = obj(b, 'aircraft:e4935a');                                       // PPBLO, E35L, PP-BLO, alt_geom 38375 ft, gs 458.4, baro_rate 128 ft/min
  assert.equal(a.name, 'PPBLO');
  assert.deepEqual([a.lat, a.lon], [18.573552, -67.278476]);
  assert.deepEqual(['callsign', 'aircraft_type', 'registration', 'altitude_m', 'ground_speed_kt', 'track_deg', 'vertical_rate_ms', 'squawk', 'emergency'].map((k) => val(a, k)),
    ['PPBLO', 'E35L', 'PP-BLO', 11697, 458.4, 309.25, 0.65, '3613', 'none']);                            // 38375 * 0.3048 = 11696.7; 128 * 0.00508 = 0.65
  assert.equal(val(obj(b, 'aircraft:ac2ba0'), 'vertical_rate_ms'), -6.5);    // -1280 ft/min
  assert.equal(val(obj(b, 'aircraft:ac2ba0'), 'altitude_m'), 1288);          // 4225 ft
  // adsb.fi (fallback) uses `aircraft` and seconds
  const fi = relay.trimAdsb(json('adsb_fi.json'));
  assert.equal(fi.now, 1791606752000);
  assert.equal(fi.ac.length, 8);
  assert.deepEqual(validateBatch(mapAdsb(fi, { ...ctx, fetchedAt })[0], ontology), []);
  assert.ok(Object.keys(fi.ac[0]).every((k) => ['hex', 'flight', 'r', 't', 'lat', 'lon', 'alt_baro', 'alt_geom', 'gs', 'track', 'baro_rate', 'squawk', 'emergency', 'category', 'seen'].includes(k)));
  assert.equal(mapAdsb({ ac: [{ hex: 'abc123', lat: 18.4, lon: -66, alt_baro: 'ground' }] }, ctx)[0].objects![0].status, 'ground');
});

test('relay: tsunami bulletin and file shape', async () => {
  const relay = await import('../pipeline/relay.mjs');
  const t = relay.parseTsunamiAtom(text('tsunami_atom.xml'));
  assert.equal(t.title, 'Tsunami Information Statement Number 1');
  assert.equal(t.entries.length, 1);
  assert.deepEqual([t.entries[0].title, t.entries[0].updated, t.entries[0].lat, t.entries[0].lon], ['in Panama', '2026-10-09T20:37:44Z', 7.8, -81.4]);
  assert.equal(t.entries[0].link, 'https://www.tsunami.gov/events/PAAQ/2026/10/09/tmnq2s/1/WEAK53/WEAK53.txt');
  assert.match(t.entries[0].summary, /Preliminary Magnitude: 6\.9\(Mwp\)/);
  assert.deepEqual(relay.SOURCES.map((s: any) => s.file), ['nhc.json', 'ndbc.json', 'luma.json', 'adsb.json', 'tsunami.json']);
  assert.deepEqual(unwrapRelay({ fetchedAt: 5, source: 'u', data: [1] }, NOW), { fetchedAt: 5, source: 'u', data: [1] });
  assert.equal(unwrapRelay({ regions: [] }, NOW).fetchedAt, NOW);
});

test('fixtures: every feed URL maps to a recorded file', () => {
  const cases: [string, string | null][] = [
    [NWS_ALERTS_URL, 'nws_alerts_all_recent.json'], [quakesUrl(NOW - 30 * 86400e3), 'usgs_quakes_30d.json'], [NWIS_URL, 'usgs_nwis_iv.json'], [NWPS_URL, 'nwps_gauges.json'],
    [coopsLatestUrl('9755371'), 'coops_latest_9755371.json'], [coopsHistoryUrl('9755371'), 'coops_wl_9755371.json'], [coopsPredictionsUrl('9755371', NOW, 96), 'coops_pred_9755371.json'],
    [coopsLatestUrl('9759110'), null],                                       // only San Juan was recorded
    [omForecastUrl(), 'open_meteo_grid.json'], [omMarineUrl(), 'open_meteo_marine.json'], [omAirUrl(), 'open_meteo_air.json'],
    [nwsObsUrl('TJSJ'), 'nws_obs_TJSJ.json'], [nwsObsUrl('TJBQ'), null],
    [relayUrl('nhc.json'), 'nhc_current.json'], [relayUrl('ndbc.json'), 'ndbc_latest_obs.txt'], [relayUrl('luma.json'), 'luma_regions.json'], [relayUrl('adsb.json'), 'adsb_lol.json'],
    ['https://example.org/', null],
  ];
  for (const [url, file] of cases) assert.equal(fixtureFor(url), file, url);
  for (const [, file] of cases) if (file) assert.ok(text(file).length > 0);
});
