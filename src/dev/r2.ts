// Test page for the post chain (sky, light, ocean, clouds, tone mapping).
//   ?terrain=real   real terrain + controls (default: the placeholder island)
//   ?cam=lon,lat,range,heading,pitch   ?t=<ISO time>   ?sea=<m>   ?wind=<m/s>   ?cloud=<0..1>   ?q=low|medium|high
//   ?post=basic  ?clouds=0  ?ocean=0  ?aerial=0  ?tm=aces|neutral  ?units=<k>  ?deep=<gain>
import * as S from '../core/state';
import { params } from '../core/config';
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
