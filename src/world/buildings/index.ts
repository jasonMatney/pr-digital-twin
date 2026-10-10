// Buildings: every OpenStreetMap footprint in Puerto Rico (1.5 million), streamed as zoom-14 tiles around the
// orbit target when the camera is low, meshed in a Worker into one geometry per tile, drawn with one material.
//
// REAL (from the tiles): footprints, the heights OpenStreetMap carries (13.8 %), ground elevation at the centroid,
// FEMA flood class. PROCEDURAL: all other heights (flagged; the tooltip says "estimated"), wall and roof colours,
// windows, lit rooms. The sea-level tint is a bathtub screen: ground elevation against the scenario level.
import * as THREE from 'three';
import * as S from '../../core/state';
import { dataUrl } from '../../core/config';
import { curveDrop, lonToTileX, latToTileY, xzToLonLat, AST_OFFSET_H } from '../../core/geo.ts';
import type { LayerFactory, PickEvent } from '../layers';
import type { Frame } from '../types';
import { createBuildingMaterial } from './material';
import type { MeshJob, MeshResult } from './worker';

const Z = 14, MAX_RANGE = 14000, FADE_S = 0.45, MAX_FETCH = 4, SINK = 3;

interface Tile {
  key: string; x: number; y: number; id: number;
  state: 'queued' | 'loading' | 'ready' | 'failed';
  used: number; d: number; born: number; fading: boolean;
  mesh: THREE.Mesh | null; pick: MeshResult | null; count: number; tris: number; yRef: number;
}

export const createBuildings: LayerFactory = async (ctx) => {
  const { world } = ctx;
  const group = new THREE.Group();
  group.name = 'buildings';
  world.scene.add(group);
  const { material, uniforms } = createBuildingMaterial();

  // which tiles exist (so the sea and the forest never cost a 404)
  const have = new Set<string>();
  try {
    const idx = await fetch(dataUrl('tiles/bld/index.json')).then((r) => (r.ok ? r.json() : null));
    for (const t of (idx?.tiles ?? []) as [number, number, number][]) have.add(t[0] + '/' + t[1]);
  } catch (e) { console.warn('[garita/buildings] no building index', e); }

  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const tiles = new Map<string, Tile>();
  const byId = new Map<number, Tile>();
  const wanted: Tile[] = [], ready: Tile[] = [];
  let nextId = 1, loading = 0, stamp = 0, disposed = false, lastScan = -1, now = 0;
  let nBuildings = 0, nTris = 0, nReady = 0;

  const dropTile = (t: Tile) => {
    if (t.mesh) { group.remove(t.mesh); t.mesh.geometry.dispose(); nBuildings -= t.count; nTris -= t.tris; nReady--; }
    t.mesh = null; t.pick = null;
    tiles.delete(t.key); byId.delete(t.id);
  };

  worker.onmessage = (e: MessageEvent<MeshResult | { id: number; error: string }>) => {
    const r = e.data, t = byId.get(r.id);
    loading--;
    if (!t || disposed) return;
    if ('error' in r) { t.state = 'failed'; console.warn('[garita/buildings] meshing failed', t.key, r.error); return; }
    t.state = 'ready'; t.count = r.count; t.tris = r.triangles; t.yRef = r.yRef; t.pick = r;
    if (!r.count) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3, true));
    g.setAttribute('aFac', new THREE.BufferAttribute(r.fac, 4));
    g.setAttribute('aBld', new THREE.BufferAttribute(r.bld, 3));
    g.setIndex(new THREE.BufferAttribute(r.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(r.sphere[0], r.sphere[1], r.sphere[2]), r.sphere[3]);
    const m = new THREE.Mesh(g, material);
    m.matrixAutoUpdate = false;
    m.position.set(r.cx, r.yRef, r.cz); m.scale.set(1, 0.02, 1); m.updateMatrix();
    t.mesh = m; t.born = now; t.fading = true;
    group.add(m);
    nBuildings += t.count; nTris += t.tris; nReady++;
  };

  const startLoad = (t: Tile) => {
    t.state = 'loading'; loading++;
    fetch(dataUrl(`tiles/bld/${Z}/${t.x}/${t.y}.bin`))
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((buf) => {
        if (disposed || tiles.get(t.key) !== t) { loading--; return; }
        const job: MeshJob = { id: t.id, x: t.x, y: t.y, buf };
        worker.postMessage(job, [buf]);
      })
      .catch((err) => { loading--; t.state = 'failed'; if (!disposed) console.warn('[garita/buildings] tile failed', t.key, String(err)); });
  };

  const byDist = (a: Tile, b: Tile) => a.d - b.d;
  const byUsed = (a: Tile, b: Tile) => a.used - b.used || b.d - a.d;
  /** Decide which tiles are wanted around the orbit target, start loads (nearest first), evict the least recently used. */
  const scan = (range: number) => {
    const low = S.quality.value === 'low';
    const maxTiles = low ? 20 : 44;
    let radius = THREE.MathUtils.clamp(range * 1.15 + 1200, 2600, 8600);
    if (low) radius *= 0.5;
    const tg = world.controls.target;
    const [lon, lat] = xzToLonLat(tg.x, tg.z);
    const tx = lonToTileX(lon, Z), ty = latToTileY(lat, Z), rT = radius / 2320;
    stamp++;
    wanted.length = 0;
    for (let y = Math.floor(ty - rT); y <= Math.floor(ty + rT); y++) for (let x = Math.floor(tx - rT); x <= Math.floor(tx + rT); x++) {
      const key = x + '/' + y;
      if (!have.has(key)) continue;
      const dx = Math.max(x - tx, 0, tx - x - 1), dy = Math.max(y - ty, 0, ty - y - 1);
      if (dx * dx + dy * dy > rT * rT) continue;
      let t = tiles.get(key);
      if (!t) { t = { key, x, y, id: nextId++, state: 'queued', used: 0, d: 0, born: 0, fading: false, mesh: null, pick: null, count: 0, tris: 0, yRef: 0 }; tiles.set(key, t); byId.set(t.id, t); }
      t.d = Math.hypot(x + 0.5 - tx, y + 0.5 - ty);
      wanted.push(t);
    }
    wanted.sort(byDist);
    if (wanted.length > maxTiles) wanted.length = maxTiles;
    for (const t of wanted) t.used = stamp;
    for (const t of wanted) { if (loading >= MAX_FETCH) break; if (t.state === 'queued') startLoad(t); }
    // evict: queued tiles no longer wanted go at once; meshes beyond the budget go oldest first
    ready.length = 0;
    for (const t of tiles.values()) {
      if (t.used === stamp) continue;
      if (t.state === 'queued' || t.state === 'failed') dropTile(t); else if (t.state === 'ready') ready.push(t);
    }
    if (tiles.size > maxTiles) { ready.sort(byUsed); for (const t of ready) { if (tiles.size <= maxTiles) break; dropTile(t); } }
  };

  // ---- hover: ray against the prisms near where the ray meets the ground
  const KIND = { en: ['house', 'apartments', 'commercial', 'industrial', 'civic', 'religious', ''], es: ['casa', 'apartamentos', 'comercial', 'industrial', 'cívico', 'religioso', ''] };
  const FLOOD = { en: ['', 'FEMA 0.2 % annual-chance zone', 'FEMA 1 % annual-chance zone', 'FEMA coastal high-hazard zone'], es: ['', 'zona FEMA de 0.2 % anual', 'zona FEMA de 1 % anual', 'zona costera de alto riesgo FEMA'] };
  const inRing = (p: MeshResult, i: number, x: number, z: number) => {
    let inside = false;
    const a = p.ringStart[i], b = p.ringStart[i + 1], r = p.ring;
    for (let k = a, j = b - 1; k < b; j = k++) {
      const xk = r[k * 2], zk = r[k * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
      if ((zk > z) !== (zj > z) && x < (xj - xk) * (z - zk) / (zj - zk) + xk) inside = !inside;
    }
    return inside;
  };
  const hover = (e: PickEvent): boolean => {
    if (!group.visible) return false;
    const g = e.ground();
    if (!g) return false;
    const o = e.origin, d = e.dir;
    const tG = g.distanceTo(o), tA = Math.max(0, tG - 700);
    const ax = o.x + d.x * tA, az = o.z + d.z * tA;
    const sx0 = Math.min(ax, g.x) - 2, sx1 = Math.max(ax, g.x) + 2, sz0 = Math.min(az, g.z) - 2, sz1 = Math.max(az, g.z) + 2;
    let best = tG + 4, bt: Tile | null = null, bi = -1;
    for (const t of tiles.values()) {
      const p = t.pick;
      if (!p || !t.mesh || !p.count) continue;
      const lx0 = sx0 - p.cx, lx1 = sx1 - p.cx, lz0 = sz0 - p.cz, lz1 = sz1 - p.cz;
      if (lx1 < -2400 || lx0 > 2400 || lz1 < -2400 || lz0 > 2400) continue;
      const ox = o.x - p.cx, oz = o.z - p.cz, bb = p.bbox, drop = curveDrop(g.x, g.z);
      for (let i = 0; i < p.count; i++) {
        if (bb[i * 4] > lx1 || bb[i * 4 + 2] < lx0 || bb[i * 4 + 1] > lz1 || bb[i * 4 + 3] < lz0) continue;
        const yTop = p.base[i] + p.height[i] - drop, yLow = p.base[i] - SINK - drop;
        if (d.y < -1e-6) {
          const tt = (yTop - o.y) / d.y;
          if (tt > 0 && tt < best && inRing(p, i, ox + d.x * tt, oz + d.z * tt)) { best = tt; bt = t; bi = i; }
        }
        const a = p.ringStart[i], b = p.ringStart[i + 1], r = p.ring;
        for (let k = a, j = b - 1; k < b; j = k++) {
          const x1 = r[j * 2], z1 = r[j * 2 + 1], ex = r[k * 2] - x1, ez = r[k * 2 + 1] - z1;
          const den = d.x * ez - d.z * ex;
          if (Math.abs(den) < 1e-9) continue;
          const tt = ((x1 - ox) * ez - (z1 - oz) * ex) / den, s = ((x1 - ox) * d.z - (z1 - oz) * d.x) / den;
          if (tt <= 0 || tt >= best || s < 0 || s > 1) continue;
          const y = o.y + d.y * tt;
          if (y >= yLow && y <= yTop) { best = tt; bt = t; bi = i; }
        }
      }
    }
    if (!bt || bi < 0) return false;
    const p = bt.pick!, m = p.meta[bi], es = S.lang.value === 'es';
    const kind = (es ? KIND.es : KIND.en)[m & 7], flood = (es ? FLOOD.es : FLOOD.en)[(m >> 3) & 3], est = (m & 32) !== 0;
    const parts = [(es ? 'Edificio' : 'Building') + (kind ? ` (${kind})` : '')];
    parts.push(`${p.height[bi].toFixed(1)} m ` + (est ? (es ? '(altura estimada)' : '(height estimated)') : (es ? '(altura de OpenStreetMap)' : '(height from OpenStreetMap)')));
    if (p.ground[bi] !== -32768) parts.push((es ? 'terreno ' : 'ground ') + (p.ground[bi] / 10).toFixed(1) + ' m');
    if (flood) parts.push(flood);
    const text = parts.join(' · ');
    if (S.hoverText.value !== text) S.hoverText.value = text;
    if (S.hoveredId.value) S.hoveredId.value = null;
    return true;
  };
  const offHover = ctx.onHover(10, hover);

  const update = (f: Frame) => {
    now = f.now;
    const range = S.cameraView.value.range;
    const on = S.layerOn.value.buildings !== false && range < MAX_RANGE;
    if (group.visible !== on) group.visible = on;
    if (!on) return;
    // uniforms from the world and the app state
    uniforms.uBNight.value = world.night;
    uniforms.uBSea.value = world.seaLevel;
    uniforms.uBNfhl.value = S.overlay.value === 'nfhl' ? 1 : 0;
    // share of rooms lit by the scene clock (AST): evening full, thinning after 22 h, least before dawn
    const hr = (((S.sceneTime.value / 3600000 + AST_OFFSET_H) % 24) + 24) % 24;
    const late = hr >= 18 ? Math.max(0, hr - 21.5) : hr + 2.5;       // hours past 21:30
    uniforms.uBLit.value = hr > 6.5 && hr < 17 ? 0.25 : THREE.MathUtils.clamp(0.36 - late * 0.06, 0.07, 0.36) + (hr > 5 && hr <= 6.5 ? 0.1 : 0);

    if (f.index % 8 === 0 || lastScan < 0) { lastScan = f.index; scan(range); }
    for (const t of tiles.values()) {
      if (!t.fading || !t.mesh) continue;
      let s = (now - t.born) / FADE_S;
      if (s >= 1) { s = 1; t.fading = false; }
      s = s * s * (3 - 2 * s);
      t.mesh.scale.y = Math.max(0.02, s); t.mesh.position.y = (1 - s) * t.yRef; t.mesh.updateMatrix();
    }
  };

  const layer = {
    update,
    debug: () => ({ tiles: nReady, buildings: nBuildings, triangles: nTris, pending: loading + [...tiles.values()].filter((t) => t.state === 'queued').length }),
    dispose() {
      disposed = true; offHover(); worker.terminate();
      for (const t of [...tiles.values()]) dropTile(t);
      world.scene.remove(group); material.dispose();
    },
  };
  return layer;
};
