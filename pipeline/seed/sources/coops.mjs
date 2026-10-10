// NOAA CO-OPS reference data for Puerto Rico tide stations: datums, flood thresholds, sea level rise projections.
import { fetchJson, pool, num, round, clean } from '../lib.mjs';
const MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';
const SLR = 'https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json';

export async function build(ctx) {
  const list = await fetchJson(`${MD}/stations.json?type=waterlevels`);
  const pr = (list.stations || []).filter((s) => s.state === 'PR');
  const problems = [], replay = {};
  const objects = await pool(pr, 3, async (s) => {
    const id = String(s.id);
    const props = {};
    let text = `NOAA CO-OPS ${id}`;
    try {
      const d = await fetchJson(`${MD}/stations/${id}/datums.json?units=metric`);
      const get = (n) => num((d.datums || []).find((x) => x.name === n)?.value);
      const msl = get('MSL'), mhhw = get('MHHW');
      if (msl != null && mhhw != null) props.mhhw_m = round(mhhw - msl, 3);
      try {
        const f = await fetchJson(`${MD}/stations/${id}/floodlevels.json?units=metric`);
        // floodlevels.json values are heights on station datum (STND), like datums.json; minor flood relative to MSL = value - MSL(STND).
        const minor = num(f.nos_minor) ?? num(f.nws_minor);
        if (minor != null && msl != null) props.minor_flood_m = round(minor - msl, 3);
      } catch (e) { problems.push(`${id} floodlevels: ${e.message}`); }
    } catch (e) { problems.push(`${id} datums: ${e.message}`); }
    try {
      const p = await fetchJson(`${SLR}?station=${id}&units=metric`, { tries: 2 });
      const rows = p.SlrProjections || [];
      if (rows.length) {
        const k = /cm/i.test(rows[0].units || '') ? 0.01 : /mm/i.test(rows[0].units || '') ? 0.001 : 1;
        const scenarios = {};
        for (const r of rows) (scenarios[r.scenario] ||= []).push([r.projectionYear, round(num(r.projectionRsl) * k, 4)]);
        for (const a of Object.values(scenarios)) a.sort((x, y) => x[0] - y[0]);
        const zero = (scenarios.Intermediate || []).find((x) => x[1] === 0)?.[0] ?? null;
        replay[id] = { name: s.name, lon: num(s.lng), lat: num(s.lat), scenarios,
          baseline: { zero_year: zero, units: 'm', quantity: 'projectionRsl (relative sea level change)', report_year: rows[0].reportYear ?? null, source_units: rows[0].units ?? null, projection_station: rows[0].stationName ?? null, distance: rows[0].distance ?? null } };
        const at = (y) => (scenarios.Intermediate || []).find((x) => x[0] === y)?.[1] ?? null;
        props.slr_2050_int_m = at(2050); props.slr_2100_int_m = at(2100);
      }
    } catch (e) { problems.push(`${id} slr_projections: ${e.message}`); }
    return { type: 'tide_station', key: id, name: s.name, lon: num(s.lng), lat: num(s.lat), status: 'active', props: clean(props), text };
  });
  ctx.writeReplay('slr_projections.json', replay);
  return { file: '20-tide-stations', problems, batch: { source: 'coops_meta', fetchedAt: Date.now(), objects,
    note: `CO-OPS metadata API, water level stations with state "PR" (${pr.length}). mhhw_m = MHHW - MSL from datums.json (metres on station datum). minor_flood_m = floodlevels.json nos_minor (else nws_minor), given on station datum, minus MSL. slr_2050_int_m / slr_2100_int_m = Intermediate scenario projectionRsl at 2050 / 2100 from slr_projections.json (reported in cm, converted to metres; zero at the first projection year, see data/replay/slr_projections.json baseline). ${Object.keys(replay).length} stations have projections.` } };
}
