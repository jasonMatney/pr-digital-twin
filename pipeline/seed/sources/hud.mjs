// HUD public housing developments, multifamily assisted properties and LIHTC projects in Puerto Rico.
import { arcgisFirst, num, round, clean, pick, normMuni } from '../lib.mjs';
const B = 'https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services';
const WH = ["STD_ST='PR'", "PROJ_ST='PR'", "STATE_CODE='PR'", "STATE2KX='72'", "STATE='PR'"];
const NA = (v) => { const n = num(v); return n == null || n <= -1 ? null : n; }; // HUD picture-of-subsidized-households codes: -1 n/a, -4 suppressed, -5 not reported
const str = (v) => (v == null ? null : String(v).trim() || null);

function place(r, names) {
  const cands = [pick(r, ['COUNTY_LEVEL', 'CURCNTY', 'STCNTY', 'CNTY_FIPS', 'COUNTY_FIPS']), String(pick(r, ['TRACT_LEVEL', 'FIPS2020', 'FIPS2010', 'TRACT2KX']) ?? '').slice(0, 5)];
  const st = pick(r, ['STATE2KX', 'STATE_FIPS']), co = pick(r, ['CNTY2KX', 'COUNTY2KX']);
  if (st != null && co != null) cands.push(String(st).padStart(2, '0') + String(co).padStart(3, '0'));
  let geoid = null;
  for (const c of cands) { const s = String(c ?? '').trim(); if (/^72\d{3}$/.test(s) && names.has(s)) { geoid = s; break; } }
  let lon = num(r.__x) ?? num(pick(r, ['LON', 'LONGITUDE', 'X'])), lat = num(r.__y) ?? num(pick(r, ['LAT', 'LATITUDE', 'Y']));
  if (lon == null || lat == null || lon < -68.2 || lon > -64.9 || lat < 17.5 || lat > 18.8) { lon = null; lat = null; }
  return { geoid, lon, lat };
}
const addr = (r) => [str(pick(r, ['STD_ADDR', 'ADDRESS_LINE1_TEXT', 'PROJ_ADD', 'ADDRESS'])), str(pick(r, ['STD_CITY', 'PLACED_BASE_CITY_NAME_TEXT', 'PROJ_CTY', 'CITY'])), str(pick(r, ['STD_ZIP5', 'PROJ_ZIP', 'ZIP']))].filter(Boolean).join(', ') || null;

export async function build(ctx) {
  const muni = await ctx.municipios();
  const names = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const out = [];
  const run = async (file, fn) => { try { out.push(await fn()); } catch (e) { out.push({ file, error: e }); } };

  await run('10-public-housing', async () => {
    const { rows, fields } = await arcgisFirst(`${B}/Public_Housing_Developments/FeatureServer/0`, WH, { geometry: true, log: ctx.log });
    ctx.probe('hud_public_housing_fields', fields); ctx.probe('hud_public_housing_sample', rows[0]);
    const objects = [], links = [], problems = [], perMuni = new Map(); let noMuni = 0; const seen = new Set();
    const builtField = fields.find((f) => /DOFA_ACTUAL|DOFA/i.test(f)) || fields.find((f) => /YEAR_BUILT|YR_BUILT|BUILT/i.test(f));
    for (const r of rows) {
      const key = str(pick(r, ['DEVELOPMENT_CODE', 'DEV_CODE', 'PROJECT_NUMBER']));
      if (!key) { problems.push(`row without development code: ${JSON.stringify(r).slice(0, 120)}`); continue; }
      if (seen.has(key)) { problems.push(`duplicate development code ${key}`); continue; } seen.add(key);
      const { geoid, lon, lat } = place(r, names);
      const units = NA(pick(r, ['TOTAL_DWELLING_UNITS', 'TOTAL_UNITS', 'ACC_UNITS'])), occ = NA(pick(r, ['TOTAL_OCCUPIED']));
      let built = null;
      if (builtField && r[builtField] != null) { const v = r[builtField]; const y = typeof v === 'number' && v > 3000 ? new Date(v).getUTCFullYear() : Number(String(v).match(/(19|20)\d{2}/)?.[0]); if (y >= 1930 && y <= 2026) built = y; }
      objects.push({ type: 'public_housing', key: key.replace(/\s+/g, ''), name: str(pick(r, ['PROJECT_NAME', 'DEVELOPMENT_NAME', 'FORMAL_PARTICIPANT_NAME'])) || key, ...(lon != null ? { lon, lat } : {}),
        identities: [['hud:development', key]],
        props: clean({ units, occupied_units: occ, occupancy_pct: NA(pick(r, ['PCT_OCCUPIED'])) ?? (units && occ != null ? round((100 * occ) / units, 1) : null), residents: NA(pick(r, ['PEOPLE_TOTAL', 'NUMBER_REPORTED'])),
          housing_authority: str(pick(r, ['FORMAL_PARTICIPANT_NAME', 'PARTICIPANT_NAME', 'PHA_NAME'])), built_year: built, avg_household_income_usd: NA(pick(r, ['HH_INCOME'])),
          pct_elderly: NA(pick(r, ['PCT_AGE62PLUS', 'PCT_ELDERLY'])), pct_disabled: NA(pick(r, ['PCT_DISABLED_ALL', 'PCT_DISABLED'])), address: addr(r), municipio_name: geoid ? names.get(geoid) : null }),
        text: `HUD ${key} ${str(pick(r, ['PARTICIPANT_CODE'])) || ''}` });
      if (geoid) { links.push({ src: `public_housing:${key.replace(/\s+/g, '')}`, type: 'located_in', dst: `municipio:${geoid}` }); if (units) perMuni.set(geoid, (perMuni.get(geoid) || 0) + units); } else noMuni++;
    }
    for (const [g, u] of perMuni) objects.push({ type: 'municipio', key: g, name: names.get(g), props: { public_housing_units: u } });
    if (noMuni) problems.push(`${noMuni} developments without a usable county FIPS: no municipio link`);
    return { file: '10-public-housing', problems, batch: { source: 'hud_public_housing', fetchedAt: Date.now(), objects, links,
      note: `HUD Public_Housing_Developments, STD_ST='PR' (${rows.length} records). Key = development code. units = TOTAL_DWELLING_UNITS, occupied_units = TOTAL_OCCUPIED, occupancy_pct = PCT_OCCUPIED, residents = PEOPLE_TOTAL, avg_household_income_usd = HH_INCOME, pct_elderly = PCT_AGE62PLUS, pct_disabled = PCT_DISABLED_ALL (HUD negative codes = not available, left out). built_year = year of ${builtField || '(no date field found: not set)'}${/DOFA/i.test(builtField || '') ? ' (date of full availability)' : ''}. Municipio from the record's county FIPS. municipio.public_housing_units = sum of units of linked developments.` } };
  });

  await run('11-multifamily-assisted', async () => {
    const { rows, fields } = await arcgisFirst(`${B}/MULTIFAMILY_PROPERTIES_ASSISTED/FeatureServer/0`, WH, { geometry: true, log: ctx.log });
    ctx.probe('hud_multifamily_fields', fields); ctx.probe('hud_multifamily_sample', rows[0]);
    const objects = [], links = [], problems = [], seen = new Set(); let noMuni = 0;
    for (const r of rows) {
      const id = str(pick(r, ['PROPERTY_ID', 'PROPERTY_ID_TEXT', 'FHA_NUM1']));
      if (!id) { problems.push('row without PROPERTY_ID'); continue; }
      const key = `mf-${id}`; if (seen.has(key)) continue; seen.add(key);
      const { geoid, lon, lat } = place(r, names);
      objects.push({ type: 'assisted_housing', key, name: str(pick(r, ['PROPERTY_NAME_TEXT', 'PROPERTY_NAME'])) || key, ...(lon != null ? { lon, lat } : {}), identities: [['hud:property', id]],
        props: clean({ program: 'Section 8 / multifamily assisted', units: NA(pick(r, ['TOTAL_UNIT_COUNT', 'TOTAL_UNITS'])), assisted_units: NA(pick(r, ['TOTAL_ASSISTED_UNIT_COUNT', 'ASSISTED_UNITS'])),
          owner: str(pick(r, ['OWNER_ORGANIZATION_NAME', 'OWNER_NAME', 'MGMT_AGENT_ORG_NAME'])), address: addr(r), municipio_name: geoid ? names.get(geoid) : null }) });
      if (geoid) links.push({ src: `assisted_housing:${key}`, type: 'located_in', dst: `municipio:${geoid}` }); else noMuni++;
    }
    if (noMuni) problems.push(`${noMuni} properties without a usable county FIPS: no municipio link`);
    return { file: '11-multifamily-assisted', problems, batch: { source: 'hud_multifamily', fetchedAt: Date.now(), objects, links,
      note: `HUD MULTIFAMILY_PROPERTIES_ASSISTED, Puerto Rico (${rows.length} records). Key = mf-<PROPERTY_ID>. owner = owner organisation when the layer has it, else the management agent.` } };
  });

  await run('12-lihtc', async () => {
    const { rows, fields } = await arcgisFirst(`${B}/LIHTC/FeatureServer/0`, ["PROJ_ST='PR'", ...WH], { geometry: true, log: ctx.log });
    ctx.probe('hud_lihtc_fields', fields); ctx.probe('hud_lihtc_sample', rows[0]);
    const objects = [], links = [], problems = [], seen = new Set(); let noMuni = 0, byCityN = 0;
    const byCity = new Map([...names].map(([g, n]) => [normMuni(n), g]));
    for (const r of rows) {
      const id = str(pick(r, ['HUD_ID', 'HUDID']));
      if (!id) { problems.push('row without HUD_ID'); continue; }
      const key = `lihtc-${id.replace(/\s+/g, '')}`; if (seen.has(key)) continue; seen.add(key);
      let { geoid, lon, lat } = place(r, names); let conf;
      if (!geoid) { const c = byCity.get(normMuni(pick(r, ['PROJ_CTY', 'STD_CITY']))); if (c) { geoid = c; conf = 0.7; byCityN++; } }
      const yr = num(pick(r, ['YR_PIS', 'YEAR_PIS']));
      objects.push({ type: 'assisted_housing', key, name: str(pick(r, ['PROJECT', 'PROJECT_NAME'])) || key, ...(lon != null ? { lon, lat } : {}), identities: [['hud:lihtc', id]],
        props: clean({ program: 'LIHTC', units: NA(pick(r, ['N_UNITS'])), assisted_units: NA(pick(r, ['LI_UNITS'])), placed_in_service: yr != null && yr >= 1986 && yr <= 2026 ? yr : null, address: addr(r), municipio_name: geoid ? names.get(geoid) : null }) });
      if (geoid) links.push({ src: `assisted_housing:${key}`, type: 'located_in', dst: `municipio:${geoid}`, ...(conf ? { confidence: conf, note: 'record not geocoded by HUD; municipio taken from the project city name' } : {}) }); else noMuni++;
    }
    if (byCityN) problems.push(`${byCityN} projects had no county FIPS (not geocoded by HUD): municipio taken from the project city where it equals a municipio name, confidence 0.7`);
    if (noMuni) problems.push(`${noMuni} projects without a usable county/tract FIPS: no municipio link`);
    return { file: '12-lihtc', problems, batch: { source: 'hud_lihtc', fetchedAt: Date.now(), objects, links,
      note: `HUD LIHTC database, PROJ_ST='PR' (${rows.length} records). Key = lihtc-<HUD_ID>. units = N_UNITS, assisted_units = LI_UNITS (low-income units), placed_in_service = YR_PIS (HUD codes 8888/9999 = unknown, left out).` } };
  });
  return out;
}
