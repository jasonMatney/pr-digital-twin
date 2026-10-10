// Municipio outlines draped over the terrain, the selected and highlighted municipios, hover names and clicks on
// the ground, and the footprint of the selected alert. Outlines are Census TIGER boundaries clipped to land.
import * as THREE from 'three';
import { effect } from '@preact/signals';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as S from '../core/state';
import { curveDrop, lonLatToXZ, xzToLonLat } from '../core/geo.ts';
import { dataUrl } from '../core/config';
import type { LayerFactory } from './layers';
import { loadMunicipios, municipioAt, type Municipio } from './choropleth';

const ACCENT = 0xff6a3d, SECOND = [1.0, 0.82, 0.36], BASE = [0.9, 0.96, 0.95];
const NIGHT_DIM = 0.84;                                   // share of the outline opacity taken away at full night
const BASE_A = 0.5, MAX_SEG = 320;                       // metres between draped vertices
const SEVERITY = [0x9fb4b8, 0xf2c94c, 0xf2994a, 0xeb5757, 0xc23bd4];
const FOOTPRINT_TYPES = new Set(['weather_alert', 'tropical_cyclone', 'earthquake', 'disaster_declaration']);
// Smaller Census areas are outlined only when selected; their boundary files load on first use.
const AREA_FILES: Record<string, string> = { barrio: 'data/geo/barrios.geojson', tract: 'data/geo/tracts.geojson' };
const areaCache = new Map<string, Promise<Map<string, any>>>();
function loadAreas(type: string): Promise<Map<string, any>> {
  let p = areaCache.get(type);
  if (!p) {
    p = fetch(dataUrl(AREA_FILES[type])).then((r) => { if (!r.ok) throw new Error(type + ' boundaries unavailable'); return r.json(); }).then((g) => new Map<string, any>((g.features ?? []).map((f: any) => [String(f.properties?.GEOID), f.geometry])));
    p.catch(() => areaCache.delete(type));
    areaCache.set(type, p);
  }
  return p;
}
function geometrySegments(g: any, maxSeg: number): number[] {
  const polys: number[][][][] = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
  const out: number[] = [];
  for (const poly of polys) for (const ring of poly) if (ring.length > 1) ringSegments(ring.flat(), out, maxSeg);
  return out;
}
const OVER_WATER_LAYER = 3;                              // see post/ocean.ts: drawn after the sea when post.overWater is on

interface Feat { m: Municipio; off: number; count: number; cx: number; cz: number; r: number }

/** Segment list (pairs of points, x z x z ...) for a ring, split so no piece is longer than MAX_SEG. */
function ringSegments(ring: ArrayLike<number>, out: number[], maxSeg = MAX_SEG) {
  let [ax, az] = lonLatToXZ(ring[0], ring[1]);
  for (let i = 2; i < ring.length; i += 2) {
    const [bx, bz] = lonLatToXZ(ring[i], ring[i + 1]);
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / maxSeg));
    for (let k = 0; k < n; k++) out.push(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, ax + ((bx - ax) * (k + 1)) / n, az + ((bz - az) * (k + 1)) / n);
    ax = bx; az = bz;
  }
}

export const createBoundaries: LayerFactory = async ({ world, store, onHover, onPick }) => {
  const list = await loadMunicipios();
  const terrain = world.terrain;
  const group = new THREE.Group();
  group.name = 'boundaries';
  world.scene.add(group);

  // ---- all outlines: one geometry, one draw call; per-vertex colour carries the highlight ----
  const feats: Feat[] = [], byId = new Map<string, Feat>();
  const xz: number[] = [];
  for (const m of list) {
    const off = xz.length / 2;
    for (const poly of m.polys) for (const ring of poly) ringSegments(ring, xz);
    const [x0, z0] = lonLatToXZ(m.bbox[0], m.bbox[3]), [x1, z1] = lonLatToXZ(m.bbox[2], m.bbox[1]);
    const f = { m, off, count: xz.length / 2 - off, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2 };
    feats.push(f); byId.set('municipio:' + m.geoid, f);
  }
  const nVert = xz.length / 2;
  const pos = new Float32Array(nVert * 3), col = new Float32Array(nVert * 4);
  for (let i = 0; i < nVert; i++) {
    const x = xz[i * 2], z = xz[i * 2 + 1];
    pos[i * 3] = x; pos[i * 3 + 1] = -curveDrop(x, z); pos[i * 3 + 2] = z;
    col[i * 4] = BASE[0]; col[i * 4 + 1] = BASE[1]; col[i * 4 + 2] = BASE[2]; col[i * 4 + 3] = BASE_A;
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3), colAttr = new THREE.BufferAttribute(col, 4);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr); geo.setAttribute('color', colAttr);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 400000);
  const liftU = { value: 10 };
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, opacity: 1, fog: false });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLift = liftU;
    sh.vertexShader = sh.vertexShader.replace('void main() {', 'uniform float uLift;\nvoid main() {').replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed.y += uLift;');
  };
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false; lines.renderOrder = 20;
  group.add(lines);

  // Vertices follow the best elevation loaded so far; they are placed again as the terrain refines near the camera.
  const queue: Feat[] = [];
  let terrainKey = '', firstPass = true;
  const redraped = new Set<Feat>();
  function drape(f: Feat) {
    for (let i = f.off, e = f.off + f.count; i < e; i++) {
      const x = xz[i * 2], z = xz[i * 2 + 1];
      pos[i * 3 + 1] = Math.max(terrain.heightAt(x, z) ?? 0, 0) - curveDrop(x, z);
    }
    redraped.add(f);
  }
  function refill() {
    const t = world.controls.target, range = S.cameraView.value.range;
    queue.length = 0;
    for (const f of feats) if (firstPass || Math.hypot(f.cx - t.x, f.cz - t.z) - f.r < range * 1.6) queue.push(f);
    queue.sort((a, b) => Math.hypot(b.cx - t.x, b.cz - t.z) - Math.hypot(a.cx - t.x, a.cz - t.z));     // pop() takes the nearest
    firstPass = false;
  }

  // ---- thick outlines: selection (accent, with a glow) and alert footprints ----
  const res = new THREE.Vector2(1, 1);
  const thickMat = (color: number, width: number, opacity: number, depthTest = true) => {
    const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthWrite: false, depthTest, worldUnits: false });
    m.resolution = res;
    return m;
  };
  const selGlow = new LineSegments2(new LineSegmentsGeometry(), thickMat(ACCENT, 8, 0.2));
  const selLine = new LineSegments2(new LineSegmentsGeometry(), thickMat(ACCENT, 2.6, 0.98));
  for (const o of [selGlow, selLine]) { o.visible = false; o.frustumCulled = false; o.renderOrder = 22; group.add(o); }
  selGlow.renderOrder = 21;
  // Highlighted municipios (alert or declaration footprint, hurricane-force winds, search results): a 2 px line on top
  // of the thin one, so the set reads from island range.
  const hiLine = new LineSegments2(new LineSegmentsGeometry(), thickMat(0xffd15c, 2.2, 0.95));
  hiLine.visible = false; hiLine.frustumCulled = false; hiLine.renderOrder = 21; group.add(hiLine);
  let hiFeats: Feat[] = [], hiLift = 0;
  function buildHi() {
    if (!hiFeats.length) { hiLine.visible = false; return; }
    hiLift = liftU.value;
    let n = 0;
    for (const f of hiFeats) n += f.count;
    const a = new Float32Array(n * 3);
    let o = 0;
    for (const f of hiFeats) for (let i = 0; i < f.count; i++, o += 3) { const j = (f.off + i) * 3; a[o] = pos[j]; a[o + 1] = pos[j + 1] + hiLift * 1.15 + 1; a[o + 2] = pos[j + 2]; }
    hiLine.geometry.dispose(); hiLine.geometry = new LineSegmentsGeometry().setPositions(a); hiLine.visible = true;
  }
  let selFeat: Feat | null = null, selXZ: number[] | null = null, selLift = 0;
  function buildSelected() {
    if (!selFeat && !selXZ) { selGlow.visible = selLine.visible = false; return; }
    selLift = liftU.value;
    let a: Float32Array;
    if (selFeat) {
      const f = selFeat;
      a = new Float32Array(f.count * 3);
      for (let i = 0; i < f.count; i++) { const j = (f.off + i) * 3; a[i * 3] = pos[j]; a[i * 3 + 1] = pos[j + 1] + selLift * 1.3 + 2; a[i * 3 + 2] = pos[j + 2]; }
    } else {
      const q = selXZ!, n = q.length / 2;
      a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const x = q[i * 2], z = q[i * 2 + 1]; a[i * 3] = x; a[i * 3 + 1] = Math.max(terrain.heightAt(x, z) ?? 0, 0) - curveDrop(x, z) + selLift * 1.3 + 2; a[i * 3 + 2] = z; }
    }
    // Barrios and tracts reach into bays and lagoons (they are not clipped to land): over water the outline has to be
    // drawn after the sea, or the water pass absorbs it.
    for (const o of [selGlow, selLine]) { o.geometry.dispose(); o.geometry = new LineSegmentsGeometry().setPositions(a); o.visible = true; o.layers.set(selXZ ? OVER_WATER_LAYER : 0); }
    if (selXZ) (world.post as any).overWater = true;
  }

  const alertLine = new LineSegments2(new LineSegmentsGeometry(), thickMat(SEVERITY[2], 2.4, 0.95, false));
  alertLine.visible = false; alertLine.frustumCulled = false; alertLine.renderOrder = 23; alertLine.layers.set(OVER_WATER_LAYER);
  group.add(alertLine);
  const thick: [LineSegments2, number][] = [selGlow, selLine, hiLine, alertLine].map((o) => [o, (o.material as LineMaterial).opacity]);
  let seenNight = 0;
  let alertXZ: number[] | null = null;
  function buildAlert() {
    if (!alertXZ) { alertLine.visible = false; return; }
    const n = alertXZ.length / 2, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = alertXZ[i * 2], z = alertXZ[i * 2 + 1];
      a[i * 3] = x; a[i * 3 + 1] = Math.max(terrain.heightAt(x, z) ?? 0, 0) + 40 - curveDrop(x, z); a[i * 3 + 2] = z;
    }
    alertLine.geometry.dispose(); alertLine.geometry = new LineSegmentsGeometry().setPositions(a); alertLine.visible = true;
    (world.post as any).overWater = true;
  }

  // ---- state ----
  let wroteHighlights = false, anyHighlight = false, seq = 0;
  const stopSel = effect(() => {
    const id = S.selectedId.value, my = ++seq;
    selFeat = id ? byId.get(id) ?? null : null; selXZ = null;
    buildSelected();
    const type = id ? id.slice(0, id.indexOf(':')) : '';
    if (id && AREA_FILES[type]) {
      loadAreas(type).then((m) => {
        if (my !== seq) return;
        const segs = geometrySegments(m.get(id.slice(type.length + 1)), 150);
        if (segs.length) { selXZ = segs; buildSelected(); }
      }).catch((e) => console.warn('[garita/boundaries]', e));
    }
    alertXZ = null; buildAlert();
    if (wroteHighlights) { wroteHighlights = false; S.highlightIds.value = []; }
    if (!id || !FOOTPRINT_TYPES.has(id.split(':')[0])) return;
    // Nothing in the UI writes the footprint of an alert, so this layer does (and clears it when the selection moves on).
    store.getLinks(id, { type: 'affects', direction: 'out', limit: 200 }).then((links) => {
      if (my !== seq) return;
      const ids = links.map((l) => l.dst).filter((d) => d.startsWith('municipio:'));
      if (ids.length) { S.highlightIds.value = ids; wroteHighlights = true; }
    }).catch(() => {});
    store.getObject(id).then((o) => {
      if (my !== seq || !o?.geometry) return;
      const out = geometrySegments(o.geometry, 600);
      if (!out.length) return;
      (alertLine.material as LineMaterial).color.setHex(SEVERITY[Math.min(4, Math.max(0, Math.round(o.severity ?? 2)))]);
      alertXZ = out; buildAlert();
    }).catch(() => {});
  });
  const stopHi = effect(() => {
    const on = new Set(S.highlightIds.value.filter((i) => i.startsWith('municipio:')));
    anyHighlight = on.size > 0;
    for (const f of feats) {
      const hi = on.has('municipio:' + f.m.geoid), c = hi ? SECOND : BASE, a = hi ? 1 : BASE_A;
      if (col[f.off * 4 + 3] === a) continue;
      for (let i = f.off, e = f.off + f.count; i < e; i++) { col[i * 4] = c[0]; col[i * 4 + 1] = c[1]; col[i * 4 + 2] = c[2]; col[i * 4 + 3] = a; }
    }
    colAttr.needsUpdate = true;
    hiFeats = feats.filter((f) => on.has('municipio:' + f.m.geoid)); buildHi();
  });

  // ---- hover and click on the ground: lowest priority, markers and buildings come first ----
  const under = (e: { ground(): THREE.Vector3 | null }): Municipio | null => {
    if (!S.layerOn.value.municipios) return null;
    const g = e.ground();
    if (!g) return null;
    const [lon, lat] = xzToLonLat(g.x, g.z);
    return municipioAt(list, lon, lat);
  };
  const offHover = onHover(0, (e) => {
    const m = under(e);
    if (!m) return false;
    if (S.hoveredId.value) S.hoveredId.value = null;
    S.hoverText.value = `${m.name} · municipio`;
    return true;
  });
  const offPick = onPick(0, (e) => {
    const m = under(e);
    if (!m) return false;
    S.select('municipio:' + m.geoid);
    return true;
  });

  return {
    update(f) {
      const range = S.cameraView.value.range, on = !!S.layerOn.value.municipios;
      // Far away one pixel covers hundreds of metres and the drawn terrain is coarser than the elevation it was sampled from.
      liftU.value = Math.min(450, 5 + range * 0.0014);
      const fade = THREE.MathUtils.smoothstep(range, 3500, 9000);
      // The lines are unlit: against a night scene a day-strength outline outshines the town lights. After dark they
      // fall to a faint guide; the selection and highlights keep more, they are what the reader asked for.
      const night = Math.min(1, Math.max(0, world.night || 0));
      mat.opacity = (anyHighlight ? Math.max(fade, 0.7) : fade) * (1 - NIGHT_DIM * night);
      if (night !== seenNight) {
        seenNight = night;
        for (const [o, base] of thick) (o.material as LineMaterial).opacity = base * (1 - 0.45 * night);
      }
      lines.visible = on && mat.opacity > 0.01;
      world.renderer.getDrawingBufferSize(res);
      if (f.index % 15 === 0 && !queue.length) {
        const s = terrain.stats(), key = `${s.tiles}/${s.maxZoom}/${s.pending > 0}`;
        if (key !== terrainKey || firstPass) { terrainKey = key; refill(); }
      }
      let budget = 5000;
      while (queue.length && budget > 0) { const q = queue.pop()!; drape(q); budget -= q.count; }
      if (redraped.size) {
        posAttr.needsUpdate = true;
        if ((selFeat && redraped.has(selFeat)) || (selXZ && f.index % 30 === 0)) buildSelected();
        if (alertXZ && f.index % 30 === 0) buildAlert();
        if (hiFeats.length && f.index % 30 === 0) buildHi();
        redraped.clear();
      }
      if ((selFeat || selXZ) && Math.abs(liftU.value - selLift) > 0.2 * selLift + 1) buildSelected();
      if (hiFeats.length && Math.abs(liftU.value - hiLift) > 0.2 * hiLift + 1) buildHi();
      hiLine.visible = hiFeats.length > 0 && on;
    },
    dispose() {
      stopSel(); stopHi(); offHover(); offPick();
      if (wroteHighlights) S.highlightIds.value = [];
      world.scene.remove(group);
      geo.dispose(); mat.dispose();
      for (const o of [selGlow, selLine, alertLine, hiLine]) { o.geometry.dispose(); (o.material as LineMaterial).dispose(); }
    },
    ...({ debug: () => ({ municipios: feats.length, vertices: nVert, queued: queue.length, lift: +liftU.value.toFixed(1), selected: selFeat?.m.name ?? (selXZ ? `outline, ${selXZ.length / 4} segments` : null), footprint: alertXZ ? alertXZ.length / 4 : 0, highlights: S.highlightIds.value.length, selectedId: S.selectedId.value }) } as object),
  };
};
