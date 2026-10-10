// Boot: scene first (something to look at), then the store, then feeds and UI.
import * as S from './core/state';
import { flag } from './core/config';
import { createEngine } from './world/engine';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const bootEl = document.getElementById('boot')!;
const stageEl = document.getElementById('boot-stage')!;
const stage = (s: string) => { S.bootStage.value = s; stageEl.textContent = s; };

S.fixturesMode.value = flag('fixtures');
const g: any = ((globalThis as any).__garita = { ready: false, state: S });

stage('Raising the island');
const engine = createEngine(canvas);
g.world = engine.world;
g.debug = () => ({ stats: S.stats.value, view: S.cameraView.value, terrain: engine.world.terrain.stats() });
engine.start();

// The scene is "ready" once the first frames are out and the terrain has stopped loading its first tiles.
let settled = 0;
const off = engine.onFrame((f) => {
  const t = engine.world.terrain.stats();
  settled = t.pending === 0 ? settled + 1 : 0;
  if ((settled > 20 && f.index > 30) || f.now > 45) {
    off(); g.ready = true; S.booted.value = true; bootEl.classList.add('gone');
  }
});
