// Land-clipped municipios for drawing: Census polygons (which include territorial water) intersected with land
// built from the OpenStreetMap coastline (natural=coastline ways joined into closed rings; land is on the left
// of a coastline way, so counter-clockwise rings are land and clockwise rings are water enclosed by land).
// Coastline rings are simplified to 0.00003 deg (about 3 m) before clipping. Inland water bodies are not removed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'polygon-clipping';
import { OUT, WORK, log, writeOut, simplifyRing, roundRing, ringArea, simplifyGeom } from './lib.mjs';

const SITE = process.env.SITE_DIR || 'site';
const TOL = 0.00003;
const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
const segs = [];
{
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(WORK, 'osm', 'coast.geojsonl')), crlfDelay: Infinity });
  for await (let l of rl) {
    if (l.charCodeAt(0) === 0x1e) l = l.slice(1); if (l.length < 3) continue;
    const g = JSON.parse(l).geometry; if (!g) continue;
    if (g.type === 'LineString') segs.push(g.coordinates); else if (g.type === 'MultiLineString') segs.push(...g.coordinates);
  }
}
export function joinRings(segs) {
  const byStart = new Map(), ends = new Set();
  segs.forEach((s, i) => { const k = key(s[0]); if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(i); ends.add(key(s[s.length - 1])); });
  const used = new Uint8Array(segs.length), rings = [], open = [];
  const run = (i) => {
    let chain = segs[i].slice(); used[i] = 1; const k0 = key(chain[0]);
    for (;;) {
      const ke = key(chain[chain.length - 1]);
      if (ke === k0 && chain.length >= 4) { rings.push(chain); return; }
      const next = (byStart.get(ke) || []).find((j) => !used[j]);
      if (next === undefined) { open.push(chain); return; }
      used[next] = 1; chain = chain.concat(segs[next].slice(1));
    }
  };
  segs.forEach((s, i) => { if (!used[i] && !ends.has(key(s[0]))) run(i); }); // heads of open chains first
  segs.forEach((s, i) => { if (!used[i]) run(i); });
  return { rings, open };
}
const { rings, open } = joinRings(segs);
log('coastline ways', segs.length, 'closed rings', rings.length, 'open chains', open.length);
const land = [], water = [];
for (const r0 of rings) {
  let r = simplifyRing(r0, TOL); r = r && roundRing(r, 6); if (!r) continue;
  const a = ringArea(r); if (Math.abs(a) < 1e-10) continue;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const p of r) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  (a > 0 ? land : water).push({ ring: r, bbox: [x0, y0, x1, y1], n: r.length });
}
land.sort((a, b) => b.n - a.n);
log('land rings', land.length, 'largest', land[0]?.n, 'vertices; enclosed-water rings', water.length);

const src = [path.join(OUT, 'data/geo/municipios.geojson'), path.join(SITE, 'data/geo/municipios.geojson')].find((p) => fs.existsSync(p));
const fc = JSON.parse(fs.readFileSync(src, 'utf8'));
const hit = (b, c) => b[0] <= c[2] && b[2] >= c[0] && b[1] <= c[3] && b[3] >= c[1];
let clipped = 0, unchanged = 0, failedN = 0; const t0 = Date.now();
const features = fc.features.map((f) => {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const poly of polys) for (const p of poly[0]) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  const bb = [x0, y0, x1, y1];
  const L = land.filter((l) => hit(l.bbox, bb)).map((l) => [l.ring]), W = water.filter((l) => hit(l.bbox, bb)).map((l) => [l.ring]);
  try {
    let res = L.length ? pc.intersection(polys, L) : [];
    if (res.length && W.length) res = pc.difference(res, W);
    if (!res.length) throw new Error('empty intersection');
    const geom = simplifyGeom(res.length === 1 ? { type: 'Polygon', coordinates: res[0] } : { type: 'MultiPolygon', coordinates: res }, 0, 5, 1e-9);
    if (!geom) throw new Error('degenerate result');
    clipped++;
    return { type: 'Feature', properties: { ...f.properties, CLIPPED: true }, geometry: geom };
  } catch (e) {
    failedN++; log('clip failed', f.properties.GEOID, f.properties.NAME, String(e.message || e).slice(0, 100));
    return { type: 'Feature', properties: { ...f.properties, CLIPPED: false }, geometry: f.geometry };
  }
});
let tol = 0, text;
for (;;) {
  const fs2 = tol ? features.map((f) => ({ ...f, geometry: simplifyGeom(f.geometry, tol, 5, 1e-9) || f.geometry })) : features;
  text = JSON.stringify({ type: 'FeatureCollection', garita: { ...fc.garita, land_clip: 'Census polygons intersected with land polygons built from the OpenStreetMap coastline (natural=coastline, Geofabrik Puerto Rico extract); enclosed coastline-water rings subtracted; inland water not removed', coastline_simplify_deg: TOL, extra_simplify_deg: tol, clipped, failed: failedN }, features: fs2 });
  if (Buffer.byteLength(text) <= 3_000_000 || tol > 0.001) break;
  tol = tol ? tol * 1.5 : 0.00005;
}
writeOut('data/geo/municipios_land.geojson', text);
log('municipios_land', features.length, 'clipped', clipped, 'failed', failedN, 'bytes', Buffer.byteLength(text), 'extra tol', tol, ((Date.now() - t0) / 1000).toFixed(1) + 's');
