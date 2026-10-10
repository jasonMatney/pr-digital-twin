// DEV ONLY: mounts the operations UI over a stand-in for the scene, on the fixture-backed mock store.
// Screenshot hooks: __garita.S (core state signals), __garita.ui (UI chrome signals), __garita.store.
import * as S from '../core/state';
import { mountUI } from '../ui/index';
import * as ui from '../ui/uistate';
import { createMockStore, recordedWind } from './mock-store';
import { dataUrl } from '../core/config';
import ontologyJson from '../ontology/ontology.json';
import type { Ontology, TwinStore } from '../ontology/types';

// ?seed=1: the real worker store over the published seed database (no feeds, no 3D) — for checking panels that need
// real links, coordinates and SQL. Default: the fixture-backed mock.
const useSeed = new URLSearchParams(location.search).has('seed');
const store: TwinStore = useSeed
  ? (await import('../ontology/index.ts')).createStore({ ontology: ontologyJson as unknown as Ontology, seedUrl: dataUrl('data/twin.db'), seedVersion: 'ui-dev' })
  : createMockStore();
if (useSeed) await store.ready;
S.store.value = store;
S.fixturesMode.value = true;

const wind = recordedWind();
if (wind && !useSeed) S.weather.value = { ...S.weather.value, ...wind, source: 'live' };

// Stand-in for the engine's clock (world/engine.ts does this every frame in the real app).
let last = performance.now();
setInterval(() => {
  const now = performance.now(), dt = (now - last) / 1000; last = now;
  if (S.clockMode.value === 'live') S.sceneTime.value = Date.now();
  else if (S.playbackRate.value) S.sceneTime.value += dt * 1000 * S.playbackRate.value;
}, 200);
// Stand-in for the scene's pointer readout so the bottom bar can be checked: follows the mouse over a fake extent.
const stage = document.getElementById('scene-standin');
stage?.addEventListener('pointermove', (e) => {
  const r = stage.getBoundingClientRect();
  S.cursorGeo.value = { lon: -67.4 + ((e.clientX - r.left) / r.width) * 2.2, lat: 18.75 - ((e.clientY - r.top) / r.height) * 1.1, elev: NaN };
});

// Recorded San Juan water level, so the dev page never shows the default 0 as if it were a reading.
if (!useSeed) store.getObject('tide_station:9755371').then((o) => { const v = o?.props?.water_level_m; if (typeof v === 'number') S.weather.value = { ...S.weather.value, tideM: v }; });

const unmount = mountUI(document.getElementById('ui')!, { store });
S.booted.value = true;
(globalThis as any).__garita = { ready: true, debug: () => ({ selected: S.selectedId.value, panel: S.rightPanel.value, narrow: ui.narrow.value }), S, ui, store, unmount };
