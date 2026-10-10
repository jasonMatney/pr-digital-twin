// Replay of a historical storm (S.replayStormId) at the scene clock: the best track, the eye, and the wind radii as
// the four-lobed footprint the best track records. Everything drawn here is the historical record (NOAA HURDAT2),
// not a simulation. Live cyclones are drawn by the markers layer.
import * as THREE from 'three';
import { effect, signal } from '@preact/signals';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as S from '../core/state';
import { AST_OFFSET_H, DEG, curveDrop, lonLatToXZ } from '../core/geo.ts';
import { loadStorms, saffirSimpson, stormAt, windBandAt, type Storm, type StormPoint } from '../core/storms.ts';
import type { LayerFactory } from './layers';
import { loadMunicipios } from './choropleth';

export interface ReplayInfo {
  id: string; name: string; year: number; t: number; lat: number; lon: number;
  wind_kt: number; pressure_mb: number | null; category: string; status: string;
  /** Municipios (interior point) inside each wind radius at this moment; null when the best track has no radii. */
  band_counts: { 34: number; 50: number; 64: number } | null;
  /** False before 2004: HURDAT2 holds no wind radii for this storm. */
  hasRadii: boolean;
  /** Inside the period the best track covers. */
  active: boolean;
  source: string;
}
/** What the replay shows right now, for the UI. null when no storm is replayed. */
export const replayInfo = signal<ReplayInfo | null>(null);

const SOURCE = 'Best track (HURDAT2), NOAA National Hurricane Center';
const ALT = 350;                                            // metres above the sea: clear of the swell, still reads as "on the map"
const BANDS = [{ kt: 34 as const, color: 0xffd84d, css: '#ffd84d', a: 0.22 }, { kt: 50 as const, color: 0xff9a3d, css: '#ff9a3d', a: 0.27 }, { kt: 64 as const, color: 0xff3b3b, css: '#ff3b3b', a: 0.33 }];
const OVER_WATER_LAYER = 3;                                 // post/ocean.ts draws this layer after the sea when post.overWater is on
const ast = (ms: number) => { const d = new Date(ms + AST_OFFSET_H * 3600000).toISOString(); return `${d.slice(0, 10)} ${d.slice(11, 16)} AST`; };
const at = (lon: number, lat: number, h: number, out: number[]) => { const [x, z] = lonLatToXZ(lon, lat); out.push(x, h - curveDrop(x, z), z); };

export const createStorms: LayerFactory = async ({ world, store }) => {
  const group = new THREE.Group();
  group.name = 'storm-replay'; group.visible = false;
  world.scene.add(group);
  const res = new THREE.Vector2(1, 1);
  const onLayer = <T extends THREE.Object3D>(o: T, order: number): T => { o.layers.set(OVER_WATER_LAYER); o.frustumCulled = false; o.renderOrder = order; group.add(o); return o; };
  const lineMat = (opacity: number, width: number, dashed = false) => { const m = new LineMaterial({ color: 0xffffff, linewidth: width, transparent: true, opacity, depthTest: false, depthWrite: false, dashed, dashSize: 9000, gapSize: 7000 }); m.resolution = res; return m; };
  const future = onLayer(new Line2(new LineGeometry(), lineMat(0.38, 1.6, true)), 40);
  const past = onLayer(new Line2(new LineGeometry(), lineMat(0.95, 2.6)), 41);
  const ticks = onLayer(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })), 42);
  const lobes = BANDS.map((b, i) => ({
    fill: onLayer(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: b.a, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false })), 30 + i),
    edge: onLayer(new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: b.color, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, fog: false })), 34 + i),
  }));
  const eye = onLayer(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 13, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false })), 44);
  eye.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));

  // Label: a canvas sprite kept at a constant size on screen.
  const lc = document.createElement('canvas'); lc.width = 640; lc.height = 176;
  const ltex = new THREE.CanvasTexture(lc); ltex.colorSpace = THREE.SRGBColorSpace;
  const label = onLayer(new THREE.Sprite(new THREE.SpriteMaterial({ map: ltex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false })), 50);
  label.center.set(0.5, -0.25);
  let labelKey = '';
  function drawLabel(lines: string[]) {
    const key = lines.join('|');
    if (key === labelKey) return;
    labelKey = key;
    const g = lc.getContext('2d')!;
    g.clearRect(0, 0, lc.width, lc.height);
    g.fillStyle = 'rgba(5,15,21,0.78)'; g.beginPath(); g.roundRect(4, 4, lc.width - 8, lc.height - 8, 14); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.28)'; g.lineWidth = 2; g.stroke();
    g.textBaseline = 'middle'; g.fillStyle = '#ffffff';
    g.font = '700 38px system-ui, sans-serif'; g.fillText(lines[0], 24, 40, lc.width - 48);
    g.font = '500 27px system-ui, sans-serif'; g.fillStyle = '#e3eef0'; g.fillText(lines[1], 24, 90, lc.width - 48);
    g.fillStyle = '#a9c0c4'; g.fillText(lines[2], 24, 134, lc.width - 48);
    ltex.needsUpdate = true;
  }

  let lastDim = -1;
  let storm: Storm | null = null, seq = 0, lastKey = '', lastHi = '', wroteHi = false, myLegend: S.Legend | null = null;
  let munis: { id: string; lon: number; lat: number }[] = [];
  // Interior points from the store; the Census interior points in the boundary file stand in until it answers.
  loadMunicipios().then((l) => { if (!munis.length) munis = l.map((m) => ({ id: 'municipio:' + m.geoid, lon: m.lon, lat: m.lat })); }).catch(() => {});
  store.listObjects('municipio', { limit: 100, props: [] }).then((rows) => { const ok = rows.filter((r) => r.lon != null && r.lat != null); if (ok.length) munis = ok.map((r) => ({ id: r.id, lon: r.lon!, lat: r.lat! })); }).catch(() => {});

  function buildTrack(s: Storm) {
    const a: number[] = [], tk: number[] = [];
    for (const p of s.points) { at(p.lon, p.lat, ALT, a); if (p.t % 21600000 === 0) at(p.lon, p.lat, ALT, tk); }
    future.geometry.dispose(); future.geometry = new LineGeometry().setPositions(a); future.computeLineDistances();
    ticks.geometry.dispose(); ticks.geometry = new THREE.BufferGeometry(); ticks.geometry.setAttribute('position', new THREE.Float32BufferAttribute(tk, 3));
  }
  function buildPast(s: Storm, now: StormPoint | null, t: number) {
    const a: number[] = [];
    for (const p of s.points) if (p.t <= t) at(p.lon, p.lat, ALT, a);
    if (now) at(now.lon, now.lat, ALT, a);
    past.visible = a.length >= 6;
    if (!past.visible) return;
    past.geometry.dispose(); past.geometry = new LineGeometry().setPositions(a);
  }
  /** One wind threshold: four quarter-circles, each with the radius the best track gives for that quadrant. */
  function buildLobe(i: number, p: StormPoint) {
    const r = i === 0 ? p.r34 : i === 1 ? p.r50 : p.r64, { fill, edge } = lobes[i];
    const show = !!r && r.some((v) => v > 0);
    fill.visible = edge.visible = show;
    if (!show) return;
    const [ex, ez] = lonLatToXZ(p.lon, p.lat), h = ALT - 60 + i * 20;
    const rim: number[] = [], tri: number[] = [];
    for (let q = 0; q < 4; q++) {
      const rad = (r![q] ?? 0) * 1852;
      for (let d = 0; d <= 90; d += 5) { const b = (q * 90 + d) * DEG, x = ex + rad * Math.sin(b), z = ez - rad * Math.cos(b); rim.push(x, h - curveDrop(x, z), z); }
    }
    const cy = h - curveDrop(ex, ez), n = rim.length / 3;
    for (let k = 0; k < n; k++) { const j = (k + 1) % n; tri.push(ex, cy, ez, rim[k * 3], rim[k * 3 + 1], rim[k * 3 + 2], rim[j * 3], rim[j * 3 + 1], rim[j * 3 + 2]); }
    fill.geometry.dispose(); fill.geometry = new THREE.BufferGeometry(); fill.geometry.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
    edge.geometry.dispose(); edge.geometry = new THREE.BufferGeometry(); edge.geometry.setAttribute('position', new THREE.Float32BufferAttribute(rim, 3));
  }
  function setHighlights(ids: string[]) {
    const key = ids.join(',');
    if (key === lastHi) return;
    lastHi = key;
    if (ids.length || wroteHi) { S.highlightIds.value = ids; wroteHi = ids.length > 0; }
  }
  function legend(s: Storm, hasRadii: boolean) {
    // The raster overlay owns the legend when one is on; the storm takes it only when it is free (or already ours).
    if (S.overlay.peek() != null) { myLegend = null; return; }
    if (S.overlayLegend.peek() != null && S.overlayLegend.peek() !== myLegend) return;
    const es = S.lang.peek() === 'es';
    const want = `${s.id}/${hasRadii}/${es}`;
    if (myLegend && (myLegend as any).key === want && S.overlayLegend.peek() === myLegend) return;
    myLegend = {
      title: `${s.name} ${s.year} · ${es ? 'Mejor trayectoria (HURDAT2)' : 'Best track (HURDAT2)'}`, unit: 'kt',
      stops: hasRadii ? BANDS.map((b) => ({ color: b.css, label: b.kt === 64 ? (es ? '≥ 64 kt (fuerza de huracán)' : '≥ 64 kt (hurricane force)') : b.kt === 50 ? '≥ 50 kt' : (es ? '≥ 34 kt (fuerza de tormenta tropical)' : '≥ 34 kt (tropical storm force)') })) : [],
      note: hasRadii
        ? (es ? 'Extensión máxima del viento sostenido por cuadrante (NE, SE, SO, NO), interpolada entre posiciones de 6 horas. Registro histórico, no una simulación.' : 'Greatest extent of sustained wind in each quadrant (NE, SE, SW, NW), interpolated between 6-hourly fixes. The historical record, not a simulation.')
        : (es ? 'HURDAT2 no registra radios de viento antes de 2004: solo se muestra la trayectoria y la intensidad.' : 'HURDAT2 holds no wind radii before 2004: only the track and the intensity are shown.'),
      source: SOURCE,
    };
    (myLegend as any).key = want;
    S.overlayLegend.value = myLegend;
  }
  function clear() {
    group.visible = false; storm = null; lastKey = '';
    setHighlights([]);
    if (myLegend && S.overlayLegend.peek() === myLegend) S.overlayLegend.value = null;
    myLegend = null;
    replayInfo.value = null;
  }
  function refresh() {
    const s = storm;
    if (!s) return;
    const t = S.sceneTime.value, key = `${s.id}/${Math.round(t / 30000)}/${munis.length}`;
    if (key === lastKey) { legend(s, s.points.some((p) => p.r34)); return; }
    lastKey = key;
    const p = stormAt(s, t), hasRadii = s.points.some((q) => q.r34);
    buildPast(s, p, t);
    eye.visible = label.visible = !!p;
    for (let i = 0; i < 3; i++) { if (p) buildLobe(i, p); else lobes[i].fill.visible = lobes[i].edge.visible = false; }
    legend(s, hasRadii);
    if (!p) {
      setHighlights([]);
      replayInfo.value = { id: s.id, name: s.name, year: s.year, t, lat: NaN, lon: NaN, wind_kt: NaN, pressure_mb: null, category: '', status: '', band_counts: null, hasRadii, active: false, source: SOURCE };
      return;
    }
    const [ex, ez] = lonLatToXZ(p.lon, p.lat);
    eye.position.set(ex, ALT - curveDrop(ex, ez), ez); label.position.copy(eye.position);
    const cat = saffirSimpson(p.wind_kt), kt = Math.round(p.wind_kt / 5) * 5;
    drawLabel([`${s.name} ${s.year} · ${cat.label}`, `${kt} kt (${Math.round(kt * 1.852)} km/h)${p.pressure_mb != null ? ` · ${Math.round(p.pressure_mb)} mb` : ''}`, `${ast(t)} · ${hasRadii ? 'Best track (HURDAT2)' : 'Best track (HURDAT2), no wind radii'}`]);
    const counts = { 34: 0, 50: 0, 64: 0 }, inside: string[] = [];
    if (hasRadii) for (const m of munis) {
      const b = windBandAt(p, m.lon, m.lat);
      if (b >= 34) counts[34]++; if (b >= 50) counts[50]++; if (b >= 64) { counts[64]++; inside.push(m.id); }
    }
    setHighlights(inside);
    replayInfo.value = { id: s.id, name: s.name, year: s.year, t, lat: p.lat, lon: p.lon, wind_kt: p.wind_kt, pressure_mb: p.pressure_mb, category: cat.label, status: p.status, band_counts: hasRadii ? counts : null, hasRadii, active: true, source: SOURCE };
  }

  const stop = effect(() => {
    const id = S.replayStormId.value, my = ++seq;
    if (!id) { clear(); return; }
    loadStorms().then((all) => {
      if (my !== seq) return;
      const s = all.find((x) => x.id === id);
      if (!s) { console.warn('[garita/storms] no such storm in data/replay/storms.json:', id); clear(); return; }
      storm = s; lastKey = '';
      buildTrack(s);
      group.visible = true;
      (world.post as any).overWater = true;
      refresh();
    }).catch((e) => { console.warn('[garita/storms] storm tracks unavailable', e); if (my === seq) clear(); });
  });

  return {
    update(f) {
      if (!storm) return;
      world.renderer.getDrawingBufferSize(res);
      refresh();
      // Unlit colours ignore the sun and are multiplied by the exposure like everything else: the fills follow the
      // daylight so they tint the scene instead of glaring over it, the lines hold a steady brightness on screen.
      if (f.index % 20 === 0 || lastDim < 0) {
        const d = (world.post as any).debug?.() ?? {};
        const daylight = typeof d.daylight === 'number' ? d.daylight : 1 - world.night, exposure = typeof d.exposure === 'number' && d.exposure > 0 ? d.exposure : 1;
        const fillDim = 0.34 * Math.max(0.05, Math.min(1, daylight)), lineDim = Math.min(1, 0.95 / exposure);
        if (Math.abs(fillDim - lastDim) > 0.004) {
          lastDim = fillDim;
          lobes.forEach((l, i) => { (l.fill.material as THREE.MeshBasicMaterial).color.setHex(BANDS[i].color).multiplyScalar(fillDim); (l.edge.material as THREE.LineBasicMaterial).color.setHex(BANDS[i].color).multiplyScalar(lineDim); });
          for (const m of [future.material, past.material]) (m as LineMaterial).color.setScalar(lineDim);
          (ticks.material as THREE.PointsMaterial).color.setScalar(lineDim); (eye.material as THREE.PointsMaterial).color.setScalar(lineDim);
        }
      }
      const hpx = world.canvas.clientHeight || 900, k = 2 * Math.tan((world.camera.fov * DEG) / 2) / hpx, hLabel = 62;
      label.scale.set(hLabel * (lc.width / lc.height) * k, hLabel * k, 1);
    },
    dispose() {
      stop(); clear();
      world.scene.remove(group);
      group.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      ltex.dispose();
    },
    ...({ debug: () => ({ storm: storm?.id ?? null, info: replayInfo.value }) } as object),
  };
};
