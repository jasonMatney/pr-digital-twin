// Stage 1: Census TIGERweb boundaries for Puerto Rico (municipios, barrios, tracts) -> data/geo/*.geojson
// Source: https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer
//   layer 82 Counties, 22 County Subdivisions, 8 Census Tracts; where STATE='72'; outSR 4326.
// Server-side generalisation maxAllowableOffset = 0.0001 deg (about 11 m: 0.2 mm on paper at 1:50,000),
// coordinates rounded to 5 decimals (about 1 m). If a file is still above 3 MB, rings are simplified further
// (Douglas-Peucker, per feature) and the tolerance used is recorded in the file's `garita` member.
import { arcgisPaged, arcgisCount, simplifyGeom, writeOut, log, fetchRetry } from './lib.mjs';

const BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';
const OFFSET = 0.0001, MAX_BYTES = 3_000_000;
const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

const LAYERS = [
  { id: 82, file: 'municipios.geojson', label: 'municipios', expect: 78,
    props: (p) => ({ GEOID: p.GEOID, NAME: p.BASENAME ?? p.NAME, NAMELSAD: p.NAME }) },
  { id: 22, file: 'barrios.geojson', label: 'barrios',
    props: (p) => ({ GEOID: p.GEOID, NAME: p.BASENAME ?? p.NAME, NAMELSAD: p.NAME, COUNTY: `${p.STATE}${p.COUNTY}` }) },
  { id: 8, file: 'tracts.geojson', label: 'tracts',
    props: (p) => ({ GEOID: p.GEOID, NAME: p.NAME, BASENAME: p.BASENAME, COUNTY: `${p.STATE}${p.COUNTY}` }) },
];

// POP100 / HU100 are not on the tigerWMS_Current layers; they are on the Census 2020 service (same GEOIDs).
const BASE2020 = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer';
const NAMES2020 = { municipios: 'Counties', barrios: 'County Subdivisions', tracts: 'Census Tracts' };
let layers2020 = null;
async function census2020(label) {
  try {
    if (!layers2020) layers2020 = (await (await fetchRetry(`${BASE2020}?f=json`)).json()).layers || [];
    const lyr = layers2020.find((l) => l.name === NAMES2020[label]);
    if (!lyr) throw new Error('layer not found: ' + NAMES2020[label]);
    const out = new Map();
    for (let offset = 0; ; ) {
      const q = new URLSearchParams({ where: "STATE='72'", outFields: 'GEOID,POP100,HU100', returnGeometry: 'false', f: 'json', resultOffset: String(offset), resultRecordCount: '500', orderByFields: 'OBJECTID' });
      const j = await (await fetchRetry(`${BASE2020}/${lyr.id}/query?${q}`)).json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      const got = j.features || [];
      for (const f of got) out.set(f.attributes.GEOID, f.attributes);
      if (!got.length) break; offset += got.length; if (got.length < 500 && !j.exceededTransferLimit) break;
    }
    log(label, 'Census 2020 POP100/HU100 rows', out.size, 'layer', lyr.id);
    return { map: out, layer: lyr.id };
  } catch (e) { log(label, 'Census 2020 counts unavailable:', String(e.message || e).slice(0, 200)); return null; }
}

const summary = {};
for (const L of LAYERS) {
  const url = `${BASE}/${L.id}`;
  const where = "STATE='72'";
  const expected = await arcgisCount(url, where).catch(() => null);
  const raw = await arcgisPaged(url, { where, outFields: '*', outSR: '4326', maxAllowableOffset: String(OFFSET), geometryPrecision: '6', returnGeometry: 'true' }, { page: 100, label: L.label });
  const c20 = await census2020(L.label); let c20hits = 0;
  const seen = new Set();
  const src = raw.filter((f) => { const g = f.properties?.GEOID; if (!g || seen.has(g)) return false; seen.add(g); return true; });
  if (!summary.fields) summary.fields = {};
  summary.fields[L.label] = Object.keys(src[0]?.properties || {});
  const build = (tol) => src.map((f) => {
    const p = f.properties;
    const props = L.props(p);
    props.AREALAND = num(p.AREALAND); props.AREAWATER = num(p.AREAWATER);
    props.CENTLAT = num(p.CENTLAT); props.CENTLON = num(p.CENTLON);
    props.INTPTLAT = num(p.INTPTLAT); props.INTPTLON = num(p.INTPTLON);
    if (p.POP100 !== undefined) props.POP100 = num(p.POP100);
    if (p.HU100 !== undefined) props.HU100 = num(p.HU100);
    const c = c20?.map.get(p.GEOID);
    if (c && props.POP100 === undefined) { props.POP100 = num(c.POP100); props.HU100 = num(c.HU100); }
    return { type: 'Feature', properties: props, geometry: simplifyGeom(f.geometry, tol, 5) };
  }).filter((f) => f.geometry).sort((a, b) => (a.properties.GEOID < b.properties.GEOID ? -1 : 1));
  let tol = 0, feats, text;
  for (;;) {
    feats = build(tol);
    text = JSON.stringify({ type: 'FeatureCollection', garita: { source: `${url} (Census TIGERweb, tigerWMS_Current)`, where, fetched: new Date().toISOString(), maxAllowableOffset_deg: OFFSET, extra_simplify_deg: tol, coord_decimals: 5, count: feats.length, pop100_hu100: c20 ? `2020 Census counts joined by GEOID from ${BASE2020}/${c20.layer}` : 'not available' }, features: feats });
    if (Buffer.byteLength(text) <= MAX_BYTES) break;
    tol = tol === 0 ? 0.00012 : tol * 1.4;
    log(L.label, 'too big', Buffer.byteLength(text), '-> extra simplify', tol.toFixed(6));
  }
  writeOut(`data/geo/${L.file}`, text);
  summary[L.label] = { with_pop100: feats.filter((f) => typeof f.properties.POP100 === 'number').length, pop100_total: feats.reduce((t, f) => t + (f.properties.POP100 || 0), 0), hu100_total: feats.reduce((t, f) => t + (f.properties.HU100 || 0), 0), count: feats.length, server_count: expected, bytes: Buffer.byteLength(text), extra_simplify_deg: tol };
  log(L.label, JSON.stringify(summary[L.label]));
  if (L.expect && feats.length !== L.expect) throw new Error(`${L.label}: expected ${L.expect}, got ${feats.length}`);
  if (expected !== null && expected !== feats.length) throw new Error(`${L.label}: server count ${expected} != ${feats.length}`);
}
const names = JSON.parse((await import('node:fs')).readFileSync((await import('node:path')).join(process.env.OUT_DIR || 'out', 'data/geo/municipios.geojson'), 'utf8')).features.map((f) => f.properties.NAME);
log('sample names:', names.filter((n) => /[^\x00-\x7f]/.test(n)).join(', '));
writeOut('data/geo/boundaries.meta.json', JSON.stringify(summary, null, 1));
