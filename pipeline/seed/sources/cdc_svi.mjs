// CDC/ATSDR Social Vulnerability Index 2022, Puerto Rico: tract values and municipio values.
import { fetchJson, arcgisAll, num, round, clean, pick } from '../lib.mjs';
const SVC = 'https://onemap.cdc.gov/OneMapServices/rest/services/SVI/CDC_ATSDR_Social_Vulnerability_Index_2022_Puerto_Rico/FeatureServer';
const V = (r, f) => { const n = num(pick(r, [f])); return n == null || n <= -999 ? null : n; };
const OBS = Date.UTC(2022, 11, 31);
const MAP = { poverty_pct: 'EP_POV150', age65_pct: 'EP_AGE65', no_vehicle_pct: 'EP_NOVEH', disability_pct: 'EP_DISABL', mobile_home_pct: 'EP_MOBILE', crowding_pct: 'EP_CROWD' };

export async function build(ctx) {
  const svc = await fetchJson(`${SVC}?f=json`);
  ctx.probe('svi_layers', (svc.layers || []).map((l) => `${l.id} ${l.name}`));
  const layers = svc.layers || [];
  const tractL = layers.find((l) => /tract/i.test(l.name)) || layers[layers.length - 1];
  const countyL = layers.find((l) => /count|municip/i.test(l.name) && l !== tractL);
  const muni = await ctx.municipios();
  const names = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const t = await arcgisAll(`${SVC}/${tractL.id}`, { log: ctx.log });
  ctx.probe('svi_tract_fields', t.fields); ctx.probe('svi_tract_sample', t.rows[0]);
  const objects = [], agg = new Map();
  for (const r of t.rows) {
    const fips = String(pick(r, ['FIPS', 'GEOID']) ?? '').trim();
    if (!/^72\d{9}$/.test(fips)) continue;
    const g = fips.slice(0, 5);
    const pop = V(r, 'E_TOTPOP'), hu = V(r, 'E_HU'), hh = V(r, 'E_HH');
    const p = { municipio_name: names.get(g), population: pop, housing_units: hu, households: hh, svi_overall: V(r, 'RPL_THEMES'), svi_socioeconomic: V(r, 'RPL_THEME1'), svi_household: V(r, 'RPL_THEME2'), svi_minority: V(r, 'RPL_THEME3'), svi_housing_transport: V(r, 'RPL_THEME4'), no_health_insurance_pct: V(r, 'EP_UNINSUR') };
    for (const [k, f] of Object.entries(MAP)) p[k] = V(r, f);
    objects.push({ type: 'tract', key: fips, props: clean(p) });
    let a = agg.get(g); if (!a) agg.set(g, a = { pop: 0, hu: 0, hh: 0, w: {} });
    a.pop += pop || 0; a.hu += hu || 0; a.hh += hh || 0;
    const acc = (k, v, w) => { if (v == null || !w) return; const x = (a.w[k] ||= [0, 0]); x[0] += v * w; x[1] += w; };
    acc('svi_overall', p.svi_overall, pop); acc('poverty150_pct', p.poverty_pct, pop); acc('age65_pct', p.age65_pct, pop); acc('disability_pct', p.disability_pct, pop); acc('no_health_insurance_pct', p.no_health_insurance_pct, pop);
    acc('no_vehicle_pct', p.no_vehicle_pct, hh); acc('crowding_pct', p.crowding_pct, hh); acc('mobile_home_pct', p.mobile_home_pct, hu);
  }
  let official = new Map(), countyNote = 'The service has no county-level layer';
  if (countyL) try {
    const c = await arcgisAll(`${SVC}/${countyL.id}`, { log: ctx.log });
    ctx.probe('svi_county_fields', c.fields);
    for (const r of c.rows) { const f = String(pick(r, ['FIPS', 'STCNTY', 'GEOID']) ?? '').trim(); if (/^72\d{3}$/.test(f)) official.set(f, r); }
    countyNote = `County layer "${countyL.name}" gives official values for ${official.size} municipios`;
  } catch (e) { countyNote = `County layer "${countyL.name}" could not be read (${e.message})`; }
  for (const [g, a] of agg) {
    if (!names.has(g)) continue;
    const m = (k) => (a.w[k] && a.w[k][1] ? a.w[k][0] / a.w[k][1] : null);
    const o = official.get(g);
    const props = o ? { population: V(o, 'E_TOTPOP'), housing_units: V(o, 'E_HU'), households: V(o, 'E_HH'), svi_overall: V(o, 'RPL_THEMES'), svi_basis: 'official CDC/ATSDR SVI 2022 county percentile (ranked among Puerto Rico municipios)', poverty150_pct: V(o, 'EP_POV150'), age65_pct: V(o, 'EP_AGE65'), no_vehicle_pct: V(o, 'EP_NOVEH'), disability_pct: V(o, 'EP_DISABL'), mobile_home_pct: V(o, 'EP_MOBILE'), crowding_pct: V(o, 'EP_CROWD'), no_health_insurance_pct: V(o, 'EP_UNINSUR') }
      : { population: a.pop, housing_units: a.hu, households: a.hh, svi_overall: round(m('svi_overall'), 4), svi_basis: 'population-weighted mean of tract RPL_THEMES; not an official county percentile', poverty150_pct: round(m('poverty150_pct'), 1), age65_pct: round(m('age65_pct'), 1), no_vehicle_pct: round(m('no_vehicle_pct'), 1), disability_pct: round(m('disability_pct'), 1), mobile_home_pct: round(m('mobile_home_pct'), 1), crowding_pct: round(m('crowding_pct'), 1), no_health_insurance_pct: round(m('no_health_insurance_pct'), 1) };
    objects.push({ type: 'municipio', key: g, name: names.get(g), props: clean(props) });
  }
  return { file: '02-svi', batch: { source: 'cdc_svi', fetchedAt: Date.now(), observedAt: OBS, objects,
    note: `CDC/ATSDR SVI 2022 (ACS 2018-2022), layer "${tractL.name}", ${t.rows.length} tracts; -999 = no data, left out. Tract poverty_pct = EP_POV150 (below 150% of poverty). ${countyNote}. Where no official county row exists, municipio values are aggregated from tracts: population, housing_units, households = sums of E_TOTPOP, E_HU, E_HH; svi_overall, poverty150_pct, age65_pct, disability_pct, no_health_insurance_pct = E_TOTPOP-weighted means of the tract values; no_vehicle_pct and crowding_pct = E_HH-weighted; mobile_home_pct = E_HU-weighted. svi_basis on each municipio says which applies.` } };
}
