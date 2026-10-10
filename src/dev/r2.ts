// Test page for the post chain (sky, light, ocean, clouds, tone mapping).
//   ?terrain=real   real terrain + controls (default: the placeholder island)
//   ?cam=lon,lat,range,heading,pitch   ?t=<ISO time>   ?sea=<m>   ?wind=<m/s>   ?cloud=<0..1>   ?q=low|medium|high
//   ?post=basic  ?clouds=0  ?ocean=0  ?aerial=0  ?tm=aces|neutral  ?units=<k>  ?deep=<gain>
import * as S from '../core/state';
import { params, flag } from '../core/config';
import { lonLatToXZ, curveDrop } from '../core/geo.ts';
import { createEngine, type EngineParts } from '../world/engine';
import { createPost } from '../world/post/index';

const g = globalThis as any;
g.__garita = { ready: false, debug: () => ({ booting: true }), state: S };

async function main() {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const parts: EngineParts = { post: createPost };
  const notes: string[] = [];
  if (params.get('terrain') === 'real') {
    try {
      const t: any = await import('../world/terrain/index');
      const c: any = await import('../world/controls');
      const mkT = t.createTerrain ?? t.default, mkC = c.createControls ?? c.default;
      if (mkT) parts.terrain = mkT; else notes.push('terrain module has no createTerrain');
      if (mkC) parts.controls = mkC; else notes.push('controls module has no createControls');
    } catch (e) { notes.push('real terrain unavailable: ' + String(e).slice(0, 160)); console.warn('[r2] real terrain unavailable, using the placeholder', e); }
  }
  const t = params.get('t');
  if (t && !Number.isNaN(Date.parse(t))) { S.clockMode.value = 'manual'; S.sceneTime.value = Date.parse(t); }
  const q = params.get('q');
  if (q === 'low' || q === 'medium' || q === 'high') S.quality.value = q;
  const wx = { ...S.weather.value };
  if (params.has('wind')) wx.windMs = +params.get('wind')!;
  if (params.has('cloud')) wx.cloudCover = +params.get('cloud')!;
  if (params.has('wave')) wx.waveHeightM = +params.get('wave')!;
  S.weather.value = wx;
  if (params.has('sea')) S.scenario.value = { ...S.scenario.value, seaLevelM: +params.get('sea')!, label: 'manual' };

  if (flag('layers')) {   // the integrated scene (real terrain, controls, store) with the buildings layer: ?pump, ?t, ?cam, ?q are the app's
    canvas.id = 'scene';
    const [{ bootApp }, { createBuildings }, { createOverlays }] = await Promise.all([import('../app'), import('../world/buildings/index'), import('../world/overlays')]);
    const booted = bootApp({ layers: params.has('overlay') ? [createOverlays, createBuildings] : [createBuildings] });   // ?overlay=radar|goes|... as in the app
    let n = 0, a = 0, m = 0;
    booted.engine.onFrame((f) => {
      n++; a += f.dt; if (a > 1) { m = (a / n) * 1000; a = 0; n = 0; }
      const d = (booted.world.post as any).debug?.();
      if (f.index % 30 === 0) document.getElementById('hud')!.textContent = `${d?.mode ?? '?'}  ${m.toFixed(1)} ms  sun ${d?.elevation?.toFixed(1)} deg  exp ${d?.exposure?.toFixed(2)}  shadows ${d?.shadows ? d.shadowExtent.toFixed(0) : 'off'}`;
    });
    return;
  }
  if (flag('pump')) {   // frames from a MessageChannel: the scene keeps rendering in a hidden tab (as in app.ts)
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
  const engine = createEngine(canvas, parts);
  const world = engine.world;
  const cam = params.get('cam')?.split(',').map(Number);
  if (cam && cam.length >= 2 && cam.every((v) => Number.isFinite(v))) {
    const [lon, lat, range, heading, pitch] = cam;
    const [x, z] = lonLatToXZ(lon, lat);
    world.controls.target.set(x, -curveDrop(x, z), z);     // the placeholder controls only take range / heading / pitch
    world.controls.flyTo({ lon, lat, range, heading, pitch, seconds: 0 });
  }
  let frames = 0, acc = 0, ms = 0;
  engine.onFrame((f) => {
    frames++; acc += f.dt;
    if (acc > 1) { ms = (acc / frames) * 1000; acc = 0; frames = 0; }
    const d = (world.post as any).debug?.();
    if (!g.__garita.ready && f.index > 3 && d && (d.mode === 'takram' || !('lutsReady' in d) || params.get('post') === 'basic' || params.get('aerial') === '0' || f.now > 60)) g.__garita.ready = true;
    if (f.index % 30 === 0) document.getElementById('hud')!.textContent = `${d?.mode ?? '?'}  ${ms.toFixed(1)} ms  sun ${d?.elevation?.toFixed(1)} deg  ${notes.join(' | ')}`;
  });
  g.__garita = {
    ready: false, world, state: S, engine,
    debug: () => ({ ...(world.post as any).debug?.(), frameMs: +ms.toFixed(2), stats: S.stats.value, view: world.controls.view(), seaLevel: world.seaLevel, notes }),
  };
  engine.start();
}
main().catch((e) => { console.error('[r2] failed to start', e); g.__garita.ready = true; g.__garita.debug = () => ({ error: String(e) }); });
