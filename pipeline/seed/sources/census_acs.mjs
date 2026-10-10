// ACS 5-year detail for municipios without a Census API key: Esri Living Atlas hosts the Census Bureau's ACS tables as public
// feature layers (county level). Values are mapped by exact Census variable code only; a layer whose vintage is not stated is skipped.
import { fetchJson, arcgisAll, num, round, clean } from '../lib.mjs';
const ORG = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services';
// The vacancy layer goes first: its total of housing units is what the release check compares. (Other Living Atlas ACS service names tried and not found: Housing_Tenure_by_Education, Housing_Units_Occupancy_Status_Tenure, Median_Home_Value_by_Year_Built, Housing_Costs_Variables.)
const CANDIDATES = ['ACS_Housing_Units_Vacancy_Status_Boundaries', 'ACS_Median_Income_by_Race_and_Age_Selp_Emp_Boundaries', 'ACS_Housing_Units_by_Year_Built_Boundaries'];

export async function build(ctx) {
  const muni = await ctx.municipios();
  const names = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const vals = new Map(), used = [], problems = [], probe = {};
  // CDC SVI 2022 municipio layer: E_HU = ACS 2018-2022 housing units, used only to confirm which ACS release the layers hold.
  let svi = null, confirmed2022 = null;
  try { const c = await arcgisAll('https://onemap.cdc.gov/OneMapServices/rest/services/SVI/CDC_ATSDR_Social_Vulnerability_Index_2022_Puerto_Rico/FeatureServer/1', { outFields: 'FIPS,STCNTY,E_HU', log: ctx.log }); svi = new Map(c.rows.map((r) => [String(r.STCNTY || r.FIPS), Number(r.E_HU)])); } catch (e) { problems.push(`SVI cross-check not available: ${e.message}`); }
  const put = (g, k, v, t) => { if (v == null || !Number.isFinite(v)) return; if (!vals.has(g)) vals.set(g, {}); if (!(k in vals.get(g))) vals.get(g)[k] = { value: v, observedAt: t }; };
  for (const name of CANDIDATES) {
    try {
      const svc = await fetchJson(`${ORG}/${name}/FeatureServer?f=json`, { tries: 2 });
      if (svc.error) throw new Error(JSON.stringify(svc.error));
      const layer = (svc.layers || []).find((l) => /county/i.test(l.name));
      if (!layer) throw new Error(`no county layer among ${(svc.layers || []).map((l) => l.name).join(', ')}`);
      const { rows, meta } = await arcgisAll(`${ORG}/${name}/FeatureServer/${layer.id}`, { where: "GEOID LIKE '72%'", log: ctx.log });
      const itemId = meta.serviceItemId || svc.serviceItemId;
      let item = {};
      if (itemId) try { item = await fetchJson(`https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`, { tries: 2 }); } catch (e) { problems.push(`${name}: item description not read: ${e.message}`); }
      const txt = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      const parts = { layer: txt(meta.description), service: txt(`${svc.serviceDescription} ${svc.description}`), item: txt(`${item.title} ${item.snippet} ${item.description}`) };
      // Every 5-year period the publisher states anywhere in the layer, service or item text.
      const stated = {}; const periods = new Set();
      for (const [k, s] of Object.entries(parts)) { stated[k] = [...s.matchAll(/(20\d{2})\s*[-–—]\s*(20\d{2})/g)].filter((m) => +m[2] - +m[1] === 4).map((m) => `${m[1]}-${m[2]}`); for (const p of stated[k]) periods.add(p); }
      const sorted = [...periods].sort();
      const desc = parts.layer;
      // Check against CDC SVI 2022, whose E_HU is the ACS 2018-2022 total of housing units: equal totals confirm the 2018-2022 release.
      let agree = null;
      if (svi && rows.some((r) => r.B25002_001E != null)) { let eq = 0, n = 0; for (const r of rows) { const e = svi.get(String(r.GEOID)); if (e == null || r.B25002_001E == null) continue; n++; if (Number(r.B25002_001E) === e) eq++; } if (n >= 70) { agree = eq / n; if (confirmed2022 == null) confirmed2022 = agree > 0.95; } }
      let vm = null, basis = '';
      if (sorted.length === 1 && sorted[0] === '2018-2022' && confirmed2022 === true) { vm = [0, '2018', '2022']; basis = 'stated by the layer and confirmed: total housing units equal CDC SVI 2022 (ACS 2018-2022) for the municipios'; }
      else if (sorted.length === 1 && sorted[0] !== '2018-2022') { vm = [0, ...sorted[0].split('-')]; basis = 'as stated by the layer'; }
      else if (sorted.length === 1 && confirmed2022 == null) { vm = [0, ...sorted[0].split('-')]; basis = 'as stated by the layer (not cross-checked)'; }
      else if (sorted.length > 1 && confirmed2022 === false) { vm = [0, ...sorted[sorted.length - 1].split('-')]; basis = `latest of the periods the publisher states (${sorted.join(', ')}); totals differ from ACS 2018-2022`; }
      else if (sorted.length > 1 && confirmed2022 === true) { vm = [0, '2018', '2022']; basis = 'confirmed: total housing units equal CDC SVI 2022 (ACS 2018-2022)'; }
      const alias = Object.fromEntries((meta.fields || []).map((f) => [f.name, f.alias]));
      probe[name] = { layer: layer.name, rows: rows.length, vintage: vm ? `${vm[1]}-${vm[2]}` : null, stated, agreeWithSvi2022: agree, vintageBasis: basis, description: desc.slice(0, 300), fields: Object.entries(alias).filter(([k]) => /^B\d{5}_\d{3}E$/.test(k)).map(([k, a]) => `${k}: ${a}`).slice(0, 80) };
      if (!vm) { problems.push(`${name}: ACS period not established (stated: ${sorted.join(', ') || 'none'}; agreement with SVI 2022 housing units: ${agree}); values dated at fetch time`); }
      if (rows.length < 70) throw new Error(`only ${rows.length} Puerto Rico rows`);
      const t = vm ? Date.UTC(+vm[2], 11, 31) : Date.now();
      const pre80 = Object.entries(alias).filter(([k, a]) => /^B25034_\d{3}E$/.test(k) && /Built (1970 to 1979|1960 to 1969|1950 to 1959|1940 to 1949|1939 or earlier)/i.test(a || '')).map(([k]) => k);
      for (const r of rows) {
        const g = String(r.GEOID); if (!names.has(g)) continue;
        const v = (c) => { const n = num(r[c]); return n == null || n < 0 ? null : n; };
        if (v('B19049_001E') > 0) put(g, 'median_income_usd', v('B19049_001E'), t);
        if (v('B25077_001E') > 0) put(g, 'median_home_value_usd', v('B25077_001E'), t);
        const vac = v('B25002_003E') ?? v('B25004_001E'); // both are "vacant housing units"
        if (v('B25002_001E') > 0 && vac != null) { put(g, 'vacant_units', vac, t); put(g, 'vacancy_pct', round((100 * vac) / v('B25002_001E'), 1), t); }
        if (v('B25003_001E') > 0 && v('B25003_003E') != null) put(g, 'renter_pct', round((100 * v('B25003_003E')) / v('B25003_001E'), 1), t);
        if (pre80.length === 5 && v('B25034_001E') > 0 && pre80.every((c) => v(c) != null)) put(g, 'built_pre1980_pct', round((100 * pre80.reduce((s, c) => s + v(c), 0)) / v('B25034_001E'), 1), t);
      }
      used.push(`${name} (${layer.name}, ${vm ? `ACS ${vm[1]}-${vm[2]}, ${basis}` : 'ACS period not established, dated at fetch time'})`);
    } catch (e) { problems.push(`${name}: ${String(e.message).slice(0, 200)}`); }
  }
  ctx.probe('acs_services', probe);
  if (!vals.size) throw new Error(`no ACS layer usable: ${problems.join(' | ')}`);
  const objects = [...vals].map(([g, p]) => ({ type: 'municipio', key: g, name: names.get(g), props: clean(p) }));
  const keys = [...new Set(objects.flatMap((o) => Object.keys(o.props)))];
  return { file: '04-acs', problems, batch: { source: 'census_acs5', fetchedAt: Date.now(), objects,
    note: `ACS 5-year estimates for municipios, read without an API key from the public Esri Living Atlas feature layers that republish Census Bureau ACS tables (county layers, GEOID LIKE '72%'): ${used.join('; ')}. Mapped by Census variable code: median_income_usd = B19049_001E, median_home_value_usd = B25077_001E, vacant_units = B25002_003E or B25004_001E (vacant housing units), vacancy_pct = vacant_units / B25002_001E, renter_pct = B25003_003E / B25003_001E, built_pre1980_pct = B25034 categories built 1979 or earlier / B25034_001E. Properties present: ${keys.join(', ')}. Each value's observedAt is the end of the ACS period given above for its layer.` } };
}
