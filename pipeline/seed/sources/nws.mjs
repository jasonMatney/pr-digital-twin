// NWS forecast zones, the zone of each municipio (points API at the municipio's internal point), and observation stations.
import { fetchJson, pool, num, normMuni, clean } from '../lib.mjs';
const A = 'https://api.weather.gov';
const H = { accept: 'application/geo+json' };

export async function build(ctx) {
  const now = Date.now();
  const zones = (await fetchJson(`${A}/zones?area=PR&type=forecast&include_geometry=false`, H)).features || [];
  const objects = [], links = [], problems = [];
  const zoneIds = new Set();
  for (const f of zones) {
    const p = f.properties; zoneIds.add(p.id);
    objects.push({ type: 'forecast_zone', key: p.id, name: p.name, validFrom: Date.parse(p.effectiveDate) || null,
      props: clean({ zone_type: p.type, forecast_office: (p.cwa || [])[0] || String(p.forecastOffice || '').split('/').pop() }) });
  }
  // County zones (PRC###) carry only the municipio name; the code is the county FIPS. Recorded as an identity of the municipio.
  const muni = await ctx.municipios();
  const byName = new Map(muni.rows.map((r) => [normMuni(r.BASENAME), r]));
  const counties = (await fetchJson(`${A}/zones?area=PR&type=county&include_geometry=false`, H)).features || [];
  ctx.log(`NWS county zone properties: ${Object.keys(counties[0]?.properties || {}).join(',')}`);
  const cz = new Map();
  for (const f of counties) {
    const p = f.properties, m = byName.get(normMuni(p.name));
    if (!m) { problems.push(`county zone ${p.id} "${p.name}" not matched to a municipio`); continue; }
    if (`72${p.id.slice(3)}` !== String(m.GEOID)) problems.push(`county zone ${p.id} "${p.name}" matched by name to ${m.GEOID}`);
    cz.set(String(m.GEOID), p.id);
  }
  // The zones payloads do not relate county zones to forecast zones; the points API does, for a point.
  let linked = 0;
  if (!process.env.SEED_FIXTURES) await pool(muni.rows, 4, async (r) => {
    const g = String(r.GEOID);
    const o = { type: 'municipio', key: g, name: String(r.BASENAME), identities: cz.has(g) ? [['nws:zone', cz.get(g)]] : [], props: {} };
    try {
      const p = (await fetchJson(`${A}/points/${Number(r.INTPTLAT).toFixed(4)},${Number(r.INTPTLON).toFixed(4)}`, { ...H, tries: 3 })).properties;
      const z = String(p.forecastZone || '').split('/').pop();
      if (/^PRZ\d{3}$/.test(z)) { o.props.nws_zone = z; links.push({ src: `municipio:${g}`, type: 'part_of', dst: `forecast_zone:${z}`, confidence: 0.8, note: 'NWS public forecast zone at the municipio internal point (api.weather.gov/points); a municipio can span more than one zone' }); linked++; if (!zoneIds.has(z)) problems.push(`zone ${z} (from points) is not in the PR forecast zone list`); }
      else problems.push(`${g} ${r.BASENAME}: points API returned forecastZone "${p.forecastZone}"`);
    } catch (e) { problems.push(`${g} ${r.BASENAME}: points lookup failed: ${e.message}`); }
    objects.push(o);
  });
  const batches = [{ file: '23-nws-zones', problems, batch: { source: 'nws_alerts', fetchedAt: now, objects, links,
    note: `api.weather.gov zones for area PR: ${zones.length} public forecast zones (PRZ*), ${counties.length} county zones (PRC*, one per municipio, stored as identity nws:zone). The zones payloads carry no county-to-forecast-zone relation, so municipio part_of forecast_zone (${linked} links) comes from the points API evaluated at each municipio's TIGER internal point, confidence 0.8.` } }];

  const st = (await fetchJson(`${A}/stations?state=PR&limit=500`, H)).features || [];
  const so = st.map((f) => { const p = f.properties, c = f.geometry?.coordinates || []; return { type: 'weather_station', key: String(p.stationIdentifier), name: p.name, ...(num(c[0]) != null && num(c[1]) != null ? { lon: num(c[0]), lat: num(c[1]) } : {}), text: `NWS ${p.stationIdentifier} ${p.provider || ''}`.trim() }; });
  batches.push({ file: '24-weather-stations', batch: { source: 'nws_obs', fetchedAt: now, objects: so, note: `api.weather.gov/stations?state=PR (${st.length} observation stations, all providers; some are NDBC buoys that also appear as buoy objects).` } });
  return batches;
}
