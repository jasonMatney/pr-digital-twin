// HURDAT2 best tracks of storms whose centre passed near Puerto Rico -> data/replay/storms.json (no ontology objects).
import { fetchText, haversineKm, round } from '../lib.mjs';
const DIR = 'https://www.nhc.noaa.gov/data/hurdat/';
const ALWAYS = new Set(['HUGO 1989', 'GEORGES 1998', 'IRMA 2017', 'MARIA 2017', 'FIONA 2022']);
const NAMES = { MARIA: 'María' };
const v = (s) => { const n = Number(s); return Number.isFinite(n) && n > -99 ? n : null; };

export async function build(ctx) {
  const idx = await fetchText(DIR, { accept: 'text/html' });
  const files = [...idx.matchAll(/href="(hurdat2-1851-(\d{4})-(\d+)\.txt)"/g)].map((m) => { const d = m[3]; const mm = d.slice(0, 2), dd = d.slice(2, 4), yy = d.length === 8 ? d.slice(4) : `20${d.slice(4)}`; return { f: m[1], end: +m[2], date: `${yy}${mm}${dd}` }; });
  files.sort((a, b) => a.end - b.end || a.date.localeCompare(b.date));
  const file = files[files.length - 1]?.f;
  if (!file) throw new Error('no hurdat2 Atlantic file in the index');
  if (process.env.SEED_FIXTURES) { ctx.log(`hurdat2 file would be ${file}`); return []; }
  const txt = await fetchText(DIR + file, { accept: 'text/plain', timeout: 180000 });
  const muni = await ctx.municipios().catch(() => null);
  const pts = muni ? muni.rows.map((r) => [Number(r.INTPTLAT), Number(r.INTPTLON)]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])) : [];
  const basis = pts.length ? `nearest of the ${pts.length} municipio internal points (TIGERweb)` : 'the box 17.88..18.52 N, 67.27..65.22 W';
  const dist = (lat, lon) => { if (pts.length) { let m = Infinity; for (const p of pts) { const d = haversineKm(lat, lon, p[0], p[1]); if (d < m) m = d; } return m; } const cl = Math.min(18.52, Math.max(17.88, lat)), co = Math.min(-65.22, Math.max(-67.27, lon)); return haversineKm(lat, lon, cl, co); };
  const storms = []; let cur = null;
  for (const line of txt.split('\n')) {
    const c = line.split(',').map((s) => s.trim());
    if (/^AL\d{6}$/.test(c[0])) { cur = { id: c[0], name: c[1], year: +c[0].slice(4), points: [] }; storms.push(cur); continue; }
    if (!cur || c.length < 8 || !/^\d{8}$/.test(c[0])) continue;
    const t = Date.UTC(+c[0].slice(0, 4), +c[0].slice(4, 6) - 1, +c[0].slice(6, 8), +c[1].slice(0, 2), +c[1].slice(2, 4));
    const lat = parseFloat(c[4]) * (/S$/.test(c[4]) ? -1 : 1), lon = parseFloat(c[5]) * (/W$/.test(c[5]) ? -1 : 1);
    const rad = (i) => { const a = [c[i], c[i + 1], c[i + 2], c[i + 3]].map(v); return a.every((x) => x == null) ? null : a; };
    cur.points.push({ t, lat, lon, status: c[3], ...(c[2] ? { record: c[2] } : {}), wind_kt: v(c[6]), pressure_mb: v(c[7]), r34: rad(8), r50: rad(12), r64: rad(16) });
  }
  const out = [];
  for (const s of storms) {
    if (s.year < 1980 && !ALWAYS.has(`${s.name} ${s.year}`)) continue;
    let best = Infinity, bestT = null;
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i], b = s.points[i + 1] || a;
      const steps = b === a ? 1 : Math.max(1, Math.round((b.t - a.t) / 600000));
      for (let k = 0; k < steps; k++) { const f = k / steps; const d = dist(a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f); if (d < best) { best = d; bestT = Math.round(a.t + (b.t - a.t) * f); } }
    }
    if (best <= 100 || ALWAYS.has(`${s.name} ${s.year}`)) out.push({ id: s.id, name: NAMES[s.name] && s.year === 2017 ? NAMES[s.name] : s.name[0] + s.name.slice(1).toLowerCase(), year: s.year, max_wind_kt: Math.max(...s.points.map((p) => p.wind_kt ?? 0)), closest_km: round(best, 1), closest_t: bestT, points: s.points });
  }
  out.sort((a, b) => a.points[0].t - b.points[0].t);
  ctx.writeReplay('storms.json', out);
  ctx.writeReplay('storms.meta.json', { source: DIR + file, fetchedAt: Date.now(), storms: out.length, rule: `storms since 1980 whose best track, interpolated linearly at 10-minute steps, came within 100 km of ${basis}; plus Hugo 1989, Georges 1998, Irma 2017, María 2017, Fiona 2022 regardless. closest_km is the distance to that reference, not to the coastline. Radii r34/r50/r64 are [NE, SE, SW, NW] in nautical miles, null where HURDAT2 has -999.` });
  ctx.log(`hurdat2 ${file}: ${storms.length} storms, ${out.length} kept: ${out.map((s) => `${s.name} ${s.year} ${s.closest_km}km`).join('; ')}`);
  return [];
}
