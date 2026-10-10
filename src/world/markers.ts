// Markers: every point object in the store drawn as an instrument glyph on a transparent 2D canvas laid exactly
// over the scene. The scene goes through tone mapping, haze and bloom; pins drawn on top stay crisp and keep
// their ontology colours. Positions are projected with the scene camera, hidden by terrain (budgeted ray tests),
// clustered per type on a screen grid, and hit-tested in screen space through the layer contract.
import * as S from '../core/state';
import { curveDrop, lonLatToXZ, DEG } from '../core/geo';
import type { LayerFactory } from './layers';
import type { ObjectTypeDef } from '../ontology/types';
import { ACCENT, CELL, DISC_R, ICONS, INK, SEV, buildAtlas, type Atlas } from './markers/glyphs';
import { View, smooth, type OccPt } from './markers/view';
import { createLabels, haloText, NAME_FONT, setSpacing } from './labels';

type Mode = 'pin' | 'quake' | 'aircraft' | 'cyclone';
class Marker implements OccPt {
  id = ''; name = ''; lon = 0; lat = 0;
  x = 0; z = 0; h = 0; alt = NaN; hStamp = -1;
  wx = 0; wy = 0; wz = 0; sx = 0; sy = 0; dist = 0;
  sev = 0; mag = NaN; track = NaN; time = 0; note = '';
  vis = 1; occ = false; occStamp = -1;
  phase = Math.random();
  constructor(public t: TypeInfo) {}
}
interface TypeInfo { id: string; idx: number; def: ObjectTypeDef; rank: number; mode: Mode; cluster: boolean; list: Marker[]; timer: number; loading: boolean; again: boolean }

const GRID = 44;          // cluster cell, CSS px
const OCC = 13;           // declutter cell across types, CSS px
const PROPS: Record<string, string[]> = { earthquake: ['magnitude'], aircraft: ['track_deg', 'altitude_m'], tropical_cyclone: ['classification'] };
const DAY = 86400000;
const DASH = [3, 3], SOLID: number[] = [];

export const createMarkers: LayerFactory = (ctx) => {
  const { world, store } = ctx;
  const terrain = world.terrain;

  // ---- types that have a point worth a pin (places are outlines, power regions have no meaningful point) ----
  const types: TypeInfo[] = [];
  for (const def of store.ontology.objectTypes) {
    if (!(def.kind === 'asset' || def.kind === 'sensor' || def.kind === 'event' || def.kind === 'track')) continue;
    if (def.group === 'records') continue;
    const mode: Mode = def.id === 'earthquake' ? 'quake' : def.id === 'aircraft' ? 'aircraft' : def.id === 'tropical_cyclone' ? 'cyclone' : 'pin';
    const rank = def.kind === 'event' ? 5 : def.kind === 'sensor' ? 4 : def.kind === 'track' ? 3 : def.group === 'housing' ? 2 : 1;
    types.push({ id: def.id, idx: types.length, def, rank, mode, cluster: mode === 'pin', list: [], timer: 0, loading: false, again: false });
  }
  const typeById = new Map(types.map((t) => [t.id, t]));
  const byId = new Map<string, Marker>();

  // ---- canvas ----
  const cv = document.createElement('canvas');
  cv.id = 'markers';
  cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;display:block;';
  world.canvas.insertAdjacentElement('afterend', cv);
  const g = cv.getContext('2d')!;
  let W = 1, H = 1, dpr = 1, sizeDirty = true;
  let atlas: Atlas = buildAtlas(types.map((t) => ({ icon: t.def.icon, color: t.def.color })), 1);
  const ro = new ResizeObserver(() => { sizeDirty = true; });
  ro.observe(world.canvas);
  const onWin = () => { sizeDirty = true; };
  window.addEventListener('resize', onWin);

  // ---- per-frame scratch, allocated on resize / data change only ----
  let cols = 1, rows = 1, nCells = 1;
  let cStamp = new Int32Array(1), cCount = new Int32Array(1), cPrio = new Uint8Array(1), cSev = new Uint8Array(1);
  let cSX = new Float32Array(1), cSY = new Float32Array(1), cLon = new Float64Array(1), cLat = new Float64Array(1);
  let cBest: (Marker | null)[] = [null], touched = new Int32Array(1);
  let oCols = 1, oStamp = new Int32Array(1);
  let cap = 0;
  let iM: (Marker | null)[] = [], iX = new Float32Array(0), iY = new Float32Array(0), iR = new Float32Array(0), iA = new Float32Array(0);
  let iN = new Int32Array(0), iPrio = new Uint8Array(0), iSev = new Uint8Array(0), iHide = new Uint8Array(0), iLon = new Float64Array(0), iLat = new Float64Array(0), order = new Int32Array(0);
  const bucket = new Int32Array(65);
  let nItems = 0, stampCur = 0;

  function ensureCap(n: number) {
    if (n <= cap) return;
    cap = Math.max(1024, Math.ceil(n * 1.3));
    iM = new Array(cap).fill(null);
    iX = new Float32Array(cap); iY = new Float32Array(cap); iR = new Float32Array(cap); iA = new Float32Array(cap);
    iN = new Int32Array(cap); iPrio = new Uint8Array(cap); iSev = new Uint8Array(cap); iHide = new Uint8Array(cap);
    iLon = new Float64Array(cap); iLat = new Float64Array(cap); order = new Int32Array(cap);
  }
  function resize() {
    sizeDirty = false;
    const r = world.canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    const d = Math.min(2, window.devicePixelRatio || 1);
    cv.style.left = r.left + 'px'; cv.style.top = r.top + 'px'; cv.style.width = W + 'px'; cv.style.height = H + 'px';
    cv.width = Math.round(W * d); cv.height = Math.round(H * d);
    if (d !== dpr || atlas.dpr !== d) { dpr = d; atlas = buildAtlas(types.map((t) => ({ icon: t.def.icon, color: t.def.color })), dpr); }
    cols = Math.ceil(W / GRID) + 4; rows = Math.ceil(H / GRID) + 4; nCells = cols * rows;
    const n = nCells * types.length;
    cStamp = new Int32Array(n); cCount = new Int32Array(n); cPrio = new Uint8Array(n); cSev = new Uint8Array(n);
    cSX = new Float32Array(n); cSY = new Float32Array(n); cLon = new Float64Array(n); cLat = new Float64Array(n);
    cBest = new Array(n).fill(null); touched = new Int32Array(n);
    oCols = Math.ceil(W / OCC) + 6; oStamp = new Int32Array(oCols * (Math.ceil(H / OCC) + 6));
    dataVersion++;
  }

  // ---- data: one cached array per type, refetched when the store reports the type changed ----
  let dataVersion = 1;
  const total = () => { let n = 0; for (const t of types) n += t.list.length; return n; };
  async function load(t: TypeInfo) {
    if (t.loading) { t.again = true; return; }
    t.loading = true;
    try {
      const rows = await store.listObjects(t.id, { limit: 5000, props: PROPS[t.id] ?? [] });
      // Event time and position time are not in the summary; ask the store.
      let times: Map<string, number> | null = null;
      if (t.mode === 'quake') {
        const r = await store.query<{ id: string; t: number }>('SELECT id, valid_from AS t FROM object WHERE type = ? AND expired = 0', [t.id]).catch(() => [] as { id: string; t: number }[]);
        times = new Map(r.map((x) => [x.id, x.t]));
      } else if (t.mode === 'aircraft') {
        const r = await store.query<{ id: string; t: number }>("SELECT object_id AS id, MAX(observed_at) AS t FROM prop WHERE object_id LIKE 'aircraft:%' AND key IN ('track_deg', 'altitude_m') GROUP BY object_id").catch(() => [] as { id: string; t: number }[]);
        times = new Map(r.map((x) => [x.id, x.t]));
      }
      const list: Marker[] = [];
      for (const o of rows) {
        if (o.lon == null || o.lat == null || !Number.isFinite(o.lon) || !Number.isFinite(o.lat)) continue;
        let m = byId.get(o.id);
        if (!m || m.t !== t) m = new Marker(t);
        if (m.lon !== o.lon || m.lat !== o.lat || m.id !== o.id) {
          const [x, z] = lonLatToXZ(o.lon, o.lat);
          m.x = x; m.z = z; m.lon = o.lon; m.lat = o.lat; m.hStamp = -1; m.occStamp = -1;
        }
        m.id = o.id; m.name = o.name || o.key;
        m.sev = Math.max(0, Math.min(4, Math.round(o.severity ?? 0)));
        m.time = times?.get(o.id) ?? o.updatedAt;
        const p = o.props;
        if (t.mode === 'quake') m.mag = typeof p?.magnitude === 'number' ? p.magnitude : NaN;
        if (t.mode === 'aircraft') {
          m.track = typeof p?.track_deg === 'number' ? p.track_deg : NaN;
          const alt = typeof p?.altitude_m === 'number' ? p.altitude_m : NaN;
          if (alt !== m.alt && !(Number.isNaN(alt) && Number.isNaN(m.alt))) { m.alt = alt; m.hStamp = -1; }
        }
        list.push(m);
      }
      for (const m of t.list) byId.delete(m.id);
      for (const m of list) byId.set(m.id, m);
      t.list = list;
      ensureCap(total() + 64);
      dataVersion++;
    } catch (e) { console.error('[garita] markers: could not list', t.id, e); }
    t.loading = false;
    if (t.again) { t.again = false; load(t); }
  }
  for (const t of types) load(t);
  const offChange = store.onChange((e) => {
    for (const id of e.types) {
      const t = typeById.get(id);
      if (!t) continue;
      clearTimeout(t.timer);
      t.timer = setTimeout(() => load(t), 400) as unknown as number;
    }
  });

  // ---- view, labels ----
  const view = new View(world);
  const labels = createLabels(world, store, () => { dataVersion++; });
  let terrainStamp = 1, terrainSig = -1, lastTerrainCheck = -10;
  let lastDraw = -10, pending = true, hasAnim = false, seenData = 0, seenSel: string | null = null, seenHov: string | null = null;
  let seenHl: string[] | null = null, seenOn: Record<string, boolean> | null = null, seenLang = '', seenSea = NaN, seenMinute = 0;
  let selM: Marker | null = null, hovM: Marker | null = null;
  const hlSet = new Set<string>();
  let range = 1e5, gs = 1, far = 0, grid = GRID, ms = 0, nDrawn = 0, nClustered = 0, nHidden = 0, hBudget = 0;
  const quakePath = new Path2D(ICONS.quake[0] as string), planePath = new Path2D(ICONS.plane[0] as string);
  const spiral = new Path2D();
  for (let arm = 0; arm < 2; arm++) for (let i = 0; i <= 24; i++) {
    const th = (i / 24) * 4.6, r = 3.5 + 13.5 * (i / 24), a = th + arm * Math.PI;
    if (i === 0) spiral.moveTo(r * Math.cos(a), r * Math.sin(a)); else spiral.lineTo(r * Math.cos(a), r * Math.sin(a));
  }

  function place(m: Marker) {
    const ground = Math.max(terrain.heightAt(m.x, m.z) ?? world.seaLevel, world.seaLevel);
    m.h = Number.isFinite(m.alt) ? Math.max(m.alt, ground) : ground + 0.5;
    m.wx = m.x; m.wz = m.z; m.wy = m.h - curveDrop(m.x, m.z);
    m.hStamp = terrainStamp;
  }
  function addItem(m: Marker, x: number, y: number, n: number, prio: number, sev: number, lon: number, lat: number) {
    if (nItems >= cap) return;
    const i = nItems++;
    iM[i] = m; iX[i] = x; iY[i] = y; iN[i] = n; iPrio[i] = prio; iSev[i] = sev; iLon[i] = lon; iLat[i] = lat; iHide[i] = 0; iA[i] = 1; iR[i] = DISC_R;
  }

  function build(on: Record<string, boolean>, dt: number) {
    nItems = 0; stampCur++;
    let nTouched = 0;
    // Anchor the cluster grid to the ground so clusters do not reshuffle while panning.
    let gx = 0, gy = 0;
    if (view.project(0, 0, 0) && Math.abs(view.sx) < 1e6 && Math.abs(view.sy) < 1e6) { gx = ((view.sx % grid) + grid) % grid; gy = ((view.sy % grid) + grid) % grid; }
    const anyHl = hlSet.size > 0;
    for (let ti = 0; ti < types.length; ti++) {
      const t = types[ti], list = t.list, typeOn = on[t.id] === true;
      if (!typeOn && !anyHl && selM?.t !== t) continue;
      const base = ti * nCells;
      for (let k = 0; k < list.length; k++) {
        const m = list[k];
        const hl = anyHl && hlSet.has(m.id);
        if (!typeOn && !hl && m !== selM) continue;
        if (m.hStamp !== terrainStamp) { if (hBudget > 0 || m.hStamp < 0) { hBudget--; place(m); } else pending = true; }
        if (!view.project(m.wx, m.wy, m.wz)) continue;
        const sx = view.sx, sy = view.sy;
        if (sx < -30 || sx > W + 30 || sy < -30 || sy > H + 40) continue;
        m.sx = sx; m.sy = sy; m.dist = view.depth;
        const prio = m === selM ? 63 : m === hovM ? 62 : hl ? 61 : m.sev * 8 + t.rank;
        if (t.cluster && prio < 61) {
          const c = Math.floor((sx - gx) / grid) + 2, r = Math.floor((sy - gy) / grid) + 2;
          const idx = base + r * cols + c;
          if (cStamp[idx] !== stampCur) { cStamp[idx] = stampCur; cCount[idx] = 0; cSX[idx] = 0; cSY[idx] = 0; cLon[idx] = 0; cLat[idx] = 0; cPrio[idx] = 0; cSev[idx] = 0; cBest[idx] = m; touched[nTouched++] = idx; }
          cCount[idx]++; cSX[idx] += sx; cSY[idx] += sy; cLon[idx] += m.lon; cLat[idx] += m.lat;
          if (prio > cPrio[idx]) { cPrio[idx] = prio; cBest[idx] = m; }
          if (m.sev > cSev[idx]) cSev[idx] = m.sev;
        } else addItem(m, sx, sy, 1, prio, m.sev, m.lon, m.lat);
      }
    }
    for (let k = 0; k < nTouched; k++) {
      const idx = touched[k], n = cCount[idx], m = cBest[idx]!;
      if (n === 1) addItem(m, m.sx, m.sy, 1, cPrio[idx], m.sev, m.lon, m.lat);
      else addItem(m, cSX[idx] / n, cSY[idx] / n, n, cPrio[idx], cSev[idx], cLon[idx] / n, cLat[idx] / n);
    }
    // Order by priority (counting sort), then walk from the top: terrain occlusion, then yield to what is already placed.
    bucket.fill(0);
    for (let i = 0; i < nItems; i++) bucket[iPrio[i] + 1]++;
    for (let p = 1; p < 65; p++) bucket[p] += bucket[p - 1];
    for (let i = 0; i < nItems; i++) order[bucket[iPrio[i]]++] = i;
    nHidden = 0; nClustered = 0;
    // From orbit the island is a few hundred pixels wide: wider cells, so what survives can be read.
    const occ = 19 + 9 * far;
    for (let k = nItems - 1; k >= 0; k--) {
      const i = order[k], m = iM[i]!, mode = m.t.mode;
      const vis = mode === 'cyclone' ? 1 : view.occlude(m, dt);
      iA[i] = vis;
      if (vis <= 0.01) { iHide[i] = 1; nHidden += iN[i]; continue; }
      if (mode !== 'quake' && iPrio[i] < 61) {
        const o = (Math.floor(iY[i] / occ) + 3) * oCols + Math.floor(iX[i] / occ) + 3;
        if (oStamp[o] === stampCur) { iHide[i] = 1; nHidden += iN[i]; continue; }
        oStamp[o] = stampCur;
      }
      if (iN[i] > 1) nClustered += iN[i];
    }
  }

  function ring(x: number, y: number, r: number, color: string, width: number) {
    g.beginPath(); g.arc(x, y, r, 0, 6.2832);
    g.lineWidth = width + 2; g.strokeStyle = 'rgba(3,11,16,0.6)'; g.stroke();
    g.lineWidth = width; g.strokeStyle = color; g.stroke();
  }
  function pulse(x: number, y: number, r: number, color: string, now: number, phase: number, alpha: number) {
    const p = (now * 0.42 + phase) % 1;
    g.globalAlpha = alpha * (1 - p) * 0.85;
    g.beginPath(); g.arc(x, y, r + p * 13, 0, 6.2832); g.lineWidth = 1.8; g.strokeStyle = color; g.stroke();
    g.globalAlpha = alpha;
    hasAnim = true;
  }

  function paint(now: number, wall: number) {
    nDrawn = 0;
    const A = atlas.canvas, cs = CELL * dpr, half = CELL * gs / 2, size = CELL * gs, DR = DISC_R * gs;
    for (let k = 0; k < nItems; k++) {
      const i = order[k];
      if (iHide[i]) continue;
      const m = iM[i]!, t = m.t, n = iN[i], sev = iSev[i], prio = iPrio[i];
      const x = Math.round(iX[i] * dpr) / dpr;
      let y = Math.round(iY[i] * dpr) / dpr, r = DR, a = iA[i];
      nDrawn++;
      if (t.mode === 'pin') {
        if (n === 1) {
          // Close in, lift the glyph off its ground point on a hairline stem so it does not hide the thing it marks.
          const lift = Math.round(16 * (1 - smooth(2500, 7000, m.dist)));
          if (lift > 1) {
            g.globalAlpha = a * 0.9;
            g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - lift);
            g.lineWidth = 2.6; g.strokeStyle = 'rgba(3,11,16,0.55)'; g.stroke();
            g.lineWidth = 1; g.strokeStyle = 'rgba(240,246,244,0.95)'; g.stroke();
            g.beginPath(); g.arc(x, y, 1.8, 0, 6.2832); g.fillStyle = 'rgba(240,246,244,0.95)'; g.fill();
            y -= lift + DR;
          }
          g.globalAlpha = a;
          if (sev >= 3) pulse(x, y, DR + 3, SEV[sev], now, m.phase, a);
          g.drawImage(A, t.idx * cs, 0, cs, cs, x - half, y - half, size, size);
          if (sev >= 1) ring(x, y, DR + 2.4, SEV[sev], 2);
        } else {
          g.globalAlpha = a * 0.6;
          g.drawImage(A, t.idx * cs, 0, cs, cs, x - half + 4 * gs, y - half - 3 * gs, size, size);
          g.globalAlpha = a;
          if (sev >= 3) pulse(x, y, DR + 3, SEV[sev], now, m.phase, a);
          g.drawImage(A, t.idx * cs, 0, cs, cs, x - half, y - half, size, size);
          if (sev >= 1) ring(x, y, DR + 2.4, SEV[sev], 2);
          const pill = atlas.pill(n), pw = (pill as any)._w as number, ph = (pill as any)._h as number;
          g.drawImage(pill, Math.round((x + 3 * gs) * dpr) / dpr, Math.round((y - DR - 8) * dpr) / dpr, pw, ph);
          r = DR + 3;
        }
      } else if (t.mode === 'quake') {
        const mag = Number.isFinite(m.mag) ? m.mag : 1.5;
        const age = wall - m.time;
        const fresh = age <= DAY ? 1 : 0.85 - 0.6 * Math.min(1, (age - DAY) / (29 * DAY));
        r = Math.min(15, Math.max(2.6, 1 + mag * 1.75)) * (0.5 + 0.5 * gs);
        a *= fresh;
        g.globalAlpha = a;
        const col = sev >= 1 ? SEV[sev] : t.def.color;
        if (sev >= 3 && age <= DAY) pulse(x, y, r + 2, SEV[sev], now, m.phase, a);
        g.beginPath(); g.arc(x, y, r, 0, 6.2832);
        if (mag < 3 || age > DAY) {
          // Small or past events: a ringed dot, no icon. Only the last 24 hours are drawn solid.
          g.lineWidth = 2.6; g.strokeStyle = 'rgba(3,11,16,0.5)'; g.stroke();
          g.lineWidth = mag < 3 ? 1.1 : 1.6; g.strokeStyle = col; g.stroke();
          g.beginPath(); g.arc(x, y, Math.max(1.2, r * 0.3), 0, 6.2832); g.fillStyle = t.def.color; g.fill();
        } else {
          g.fillStyle = t.def.color; g.fill();
          g.lineWidth = 1.2; g.strokeStyle = 'rgba(4,14,19,0.92)'; g.stroke();
          if (r >= 6.5) {
            const s = (r * 1.5) / 16;
            g.setTransform(dpr * s, 0, 0, dpr * s, dpr * (x - 8 * s), dpr * (y - 8 * s));
            g.lineWidth = 1.9; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = INK; g.stroke(quakePath);
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
          }
          if (sev >= 1) ring(x, y, r + 2.4, SEV[sev], 1.8);
        }
      } else if (t.mode === 'aircraft') {
        // The feed is relayed every ~10 minutes: these are where aircraft were, not where they are.
        const age = wall - m.time, stale = age > 4 * 60000;
        a *= stale ? 0.55 : 0.92;
        g.globalAlpha = a;
        let ang = -Math.PI / 2;
        if (Number.isFinite(m.track)) {
          const L = Math.max(800, m.dist * 0.02), tr = m.track * DEG;
          if (view.project(m.wx + Math.sin(tr) * L, m.wy, m.wz - Math.cos(tr) * L)) {
            ang = Math.atan2(view.sy - m.sy, view.sx - m.sx);
            const cx = Math.cos(ang), sy = Math.sin(ang);
            g.setLineDash(DASH);
            g.beginPath(); g.moveTo(x + cx * 12, y + sy * 12); g.lineTo(x + cx * 34, y + sy * 34);
            g.lineWidth = 2.4; g.strokeStyle = 'rgba(3,11,16,0.5)'; g.stroke();
            g.lineWidth = 1.1; g.strokeStyle = t.def.color; g.stroke();
            g.setLineDash(SOLID);
          }
        }
        const s = 20 / 16, c = Math.cos(ang + Math.PI / 2) * s * dpr, sn = Math.sin(ang + Math.PI / 2) * s * dpr;
        g.setTransform(c, sn, -sn, c, dpr * x - (c * 8 - sn * 8), dpr * y - (sn * 8 + c * 8));
        g.lineJoin = 'round'; g.lineWidth = 2.2; g.strokeStyle = 'rgba(4,14,19,0.9)'; g.stroke(planePath);
        g.fillStyle = t.def.color; g.fill(planePath);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (stale && m.note) {
          g.font = "500 9.5px 'IBM Plex Mono', ui-monospace, Menlo, monospace"; g.textAlign = 'left'; g.textBaseline = 'middle';
          haloText(g, m.note, x + 12, y + 11, '#cfd8e3', 'rgba(3,11,16,0.8)', 2.6);
        }
        r = 11;
      } else {
        // Tropical cyclone: a turning spiral, counter-clockwise as in the northern hemisphere.
        r = 19;
        g.globalAlpha = a;
        g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fillStyle = 'rgba(6,18,24,0.5)'; g.fill();
        const rot = -now * 0.7, c = Math.cos(rot) * dpr, sn = Math.sin(rot) * dpr;
        g.setTransform(c, sn, -sn, c, dpr * x, dpr * y);
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.lineWidth = 5; g.strokeStyle = 'rgba(3,11,16,0.7)'; g.stroke(spiral);
        g.lineWidth = 2.6; g.strokeStyle = t.def.color; g.stroke(spiral);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.beginPath(); g.arc(x, y, 3, 0, 6.2832); g.fillStyle = t.def.color; g.fill();
        if (sev >= 1) ring(x, y, r + 1.5, SEV[sev], 2);
        if (prio < 62) { g.font = NAME_FONT; g.textAlign = 'left'; g.textBaseline = 'middle'; setSpacing(g, 0.4); haloText(g, m.name, x + r + 7, y, '#f2f7f5'); setSpacing(g, 0); }
        hasAnim = true;
      }
      iY[i] = y; iR[i] = r;
      if (prio >= 61) {
        g.globalAlpha = Math.max(a, 0.6);
        if (prio === 63) ring(x, y, r + 5.5, ACCENT, 2.6);
        else if (prio === 62) ring(x, y, r + 4.5, '#ffffff', 1.4);
        else ring(x, y, r + 4.5, '#ffe9a8', 1.6);
      }
    }
    // Names of the selected and hovered objects, over everything.
    g.font = NAME_FONT; g.textAlign = 'left'; g.textBaseline = 'middle'; setSpacing(g, 0.4);
    for (let k = nItems - 1; k >= 0; k--) {
      const i = order[k];
      if (iPrio[i] < 62) break;
      if (iHide[i]) continue;
      const m = iM[i]!;
      g.globalAlpha = Math.max(iA[i], 0.6);
      haloText(g, m.name, iX[i] + iR[i] + 10, iY[i], iPrio[i] === 63 ? '#ffffff' : '#e9f2ef', 'rgba(3,11,16,0.9)', 3.6);
    }
    setSpacing(g, 0);
    g.globalAlpha = 1;
  }

  function refreshNotes(wall: number) {
    const t = typeById.get('aircraft');
    if (!t) return;
    for (const m of t.list) { const min = Math.round((wall - m.time) / 60000); m.note = min >= 90 ? Math.round(min / 60) + ' h' : min + ' min'; }
  }

  // ---- interaction ----
  function hit(px: number, py: number): number {
    let best = -1, bd = 1e9;
    for (let k = nItems - 1; k >= 0; k--) {
      const i = order[k];
      if (iHide[i]) continue;
      const dx = iX[i] - px, dy = iY[i] - py, d = dx * dx + dy * dy, lim = Math.max(14, iR[i] + 3);
      if (d < lim * lim && d < bd - 9) { bd = d; best = i; }
    }
    return best;
  }
  const offHover = ctx.onHover(100, (e) => {
    if (S.layerOn.value.markers === false) return false;
    const i = hit(e.x, e.y);
    if (i < 0) return false;
    const m = iM[i]!;
    if (iN[i] > 1) {
      const es = S.lang.value === 'es';
      const text = `${iN[i]} ${m.t.def.plural[es ? 'es' : 'en'].toLowerCase()} · ${es ? 'acercar' : 'zoom in'}`;
      if (S.hoverText.value !== text) S.hoverText.value = text;
      if (S.hoveredId.value) S.hoveredId.value = null;
    } else {
      if (S.hoveredId.value !== m.id) S.hoveredId.value = m.id;
      if (S.hoverText.value) S.hoverText.value = null;
    }
    return true;
  });
  const offPick = ctx.onPick(100, (e) => {
    if (S.layerOn.value.markers === false) return false;
    const i = hit(e.x, e.y);
    if (i < 0) return false;
    if (iN[i] > 1) S.flyTo.value = { lon: iLon[i], lat: iLat[i], range: Math.max(700, range * 0.36), seconds: 1.2 };
    else S.select(iM[i]!.id);
    return true;
  });

  return {
    update(f) {
      if (sizeDirty) resize();
      const on = S.layerOn.value, sel = S.selectedId.value, hov = S.hoveredId.value, hl = S.highlightIds.value;
      range = world.camera.position.distanceTo(world.controls.target);
      let dirty = view.sync(W, H, range);
      if (f.now - lastTerrainCheck > 1.2) {
        lastTerrainCheck = f.now;
        const s = terrain.stats(), sig = s.tiles * 4096 + s.maxZoom * 64 + Math.min(63, s.pending);
        if (sig !== terrainSig) { terrainSig = sig; terrainStamp++; dirty = true; }
        const minute = Math.floor(Date.now() / 30000);
        if (minute !== seenMinute) { seenMinute = minute; refreshNotes(Date.now()); dirty = true; }
      }
      if (world.seaLevel !== seenSea) { seenSea = world.seaLevel; terrainStamp++; dirty = true; }
      if (dataVersion !== seenData) { seenData = dataVersion; dirty = true; selM = sel ? byId.get(sel) ?? null : null; hovM = hov ? byId.get(hov) ?? null : null; refreshNotes(Date.now()); }
      if (sel !== seenSel) { seenSel = sel; selM = sel ? byId.get(sel) ?? null : null; dirty = true; }
      if (hov !== seenHov) { seenHov = hov; hovM = hov ? byId.get(hov) ?? null : null; dirty = true; }
      if (hl !== seenHl) { seenHl = hl; hlSet.clear(); for (const id of hl) hlSet.add(id); dirty = true; }
      if (on !== seenOn) { seenOn = on; dirty = true; }
      if (S.lang.value !== seenLang) { seenLang = S.lang.value; dirty = true; }
      // Nothing moved and nothing changed: keep the last picture, except for the slow pulse of severe events.
      if (!dirty && !pending && !(hasAnim && f.now - lastDraw > 1 / 20)) return;
      const t0 = performance.now();
      const dt = Math.min(0.1, Math.max(0.001, f.now - lastDraw));
      lastDraw = f.now;
      pending = false; hasAnim = false;
      view.budget = 60; view.pending = false; hBudget = 600;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      far = smooth(90000, 260000, range); gs = 1 - 0.27 * far; grid = GRID * (1 + 0.4 * far);
      if (on.markers !== false) { build(on, dt); paint(f.now, Date.now()); } else { nItems = 0; nDrawn = 0; nClustered = 0; nHidden = 0; }
      // Names go over the pins: thin haloed type costs little and is what orients the reader.
      if (on.labels !== false && labels.draw(g, view, range, terrainStamp, dt)) pending = true;
      if (view.pending) pending = true;
      ms += (performance.now() - t0 - ms) * 0.1;
    },
    debug() {
      const out: Record<string, number> = {};
      for (const t of types) out[t.id] = t.list.length;
      return { layer: 'markers', types: out, drawn: nDrawn, clustered: nClustered, hidden: nHidden, labels: labels.drawn(), ms: Math.round(ms * 100) / 100 };
    },
    dispose() {
      offHover(); offPick(); offChange(); ro.disconnect(); window.removeEventListener('resize', onWin);
      for (const t of types) clearTimeout(t.timer);
      cv.remove();
    },
  } as ReturnType<LayerFactory> & { debug(): unknown };
};
