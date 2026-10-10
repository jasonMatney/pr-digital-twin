// Replay of a historical storm (S.replayStormId) at the scene clock: the best track, the eye, and the wind radii as
// the four-lobed footprint the best track records. Everything drawn here is the historical record (NOAA HURDAT2),
// not a simulation. Live cyclones are drawn by the markers layer.
import * as THREE from 'three';
import { effect, signal } from '@preact/signals';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import * as S from '../core/state';
import { AST_OFFSET_H, DEG, ORIGIN, curveDrop, haversineKm, lonLatToXZ } from '../core/geo.ts';
import { bearingDeg, loadStorms, saffirSimpson, stormAt, windBandAt, type Storm, type StormPoint } from '../core/storms.ts';
import type { TwinStore } from '../ontology/types';
import type { World } from './types';
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
/** Legend of the replayed storm, for the UI (the raster overlay keeps S.overlayLegend). null when no storm is replayed. */
export const stormLegend = signal<S.Legend | null>(null);

const SOURCE = 'Best track (HURDAT2), NOAA National Hurricane Center';
const ALT = 350;                                            // metres above the sea: clear of the swell, still reads as "on the map"
const BANDS = [{ kt: 34 as const, color: 0xffd84d, css: '#ffd84d', a: 0.34 }, { kt: 50 as const, color: 0xff9a3d, css: '#ff9a3d', a: 0.42 }, { kt: 64 as const, color: 0xff3b3b, css: '#ff3b3b', a: 0.44 }];
/** Saffir-Simpson colour convention used on NHC-style track maps: depression, storm, categories 1 to 5. */
export const SS_COLORS = ['#5ebaff', '#00faf4', '#ffffcc', '#ffe775', '#ffc140', '#ff8f20', '#ff6060'];
const ssColor = (kt: number) => SS_COLORS[saffirSimpson(kt).cat + 1];
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
  const dot = document.createElement('canvas'); dot.width = dot.height = 32;
  { const g = dot.getContext('2d')!; g.fillStyle = '#fff'; g.beginPath(); g.arc(16, 16, 13, 0, 7); g.fill(); g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.stroke(); }
  const dotTex = new THREE.CanvasTexture(dot);
  const ticks = onLayer(new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 9, map: dotTex, vertexColors: true, sizeAttenuation: false, transparent: true, alphaTest: 0.05, depthTest: false, depthWrite: false })), 42);
  let tickFix: { t: number; kt: number }[] = [];
  const lobes = BANDS.map((b, i) => ({
    fill: onLayer(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: b.color, transparent: true, opacity: 1, vertexColors: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false })), 30 + i),
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

  let lastDim = -1, liveDim = 1;
  const live = createLive(world, store, res);
  let storm: Storm | null = null, seq = 0, lastKey = '', lastHi = '', wroteHi = false, myLegend: S.Legend | null = null;
  let munis: { id: string; lon: number; lat: number }[] = [];
  // Interior points from the store; the Census interior points in the boundary file stand in until it answers.
  loadMunicipios().then((l) => { if (!munis.length) munis = l.map((m) => ({ id: 'municipio:' + m.geoid, lon: m.lon, lat: m.lat })); }).catch(() => {});
  store.listObjects('municipio', { limit: 100, props: [] }).then((rows) => { const ok = rows.filter((r) => r.lon != null && r.lat != null); if (ok.length) munis = ok.map((r) => ({ id: r.id, lon: r.lon!, lat: r.lat! })); }).catch(() => {});

  function buildTrack(s: Storm) {
    const a: number[] = [], tk: number[] = [];
    tickFix = [];
    for (const p of s.points) { at(p.lon, p.lat, ALT, a); if (p.t % 21600000 === 0) { at(p.lon, p.lat, ALT, tk); tickFix.push({ t: p.t, kt: p.wind_kt }); } }
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
  /** Past 6-hourly positions in the Saffir-Simpson colour of their intensity; the ones still to come are dimmed. */
  function colorTicks(t: number) {
    const c = new Float32Array(tickFix.length * 3), k = new THREE.Color();
    tickFix.forEach((f, i) => { k.set(ssColor(f.kt)); if (f.t > t) k.multiplyScalar(0.3); c[i * 3] = k.r; c[i * 3 + 1] = k.g; c[i * 3 + 2] = k.b; });
    ticks.geometry.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  /** One wind threshold as a ring: four quarter-circles, each with the radius the best track gives for that quadrant,
   *  reaching inward to the next threshold (or the eye). Strongest at its outer edge, fading inward, so the land and
   *  the stronger rings inside stay readable. */
  function buildLobe(i: number, p: StormPoint) {
    const radii = (k: number) => (k === 0 ? p.r34 : k === 1 ? p.r50 : p.r64);
    const r = radii(i), inner = i < 2 ? radii(i + 1) : null, { fill, edge } = lobes[i];
    const show = !!r && r.some((v) => v > 0);
    fill.visible = edge.visible = show;
    if (!show) return;
    const [ex, ez] = lonLatToXZ(p.lon, p.lat), h = ALT - 60 + i * 20, aOut = BANDS[i].a, aIn = aOut * 0.12;
    const rim: number[] = [], pos: number[] = [], col: number[] = [];
    const put = (x: number, z: number, a: number) => { pos.push(x, h - curveDrop(x, z), z); col.push(1, 1, 1, a); };
    for (let q = 0; q < 4; q++) {
      const rad = (r![q] ?? 0) * 1852, rin = Math.min(rad, Math.max(0, inner?.[q] ?? 0) * 1852);
      for (let d = 0; d <= 90; d += 5) {
        const b = (q * 90 + d) * DEG, sn = Math.sin(b), cs = Math.cos(b);
        const x = ex + rad * sn, z = ez - rad * cs;
        rim.push(x, h - curveDrop(x, z), z);
        if (d === 90 || rad <= 0) continue;
        const b2 = (q * 90 + d + 5) * DEG, sn2 = Math.sin(b2), cs2 = Math.cos(b2);
        put(ex + rin * sn, ez - rin * cs, aIn); put(ex + rad * sn, ez - rad * cs, aOut); put(ex + rad * sn2, ez - rad * cs2, aOut);
        put(ex + rin * sn, ez - rin * cs, aIn); put(ex + rad * sn2, ez - rad * cs2, aOut); put(ex + rin * sn2, ez - rin * cs2, aIn);
      }
    }
    fill.geometry.dispose(); fill.geometry = new THREE.BufferGeometry();
    fill.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); fill.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    edge.geometry.dispose(); edge.geometry = new THREE.BufferGeometry(); edge.geometry.setAttribute('position', new THREE.Float32BufferAttribute(rim, 3));
  }
  function setHighlights(ids: string[]) {
    const key = ids.join(',');
    if (key === lastHi) return;
    lastHi = key;
    if (ids.length || wroteHi) { S.highlightIds.value = ids; wroteHi = ids.length > 0; }
  }
  function legend(s: Storm, hasRadii: boolean) {
    const es = S.lang.peek() === 'es', want = `${s.id}/${hasRadii}/${es}`;
    if (myLegend && (myLegend as any).key === want) return;
    const cats = es ? ['Depresión', 'Tormenta', 'Cat. 1', 'Cat. 2', 'Cat. 3', 'Cat. 4', 'Cat. 5'] : ['Depression', 'Storm', 'Cat 1', 'Cat 2', 'Cat 3', 'Cat 4', 'Cat 5'];
    myLegend = {
      title: `${s.name} ${s.year} · ${es ? 'Mejor trayectoria (HURDAT2)' : 'Best track (HURDAT2)'}`, unit: 'kt',
      stops: [
        ...(hasRadii ? BANDS.map((b) => ({ color: b.css, label: b.kt === 64 ? (es ? 'Viento ≥ 64 kt (fuerza de huracán)' : 'Wind ≥ 64 kt (hurricane force)') : b.kt === 50 ? (es ? 'Viento ≥ 50 kt' : 'Wind ≥ 50 kt') : (es ? 'Viento ≥ 34 kt (fuerza de tormenta tropical)' : 'Wind ≥ 34 kt (tropical storm force)') })) : []),
        ...SS_COLORS.map((color, i) => ({ color, label: `${es ? 'Posición cada 6 h' : '6-hourly position'}: ${cats[i]}` })),
      ],
      note: hasRadii
        ? (es ? 'Extensión máxima del viento sostenido por cuadrante (NE, SE, SO, NO), interpolada entre posiciones de 6 horas. Registro histórico, no una simulación.' : 'Greatest extent of sustained wind in each quadrant (NE, SE, SW, NW), interpolated between 6-hourly fixes. The historical record, not a simulation.')
        : (es ? 'HURDAT2 no registra radios de viento antes de 2004: solo se muestra la trayectoria y la intensidad.' : 'HURDAT2 holds no wind radii before 2004: only the track and the intensity are shown.'),
      source: SOURCE,
    };
    (myLegend as any).key = want;
    stormLegend.value = myLegend;
  }
  function clear() {
    group.visible = false; storm = null; lastKey = '';
    setHighlights([]);
    myLegend = null; stormLegend.value = null;
    replayInfo.value = null;
  }
  function refresh() {
    const s = storm;
    if (!s) return;
    const t = S.sceneTime.value, key = `${s.id}/${Math.round(t / 30000)}/${munis.length}`;
    if (key === lastKey) { legend(s, s.points.some((p) => p.r34)); return; }
    lastKey = key;
    const p = stormAt(s, t), hasRadii = s.points.some((q) => q.r34);
    buildPast(s, p, t); colorTicks(t);
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
      world.renderer.getDrawingBufferSize(res);
      live.update(liveDim);
      if (!storm) {
        if (f.index % 20 === 0) { const d = (world.post as any).debug?.() ?? {}; liveDim = Math.min(1, 0.95 / (typeof d.exposure === 'number' && d.exposure > 0 ? d.exposure : 1)); }
        return;
      }
      refresh();
      // Unlit colours ignore the sun and are multiplied by the exposure like everything else: the fills follow the
      // daylight so they tint the scene instead of glaring over it, the lines hold a steady brightness on screen.
      if (f.index % 20 === 0 || lastDim < 0) {
        const d = (world.post as any).debug?.() ?? {};
        const daylight = typeof d.daylight === 'number' ? d.daylight : 1 - world.night, exposure = typeof d.exposure === 'number' && d.exposure > 0 ? d.exposure : 1;
        const fillDim = 0.36 * Math.max(0.06, Math.min(1, daylight)), lineDim = Math.min(1, 0.95 / exposure);
        // the wind rings' outlines follow the scene light (down to 40 % of their daytime brightness on screen): at
        // steady brightness the 64 kt ring was the heaviest thing in a dark frame before dawn
        const ringDim = lineDim * (0.4 + 0.6 * Math.max(0, Math.min(1, daylight)));
        liveDim = lineDim;
        if (Math.abs(fillDim + ringDim * 7 + lineDim * 13 - lastDim) > 0.004) {
          lastDim = fillDim + ringDim * 7 + lineDim * 13;
          lobes.forEach((l, i) => { (l.fill.material as THREE.MeshBasicMaterial).color.setHex(BANDS[i].color).multiplyScalar(fillDim); (l.edge.material as THREE.LineBasicMaterial).color.setHex(BANDS[i].color).multiplyScalar(ringDim); });
          for (const m of [future.material, past.material]) (m as LineMaterial).color.setScalar(lineDim);
          (ticks.material as THREE.PointsMaterial).color.setScalar(lineDim); (eye.material as THREE.PointsMaterial).color.setScalar(lineDim);
        }
      }
      const hpx = world.canvas.clientHeight || 900, k = 2 * Math.tan((world.camera.fov * DEG) / 2) / hpx, hLabel = 62;
      label.scale.set(hLabel * (lc.width / lc.height) * k, hLabel * k, 1);
    },
    dispose() {
      stop(); clear(); live.dispose(); dotTex.dispose();
      world.scene.remove(group);
      group.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      ltex.dispose();
    },
    ...({ debug: () => ({ storm: storm?.id ?? null, info: replayInfo.value, legend: stormLegend.value && { title: stormLegend.value.title, stops: stormLegend.value.stops.length }, live: liveCyclones.value, highlights: S.highlightIds.value.length }) } as object),
  };
};

// ---- live cyclones: the NHC forecast (cone and track). Cyan and dotted, so it is never taken for the replay ----
export interface LiveCycloneInfo {
  id: string; name: string; category: string; wind_kt: number | null;
  /** From the centre of the island to the storm centre. */
  distance_km: number; bearing: string;
  advisory: string | null; hasCone: boolean; points: number;
  /** Cone and track are drawn (within 3,000 km and the store or the feed has them). */
  drawn: boolean;
  /** "Isaias · Cat 1 · 2,460 km NW" */
  text: string;
}
/** Active tropical cyclones known to the store, for the UI. */
export const liveCyclones = signal<LiveCycloneInfo[]>([]);
const LIVE = 0x7fe3ff, LIVE_ALT = 500, LIVE_RANGE_KM = 3000;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
interface ForecastPoint { t?: number; lat: number; lon: number; wind_kt?: number; gust_kt?: number; label?: string }

function textSprite(lines: string[], accent: string) {
  const c = document.createElement('canvas'), fonts = [`${lines.length > 1 ? 700 : 600} 28px system-ui, sans-serif`, '500 24px system-ui, sans-serif'];
  let g = c.getContext('2d')!, wide = 0;
  lines.forEach((l, i) => { g.font = fonts[i] ?? fonts[1]; wide = Math.max(wide, g.measureText(l).width); });
  c.width = Math.min(640, Math.ceil(wide) + 38); c.height = lines.length > 1 ? 112 : 60;      // sizing a canvas resets its context
  g = c.getContext('2d')!;
  g.fillStyle = 'rgba(5,15,21,0.8)'; g.beginPath(); g.roundRect(3, 3, c.width - 6, c.height - 6, 12); g.fill();
  g.strokeStyle = accent; g.lineWidth = 2; g.stroke();
  g.textBaseline = 'middle'; g.fillStyle = '#ffffff'; g.font = fonts[0]; g.fillText(lines[0], 18, 31, c.width - 36);
  if (lines[1]) { g.fillStyle = accent; g.font = fonts[1]; g.fillText(lines[1], 18, 78, c.width - 36); }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false }));
  sprite.center.set(0, -0.3);
  return { sprite, tex, aspect: c.width / c.height, px: lines.length > 1 ? 44 : 24 };
}

function createLive(world: World, store: TwinStore, res: THREE.Vector2) {
  const group = new THREE.Group(); group.name = 'cyclone-forecast';
  world.scene.add(group);
  const chips = document.createElement('div');
  chips.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:4';
  document.body.appendChild(chips);
  let items: { info: LiveCycloneInfo; lon: number; lat: number; chip: HTMLDivElement; arrow: HTMLSpanElement }[] = [];
  let sprites: { sprite: THREE.Sprite; aspect: number; px: number }[] = [], lines: LineMaterial[] = [], fills: THREE.MeshBasicMaterial[] = [], seq = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const add = <T extends THREE.Object3D>(o: T, order: number): T => { o.layers.set(OVER_WATER_LAYER); o.frustumCulled = false; o.renderOrder = order; group.add(o); return o; };
  const wipe = () => {
    group.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); o.material?.dispose?.(); });
    group.clear(); chips.replaceChildren(); sprites = []; lines = []; fills = []; items = [];
  };
  const lineMat = (width: number, opacity: number, dashed: boolean) => { const m = new LineMaterial({ color: LIVE, linewidth: width, transparent: true, opacity, depthTest: false, depthWrite: false, dashed, dashSize: 12000, gapSize: 9000 }); m.resolution = res; lines.push(m); return m; };
  const label = (linesTxt: string[], lon: number, lat: number, order: number) => { const t = textSprite(linesTxt, '#7fe3ff'); const a: number[] = []; at(lon, lat, LIVE_ALT, a); t.sprite.position.set(a[0], a[1], a[2]); add(t.sprite, order); sprites.push(t); };

  async function rebuild() {
    const my = ++seq;
    const rows = await store.listObjects('tropical_cyclone', { props: ['classification', 'intensity_kt', 'distance_to_pr_km', 'advisory', 'forecast_points'], limit: 30 }).catch(() => []);
    // Until the store carries the forecast, the feed may publish it as a signal keyed by object id or storm key.
    let fallback: any = null;
    try { const m: any = await import('../feeds/index'); fallback = m.cycloneForecasts?.value ?? null; } catch { /* no such export */ }
    const found: { row: (typeof rows)[number]; cone: any; pts: ForecastPoint[]; advisory: string | null; near: boolean }[] = [];
    for (const row of rows) {
      if (row.lon == null || row.lat == null) continue;
      const near = haversineKm(row.lon, row.lat, ORIGIN.lon, ORIGIN.lat) <= LIVE_RANGE_KM;
      const fb = fallback ? (fallback instanceof Map ? fallback.get(row.id) ?? fallback.get(row.key) : fallback[row.id] ?? fallback[row.key]) : null;
      let cone: any = null, pts: ForecastPoint[] = [];
      if (near) {
        const rec = await store.getObject(row.id).catch(() => null);
        cone = rec?.geometry ?? fb?.cone ?? fb?.geometry ?? null;
        const raw = row.props?.forecast_points ?? fb?.points ?? fb?.forecast_points;
        try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; if (Array.isArray(v)) pts = v.filter((q) => Number.isFinite(q?.lat) && Number.isFinite(q?.lon)); } catch { /* unreadable: no track */ }
      }
      const adv = row.props?.advisory ?? fb?.advisory;
      found.push({ row, cone, pts, advisory: adv != null && adv !== '' ? String(adv) : null, near });
    }
    if (my !== seq) return;
    wipe();
    const es = S.lang.peek() === 'es', infos: LiveCycloneInfo[] = [];
    for (const { row, cone, pts, advisory, near } of found) {
      const lon = row.lon!, lat = row.lat!, kt = typeof row.props?.intensity_kt === 'number' ? (row.props.intensity_kt as number) : null;
      const cls = typeof row.props?.classification === 'string' ? (row.props.classification as string) : '';
      const name = cls && row.name.startsWith(cls + ' ') ? row.name.slice(cls.length + 1) : row.name;
      const ss = kt != null ? saffirSimpson(kt) : null, category = ss ? (ss.cat >= 1 ? `Cat ${ss.cat}` : ss.cat === 0 ? (es ? 'Tormenta tropical' : 'Tropical storm') : (es ? 'Depresión tropical' : 'Tropical depression')) : cls;
      const km = typeof row.props?.distance_to_pr_km === 'number' ? (row.props.distance_to_pr_km as number) : Math.round(haversineKm(lon, lat, ORIGIN.lon, ORIGIN.lat));
      const bearing = COMPASS[Math.round(bearingDeg(ORIGIN.lon, ORIGIN.lat, lon, lat) / 45) % 8];
      const polys: number[][][][] = cone?.type === 'Polygon' ? [cone.coordinates] : cone?.type === 'MultiPolygon' ? cone.coordinates : [];
      const drawn = near && (polys.length > 0 || pts.length > 0);
      const text = `${name} · ${category} · ${km.toLocaleString(es ? 'es-PR' : 'en-US')} km ${bearing}`;
      const info: LiveCycloneInfo = { id: row.id, name, category, wind_kt: kt, distance_km: km, bearing, advisory, hasCone: polys.length > 0, points: pts.length, drawn, text };
      infos.push(info);
      const chip = document.createElement('div'), arrow = document.createElement('span');
      chip.style.cssText = 'position:absolute;display:none;transform:translate(-50%,-50%);padding:4px 10px 4px 8px;border-radius:999px;background:rgba(5,15,21,.84);border:1px solid rgba(127,227,255,.65);color:#e6f8ff;font:600 12px/1.3 system-ui,sans-serif;white-space:nowrap';
      arrow.textContent = '↑'; arrow.style.cssText = 'display:inline-block;margin-right:6px;color:#7fe3ff;font:800 13px/1 system-ui,sans-serif';
      chip.append(arrow, text); chips.appendChild(chip);
      items.push({ info, lon, lat, chip, arrow });
      if (!drawn) continue;
      for (const poly of polys) {
        const ring = poly[0].slice(0, poly[0].length > 3 && poly[0][0][0] === poly[0][poly[0].length - 1][0] && poly[0][0][1] === poly[0][poly[0].length - 1][1] ? -1 : undefined);
        if (ring.length < 3) continue;
        const flat: number[] = [], loop: number[] = [];
        for (const q of ring) at(q[0], q[1], LIVE_ALT - 40, flat);
        for (const q of [...ring, ring[0]]) at(q[0], q[1], LIVE_ALT - 40, loop);
        const tri = THREE.ShapeUtils.triangulateShape(ring.map((q) => new THREE.Vector2(q[0], q[1])), []);
        const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3)); geo.setIndex(tri.flat());
        const fm = new THREE.MeshBasicMaterial({ color: LIVE, transparent: true, opacity: 0.16, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false });
        fills.push(fm); add(new THREE.Mesh(geo, fm), 24);
        add(new Line2(new LineGeometry().setPositions(loop), lineMat(1.8, 0.9, false)), 25);
      }
      if (pts.length) {
        const a: number[] = [], pp: number[] = [], pc: number[] = [], k = new THREE.Color();
        at(lon, lat, LIVE_ALT, a);
        for (const q of pts) { at(q.lon, q.lat, LIVE_ALT, a); at(q.lon, q.lat, LIVE_ALT, pp); k.set(q.wind_kt != null ? ssColor(q.wind_kt) : '#ffffff'); pc.push(k.r, k.g, k.b); }
        const track = add(new Line2(new LineGeometry().setPositions(a), lineMat(2.2, 0.95, true)), 26);
        track.computeLineDistances();
        const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3)); pg.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
        add(new THREE.Points(pg, new THREE.PointsMaterial({ size: 9, vertexColors: true, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false })), 27);
        for (const q of pts) label([`${q.label ?? (q.t ? ast(q.t) : '')}${q.wind_kt != null ? ` · ${Math.round(q.wind_kt)} kt` : ''}`.replace(/^ · /, '')], q.lon, q.lat, 28);
      }
      label([`${name} · ${category}`, advisory ? (es ? `Pronóstico del NHC, aviso ${advisory}` : `NHC forecast, advisory ${advisory}`) : (es ? 'Pronóstico del NHC' : 'NHC forecast')], lon, lat, 29);
      (world.post as any).overWater = true;
    }
    liveCyclones.value = infos;
  }
  const kick = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { void rebuild().catch((e) => console.warn('[garita/storms] live cyclone forecast failed', e)); }, ms); };
  const off = store.onChange((e) => { if (e.types.includes('tropical_cyclone')) kick(600); });
  const stopLang = effect(() => { S.lang.value; kick(50); });
  const v = new THREE.Vector3();

  return {
    update(dim: number) {
      if (!items.length) return;
      for (const m of lines) m.color.setHex(LIVE).multiplyScalar(dim);
      for (const m of fills) m.color.setHex(LIVE).multiplyScalar(0.22 * dim);      // unlit: kept well under the sunlit scene so it tints, not paints
      const w = world.canvas.clientWidth || 1, h = world.canvas.clientHeight || 1, k = (2 * Math.tan((world.camera.fov * DEG) / 2)) / h;
      for (const s of sprites) s.sprite.scale.set(s.px * s.aspect * k, s.px * k, 1);
      const pad = S.viewPadding.peek(), tgt = world.controls.target, range = S.cameraView.peek().range;
      for (const it of items) {
        const [x, z] = lonLatToXZ(it.lon, it.lat);
        v.set(x, -curveDrop(x, z), z).applyMatrix4(world.camera.matrixWorldInverse);
        const behind = v.z > -1;
        let nx: number, ny: number;
        if (behind) { nx = v.x; ny = -Math.abs(v.z) - 1; const l = Math.hypot(nx, ny) || 1; nx = (nx / l) * 9; ny = (ny / l) * 9; }
        else { v.applyMatrix4(world.camera.projectionMatrix); nx = v.x; ny = v.y; }
        // In view and close enough to be drawn (not over the horizon): the scene shows it, no pointer needed.
        const far = Math.hypot(x - tgt.x, z - tgt.z) > Math.max(700000, range * 2.2), inside = !behind && Math.abs(nx) < 0.9 && Math.abs(ny) < 0.9;
        if (inside && !far) { it.chip.style.display = 'none'; continue; }
        const m = Math.max(Math.abs(nx), Math.abs(ny), 1e-6), sc = Math.min(1, 0.9 / m), ex = nx * sc, ey = ny * sc;
        it.chip.style.display = '';
        const half = (it.chip.offsetWidth || 240) / 2 + 8;                // keep the whole chip on screen and clear of the panels
        const x0 = pad.left + half, x1 = w - pad.right - half, y0 = pad.top + 24, y1 = h - pad.bottom - 24;
        const cx = Math.min(Math.max(x0, ((ex + 1) / 2) * w), Math.max(x0, x1)), cy = Math.min(Math.max(y0, ((1 - ey) / 2) * h), Math.max(y0, y1));
        it.chip.style.left = cx + 'px'; it.chip.style.top = cy + 'px';
        it.arrow.style.transform = `rotate(${(Math.atan2(nx, ny) / DEG).toFixed(0)}deg)`;
      }
    },
    dispose() { off(); stopLang(); if (timer) clearTimeout(timer); seq++; wipe(); world.scene.remove(group); chips.remove(); liveCyclones.value = []; },
  };
}
