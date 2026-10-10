// Boot: scene first (something to look at), then the store, then the UI and the feeds.
import * as S from './core/state';
import { effect } from '@preact/signals';
import { dataUrl, flag, params } from './core/config';
import { createEngine } from './world/engine';
import { createTerrain } from './world/terrain/index';
import { createControls } from './world/controls';
import { createPost } from './world/post/index';
import { createStore } from './ontology/index.ts';
import type { Ontology } from './ontology/types';
import ontologyJson from './ontology/ontology.json';
import { startFeeds } from './feeds/index';
import { mountUI } from './ui/index';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const bootEl = document.getElementById('boot')!;
const stageEl = document.getElementById('boot-stage')!;
const stage = (s: string) => { S.bootStage.value = s; stageEl.textContent = s; };
const ontology = ontologyJson as unknown as Ontology;

S.fixturesMode.value = flag('fixtures');
const q = params.get('q');
if (q === 'low' || q === 'medium' || q === 'high') S.quality.value = q;
const t = params.get('t');
if (t && !Number.isNaN(Date.parse(t))) { S.clockMode.value = 'manual'; S.sceneTime.value = Date.parse(t); }
if (params.has('sea')) S.scenario.value = { ...S.scenario.value, seaLevelM: +params.get('sea')!, label: 'manual' };
if (params.get('lang') === 'es') S.lang.value = 'es';

const g: any = ((globalThis as any).__garita = { ready: false, state: S });

// ---- scene ----
stage('Raising the island');
const engine = createEngine(canvas, { terrain: createTerrain, controls: createControls, post: createPost });
const world = engine.world;
g.world = world; g.engine = engine;
g.debug = () => ({ stats: S.stats.value, view: S.cameraView.value, terrain: world.terrain.stats(), post: (world.post as any).debug?.(), store: g.dbInfo, feeds: g.feeds?.status.value });
const cam = params.get('cam')?.split(',').map(Number);
if (cam && cam.length >= 2 && cam.every(Number.isFinite)) S.flyTo.value = { lon: cam[0], lat: cam[1], range: cam[2], heading: cam[3], pitch: cam[4], seconds: 0 };
engine.start();

let settled = 0;
const off = engine.onFrame((f) => {
  const s = world.terrain.stats();
  settled = s.pending === 0 && s.tiles > 0 ? settled + 1 : 0;
  if ((settled > 10 && f.index > 20) || f.now > 40) { off(); g.ready = true; S.booted.value = true; bootEl.classList.add('gone'); }
});

// ---- store, UI, feeds ----
(async () => {
  stage('Opening the database');
  const manifest = await fetch(dataUrl('data/manifest.json'), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const store = createStore({ ontology, seedUrl: dataUrl('data/twin.db'), seedVersion: manifest?.seedVersion ?? ontology.version });
  S.store.value = store;
  g.store = store;
  mountUI(document.getElementById('ui')!, { store });
  try {
    g.dbInfo = await store.ready;
  } catch (e) {
    console.error('[garita] the store failed to open', e);
    stage('Database unavailable');
    return;
  }
  g.layers?.forEach((fn: (s: typeof store) => void) => fn(store));
  if (!flag('nofeeds')) g.feeds = startFeeds(store, { fixtures: S.fixturesMode.value });

  // "Fly to this object": resolve its position through the store.
  effect(() => {
    const id = S.pendingFlyToObject.value;
    if (!id) return;
    S.pendingFlyToObject.value = null;
    store.getObject(id).then((o) => {
      if (!o || o.lon == null || o.lat == null) return;
      const range = ({ municipio: 38000, barrio: 9000, tract: 6000, power_region: 90000, forecast_zone: 70000, tropical_cyclone: 600000, earthquake: 60000, weather_alert: 80000 } as Record<string, number>)[o.type] ?? 3500;
      S.flyTo.value = { lon: o.lon, lat: o.lat, range, pitch: 48 };
    });
  });
})();
