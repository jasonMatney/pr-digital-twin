// ACS 5-year detail for municipios without a Census API key: Esri Living Atlas hosts the Census Bureau's ACS tables as public
// feature layers (county level). Values are mapped by exact Census variable code only; a layer whose vintage is not stated is skipped.
import { fetchJson, arcgisAll, num, round, clean } from '../lib.mjs';
const ORG = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services';
const CANDIDATES = ['ACS_Median_Income_by_Race_and_Age_Selp_Emp_Boundaries', 'ACS_Housing_Units_Vacancy_Status_Boundaries', 'ACS_Housing_Units_by_Year_Built_Boundaries', 'ACS_Housing_Tenure_by_Education_Boundaries', 'ACS_Housing_Units_Occupancy_Status_Tenure_Boundaries', 'ACS_Median_Home_Value_by_Year_Built_Boundaries', 'ACS_Housing_Costs_Variables_Boundaries'];

export async function build(ctx) {
  const muni = await ctx.municipios();
  const names = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const vals = new Map(), used = [], problems = [], probe = {};
  const put = (g, k, v, t) => { if (v == null || !Number.isFinite(v)) return; if (!vals.has(g)) vals.set(g, {}); if (!(k in vals.get(g))) vals.get(g)[k] = { value: v, observedAt: t }; };
  for (const name of CANDIDATES) {
    try {
      const svc = await fetchJson(`${ORG}/${name}/FeatureServer?f=json`, { tries: 2 });
      if (svc.error) throw new Error(JSON.stringify(svc.error));
      const layer = (svc.layers || []).find((l) => /county/i.test(l.name));
      if (!layer) throw new Error(`no county layer among ${(svc.layers || []).map((l) => l.name).join(', ')}`);
      const { rows, meta } = await arcgisAll(`${ORG}/${name}/FeatureServer/${layer.id}`, { where: "GEOID LIKE '72%'", log: ctx.log });
      let desc = `${meta.description || ''} ${svc.serviceDescription || ''} ${svc.description || ''} ${meta.copyrightText || ''}`;
      const itemId = meta.serviceItemId || svc.serviceItemId;
      if (itemId) try { const it = await fetchJson(`https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`, { tries: 2 }); desc += ` ${it.title || ''} ${it.snippet || ''} ${it.description || ''}`; } catch (e) { problems.push(`${name}: item description not read: ${e.message}`); }
      desc = desc.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      // The ACS period must be stated by the publisher ("Current Vintage: 2019-2023") and be a 5-year span.
      let vm = desc.match(/vintage[^0-9]{0,40}(20\d{2})\s*[-–—]\s*(20\d{2})/i) || desc.match(/(20\d{2})\s*[-–—]\s*(20\d{2})[^.]{0,40}(?:ACS|American Community Survey|5-year)/i) || desc.match(/(?:ACS|American Community Survey|5-year)[^0-9]{0,60}(20\d{2})\s*[-–—]\s*(20\d{2})/i);
      if (vm && +vm[2] - +vm[1] !== 4) vm = null;
      const alias = Object.fromEntries((meta.fields || []).map((f) => [f.name, f.alias]));
      probe[name] = { layer: layer.name, rows: rows.length, vintage: vm ? `${vm[1]}-${vm[2]}` : null, vintageText: vm ? vm[0] : null, description: desc.slice(0, 700), fields: Object.entries(alias).filter(([k]) => /^B\d{5}_\d{3}E$/.test(k)).map(([k, a]) => `${k}: ${a}`).slice(0, 80) };
      if (!vm) throw new Error('vintage not stated in the layer description');
      if (rows.length < 70) throw new Error(`only ${rows.length} Puerto Rico rows`);
      const t = Date.UTC(+vm[2], 11, 31);
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
      used.push(`${name} (${layer.name}, ACS ${vm[1]}-${vm[2]})`);
    } catch (e) { problems.push(`${name}: ${String(e.message).slice(0, 200)}`); }
  }
  ctx.probe('acs_services', probe);
  if (!vals.size) throw new Error(`no ACS layer usable: ${problems.join(' | ')}`);
  const objects = [...vals].map(([g, p]) => ({ type: 'municipio', key: g, name: names.get(g), props: clean(p) }));
  const keys = [...new Set(objects.flatMap((o) => Object.keys(o.props)))];
  return { file: '04-acs', problems, batch: { source: 'census_acs5', fetchedAt: Date.now(), objects,
    note: `ACS 5-year estimates for municipios, read without an API key from the public Esri Living Atlas feature layers that republish Census Bureau ACS tables (county layers, GEOID LIKE '72%'): ${used.join('; ')}. Mapped by Census variable code: median_income_usd = B19049_001E, median_home_value_usd = B25077_001E, vacant_units = B25002_003E or B25004_001E (vacant housing units), vacancy_pct = vacant_units / B25002_001E, renter_pct = B25003_003E / B25003_001E, built_pre1980_pct = B25034 categories built 1979 or earlier / B25034_001E. Properties present: ${keys.join(', ')}. Each value's observedAt is the end of the layer's stated ACS period.` } };
}
