// NWPS gauges in the Puerto Rico box: NWS location ids and flood stages, attached to the USGS-keyed object when one exists.
import { fetchJson, pool, num, round, clean, FT } from '../lib.mjs';
import { isReservoirName } from './usgs.mjs';
const LIST = 'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-67.99&bbox.ymin=17.6&bbox.xmax=-65.1&bbox.ymax=18.7&srid=EPSG_4326';

export async function build(ctx) {
  const list = (await fetchJson(LIST)).gauges || [];
  const problems = []; let sample = null, withUsgs = 0, created = 0;
  const objects = (await pool(list, 5, async (g) => {
    let d;
    try { d = await fetchJson(`https://api.water.noaa.gov/nwps/v1/gauges/${g.lid}`); } catch (e) { problems.push(`${g.lid}: ${e.message}`); d = g; }
    if (!sample && d !== g) { sample = d; ctx.probe('nwps_gauge_sample', d); }
    const usgs = d.usgsId ? String(d.usgsId).trim() : '';
    const units = d.flood?.stageUnits || '';
    const k = /^ft/i.test(units) ? FT : /^m$/i.test(units) ? 1 : null;
    const stage = (c) => { const v = num(d.flood?.categories?.[c]?.stage); return v != null && v > -900 && k != null ? round(v * k, 3) : null; };
    const name = d.name || g.name;
    const lat = num(d.latitude ?? g.latitude), lon = num(d.longitude ?? g.longitude);
    let type = usgs ? ctx.usgsType.get(usgs) : null;
    if (usgs) withUsgs++;
    if (!type) { type = isReservoirName(name) ? 'reservoir' : 'stream_gauge'; if (usgs) created++; }
    const props = type === 'stream_gauge' ? clean({ nws_lid: g.lid, action_stage_m: stage('action'), minor_stage_m: stage('minor'), moderate_stage_m: stage('moderate'), major_stage_m: stage('major') }) : {};
    return { type, key: usgs || `nws-${g.lid}`, name, ...(lat != null && lon != null ? { lon, lat } : {}), identities: [['nws:lid', g.lid]], props, text: `NWS ${g.lid}` };
  })).filter(Boolean);
  return { file: '22-nwps-gauges', problems, batch: { source: 'nwps', fetchedAt: Date.now(), objects,
    note: `NWPS gauges in the PR bounding box (${list.length}); ${withUsgs} carry a usgsId and are keyed by it (${created} of those are not in the USGS active real-time list and are created here); the rest are keyed nws-<lid>. Flood stages from flood.categories.*.stage converted with flood.stageUnits (ft x 0.3048); missing or negative-sentinel stages are left out. Reservoir objects get the NWS identity only (the reservoir type has no stage thresholds).` } };
}
