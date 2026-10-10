// Municipios, barrios and census tracts as objects, from TIGERweb attributes (polygons are published elsewhere).
import { arcgisAll, num, round, clean } from '../lib.mjs';
const BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';
const LAYER = { tract: 8, barrio: 22, municipio: 82 };

export async function fetchMunicipios(ctx) {
  const { rows, fields } = await arcgisAll(`${BASE}/${LAYER.municipio}`, { where: "STATE='72'", log: ctx.log });
  return { fields, rows };
}
const obj = (type, r, extra = {}) => {
  const lat = num(r.INTPTLAT ?? r.CENTLAT), lon = num(r.INTPTLON ?? r.CENTLON);
  return {
    type, key: String(r.GEOID), name: type === 'municipio' ? String(r.BASENAME) : type === 'tract' ? `Census Tract ${r.BASENAME}` : String(r.BASENAME),
    ...(lat != null && lon != null ? { lon, lat } : {}),
    props: clean({ land_km2: num(r.AREALAND) != null ? round(num(r.AREALAND) / 1e6, 3) : null, population: num(r.POP100), housing_units: num(r.HU100), ...extra }),
  };
};
export async function build(ctx) {
  const muni = await ctx.municipios();
  const objects = [], links = [];
  for (const r of muni.rows) objects.push({ ...obj('municipio', r), text: String(r.NAME) });
  const name = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const sub = await arcgisAll(`${BASE}/${LAYER.barrio}`, { where: "STATE='72'", log: ctx.log });
  for (const r of sub.rows) {
    const g = `72${r.COUNTY}`;
    if (/not defined/i.test(String(r.NAME)) || Number(r.AREALAND) === 0) continue; // water-only county subdivisions
    objects.push({ ...obj('barrio', r, { municipio_name: name.get(g) }), text: `${r.NAME}, ${name.get(g) ?? ''}` });
    if (name.has(g)) links.push({ src: `barrio:${r.GEOID}`, type: 'part_of', dst: `municipio:${g}` });
  }
  const tr = await arcgisAll(`${BASE}/${LAYER.tract}`, { where: "STATE='72'", log: ctx.log });
  for (const r of tr.rows) {
    const g = `72${r.COUNTY}`;
    const o = obj('tract', r, { municipio_name: name.get(g) });
    o.name = `${o.name}, ${name.get(g) ?? ''}`.replace(/, $/, '');
    objects.push(o);
    if (name.has(g)) links.push({ src: `tract:${r.GEOID}`, type: 'part_of', dst: `municipio:${g}` });
  }
  return { file: '01-places', batch: { source: 'census_tiger', fetchedAt: Date.now(), objects, links,
    note: `TIGERweb tigerWMS_Current layers ${LAYER.municipio} (Counties), ${LAYER.barrio} (County Subdivisions = barrios), ${LAYER.tract} (Census Tracts), STATE='72'. lon/lat = internal point (INTPTLON/INTPTLAT). land_km2 = AREALAND / 1e6. population/housing_units only if the layer carries POP100/HU100 (fields seen: ${tr.fields.join(',')}).` } };
}
