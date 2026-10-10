// Test page for the terrain and the camera controls (placeholder sky/post).
//   ?cam=lon,lat,range,heading,pitch   ?wire=1   ?lod=1   ?q=low|medium|high   ?selftest=1   ?sun=az,el
import * as S from '../core/state';
import { params, flag } from '../core/config';
import { createEngine } from '../world/engine';
import { createTerrain } from '../world/terrain/index';
import { createControls } from '../world/controls';
import fixtureUrl from '../../tests/fixtures/terrarium_12.png?url';

const q = params.get('q');
if (q === 'low' || q === 'medium' || q === 'high') S.quality.value = q;
// ?pump=1: drive frames from a MessageChannel instead of requestAnimationFrame, so the page keeps rendering in a
// hidden or background tab (testing only: it spins the CPU).
if (flag('pump')) {
  const ch = new MessageChannel(); let queue: FrameRequestCallback[] = [], last = 0, armed = false;
  ch.port1.onmessage = () => {
    const now = performance.now();
    if (now - last < 15.5) { ch.port2.postMessage(0); return; }
    last = now; armed = false;
    const run = queue; queue = [];
    for (const f of run) { try { f(now); } catch (e) { console.error(e); } }
  };
  (globalThis as any).requestAnimationFrame = (f: FrameRequestCallback) => { queue.push(f); if (!armed) { armed = true; ch.port2.postMessage(0); } return 1; };
}
const tParam = params.get('t');
if (tParam && !Number.isNaN(Date.parse(tParam))) { S.clockMode.value = 'manual'; S.sceneTime.value = Date.parse(tParam); }
if (params.has('sea')) S.scenario.value = { ...S.scenario.value, seaLevelM: +params.get('sea')!, label: 'manual' };
// ?pad=left,right,top,bottom stands in for the UI panels (CSS px).
const pad = params.get('pad')?.split(',').map(Number);
if (pad && pad.length === 4 && pad.every(Number.isFinite)) S.viewPadding.value = { left: pad[0], right: pad[1], top: pad[2], bottom: pad[3] };
const canvas = document.getElementById('scene') as HTMLCanvasElement;
// ?post=real: the real sky, sea and tone mapping instead of the placeholder.
const parts: any = { terrain: createTerrain, controls: createControls };
if (params.get('post') === 'real') parts.post = (await import('../world/post/index')).createPost;
const engine = createEngine(canvas, parts);
const { world } = engine;
const g: any = ((globalThis as any).__garita = {
  ready: false, world,
  debug: () => ({ stats: S.stats.value, view: world.controls.view(), terrain: world.terrain.stats(), selftest: g.selftest }),
});
if (params.has('night')) engine.onFrame(() => { world.night = +params.get('night')!; });
if (params.get('tint') === 'elevation') world.terrain.setTint?.('elevation');
// ?ov=test: a drawn, above-water overlay (magenta discs) to check OverlaySource.draw and the alpha contract.
if (params.get('ov') === 'test') world.terrain.setOverlay({
  id: 'test', url: () => null, minZoom: 3, maxZoom: 9, aboveWater: true,
  draw: (z, x, y) => {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const k = c.getContext('2d')!;
    k.fillStyle = 'rgba(255,0,200,0.7)'; k.beginPath(); k.arc(128, 128, 90, 0, 7); k.fill();
    k.fillStyle = '#fff'; k.font = '28px sans-serif'; k.fillText(`${z}/${x}/${y}`, 60, 136);
    return c;
  },
}, 0.8);
const fly = params.get('fly')?.split(',').map(Number);
if (fly && fly.length >= 2) setTimeout(() => { S.flyTo.value = { lon: fly[0], lat: fly[1], range: fly[2] || undefined, heading: fly[3], pitch: fly[4], seconds: fly[5] || undefined }; }, 1500);
const sun = params.get('sun');
if (sun) { const [az, el] = sun.split(',').map(Number), a = az * Math.PI / 180, e = el * Math.PI / 180; engine.onFrame(() => world.sunDir.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e))); }

// Ready when the opening view has nothing left to load (or after 30 s).
const t0 = performance.now(); let quiet = 0;
const hud = document.getElementById('hud')!;
engine.onFrame((f) => {
  const s = world.terrain.stats();
  quiet = s.pending === 0 && s.tiles > 0 ? quiet + 1 : 0;
  if (!g.ready && (quiet > 3 || performance.now() - t0 > 30000)) g.ready = true;
  if (f.index % 15 === 0) {
    const v = world.controls.view(), st = S.stats.value;
    hud.textContent = `${st.fps} fps  tiles ${s.tiles}  pending ${s.pending}  z${s.maxZoom}  calls ${st.drawCalls}  tris ${(st.tris / 1e6).toFixed(2)}M\n${v.lon.toFixed(4)}, ${v.lat.toFixed(4)}  range ${Math.round(v.range)} m  hdg ${v.heading.toFixed(0)}  pitch ${v.pitch.toFixed(0)}`;
  }
});
engine.start();

// Decode proof: the worker path must give the same heights as decoding the PNG bytes in Node
// (tests/fixtures/terrarium_12.png: sum of heights*256 = 89602913, min -14, max 79.59765625).
if (flag('selftest')) {
  const want = { w: 256, sum: 89602913, min: -14, max: 79.59765625, samples: [0, 0, 15.4375, 4.92578125, 28.45703125] };
  (world.terrain as any).decodeTest(fixtureUrl).then((r: any) => {
    const ok = r.w === want.w && r.sum === want.sum && r.min === want.min && r.max === want.max && want.samples.every((v, i) => r.samples[i] === v);
    g.selftest = { ok, got: r, want };
    console.log('[r1] terrarium decode self-test', ok ? 'EXACT' : 'MISMATCH', JSON.stringify(r));
  });
}
