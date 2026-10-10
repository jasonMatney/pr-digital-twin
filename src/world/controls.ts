// Globe-style camera: a ground target, range, heading and pitch. Grab-the-ground panning, orbit, zoom to cursor,
// touch gestures, keyboard, eased flights, deep links. Inputs move a goal state; the camera follows it with
// critically damped smoothing.
import * as THREE from 'three';
import { curveDrop, lonLatToXZ, xzToLonLat } from '../core/geo.ts';
import { params } from '../core/config';
import * as S from '../core/state';
import type { CameraView, FlyTo } from '../core/state';
import type { ControlsApi, Frame, World } from './types';

const MIN_RANGE = 120, MAX_RANGE = 1.5e6, MIN_PITCH = 8, MAX_PITCH = 90, CLEARANCE = 30;
const D2R = Math.PI / 180;
interface Pose { x: number; z: number; range: number; heading: number; pitch: number }

export function createControls(world: World): ControlsApi {
  const { camera, canvas, terrain } = world;
  const target = new THREE.Vector3();
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- the part of the canvas the panels leave free ----
  // The camera is slid sideways in its own image plane (no rotation) so the orbit target sits at the centre of the
  // uncovered area. The projection stays symmetric, which the sky and ocean passes rely on; an off-centre projection
  // (camera.setViewOffset) was tried and loses the ocean pass. Every ray is cast through the same placement, so
  // picking, panning and zoom-to-cursor stay exact.
  const pad = { l: 0, r: 0, t: 0, b: 0 };
  let padInit = false, voKey = '';
  const size = () => [canvas.clientWidth || innerWidth, Math.max(1, canvas.clientHeight || innerHeight)];
  function padTarget() {
    const p = S.viewPadding.value, [W, H] = size();
    let l = Math.max(0, p.left || 0), r = Math.max(0, p.right || 0), t = Math.max(0, p.top || 0), b = Math.max(0, p.bottom || 0);
    if (l + r > W * 0.7) { const k = W * 0.7 / (l + r); l *= k; r *= k; }
    if (t + b > H * 0.7) { const k = H * 0.7 / (t + b); t *= k; b *= k; }
    return { l, r, t, b };
  }
  function applyPadding(dt: number) {
    const q = padTarget(), [W, H] = size();
    const k = padInit && !reduced ? 1 - Math.exp(-dt * 9) : 1;
    padInit = true;
    for (const key of ['l', 'r', 't', 'b'] as const) { pad[key] += (q[key] - pad[key]) * k; if (Math.abs(q[key] - pad[key]) < 0.5) pad[key] = q[key]; }
    padDx = (pad.l - pad.r) / 2; padDy = (pad.t - pad.b) / 2; padH = H; void W; void voKey;
  }
  let padDx = 0, padDy = 0, padH = size()[1];

  // Opening view: the whole island (Culebra and Vieques included) composed in the uncovered area, north up.
  const HOME_PITCH = 50;
  function frameIsland(p: Pose) {
    const q = padTarget(), [W, H] = size();
    const tv = Math.tan(camera.fov * D2R / 2), th = tv * Math.max(120, W - q.l - q.r) / H, tu = tv * Math.max(120, H - q.t - q.b) / H;
    const pr = HOME_PITCH * D2R, halfW = 113000, halfN = 41000;
    const rH = halfW / th + halfN * Math.cos(pr), rV = halfN * Math.sin(pr) / tu + halfN * Math.cos(pr);
    const [x, z] = lonLatToXZ(-66.26, 18.2);
    p.x = x; p.z = z; p.heading = 0; p.pitch = HOME_PITCH;
    p.range = Math.min(MAX_RANGE, Math.max(140000, Math.max(rH, rV) * 1.05));
  }
  const goal: Pose = { x: 0, z: 0, range: 300000, heading: 0, pitch: HOME_PITCH };
  frameIsland(goal);
  let auto = true, autoKey = '';          // until the user moves, the opening view follows the canvas and the panels
  const cam = params.get('cam');
  if (cam) {
    const v = cam.split(',').map(Number);
    if (v.length >= 2 && v.every(Number.isFinite)) {
      const [x, z] = lonLatToXZ(v[0], v[1]);
      goal.x = x; goal.z = z; auto = false;
      if (v[2]) goal.range = v[2]; if (v[3] != null) goal.heading = v[3]; if (v[4] != null) goal.pitch = v[4];
    }
  }
  const clampPose = (p: Pose) => {
    p.range = Math.min(MAX_RANGE, Math.max(MIN_RANGE, p.range));
    p.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, p.pitch));
    p.x = Math.min(600000, Math.max(-600000, p.x)); p.z = Math.min(500000, Math.max(-500000, p.z));
  };
  clampPose(goal);
  const cur: Pose = { ...goal };
  let groundY = 0, groundInit = false;
  let flight: { from: Pose; to: Pose; t: number; dur: number; hop: number } | null = null;
  const vel = { x: 0, z: 0 };       // pan inertia, m/s
  let dragging = false;

  // ---- camera from a pose ----
  const tmpCam = new THREE.PerspectiveCamera();
  const tgt = new THREE.Vector3(), look = new THREE.Vector3(), ray = new THREE.Ray(), ndc = new THREE.Vector3();
  const groundAt = (x: number, z: number) => Math.max(terrain.heightAt(x, z) ?? 0, world.seaLevel);
  function place(c: THREE.PerspectiveCamera, p: Pose, gy: number) {
    const pr = p.pitch * D2R, hr = p.heading * D2R, horiz = Math.cos(pr) * p.range;
    tgt.set(p.x, gy - curveDrop(p.x, p.z), p.z);
    c.position.set(tgt.x - Math.sin(hr) * horiz, tgt.y + Math.sin(pr) * p.range, tgt.z + Math.cos(hr) * horiz);
    c.up.set(Math.sin(hr) * Math.sin(pr), Math.cos(pr), -Math.cos(hr) * Math.sin(pr));
    // Slide in the image plane: metres per CSS pixel at the target's depth.
    const k = 2 * p.range * Math.tan(camera.fov * D2R / 2) / padH, sr = -padDx * k, su = padDy * k;
    look.set(tgt.x + Math.cos(hr) * sr + c.up.x * su, tgt.y + c.up.y * su, tgt.z + Math.sin(hr) * sr + c.up.z * su);
    c.position.add(look).sub(tgt);
    c.lookAt(look);
  }
  /** Ray through a canvas pixel for a given pose (used to solve "keep this ground point under the cursor"). */
  function poseRay(p: Pose, sx: number, sy: number) {
    tmpCam.projectionMatrix.copy(camera.projectionMatrix); tmpCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    place(tmpCam, p, groundY);
    tmpCam.updateMatrixWorld();
    const r = canvas.getBoundingClientRect();
    ndc.set(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1, 0.5).unproject(tmpCam);
    ray.origin.copy(tmpCam.position);
    ray.direction.copy(ndc).sub(tmpCam.position).normalize();
    return ray;
  }
  /** Shifts the goal target so the world point `p` sits under screen pixel (sx, sy). */
  function anchor(p: THREE.Vector3, sx: number, sy: number): boolean {
    const r = poseRay(goal, sx, sy);
    if (r.direction.y > -0.015) return false;
    const t = (p.y - r.origin.y) / r.direction.y;
    if (!(t > 0)) return false;
    let dx = p.x - (r.origin.x + r.direction.x * t), dz = p.z - (r.origin.z + r.direction.z * t);
    const m = Math.hypot(dx, dz), lim = goal.range * 3;
    if (m > lim) { dx *= lim / m; dz *= lim / m; }
    goal.x += dx; goal.z += dz;
    return true;
  }
  function pick(sx: number, sy: number): THREE.Vector3 | null {
    const r = poseRay(cur, sx, sy);
    return terrain.raycast(r.origin, r.direction, 3e6);
  }
  const userInput = () => { flight = null; auto = false; };

  // ---- pointer ----
  const pts = new Map<number, { x: number; y: number }>();
  const grab = new THREE.Vector3();
  let mode: 'none' | 'pan' | 'orbit' | 'touch2' = 'none', hasGrab = false, lastX = 0, lastY = 0;
  let pinch = { dist: 0, ang: 0, cy: 0 };
  const two = () => { const [a, b] = [...pts.values()]; return { dist: Math.hypot(b.x - a.x, b.y - a.y), ang: Math.atan2(b.y - a.y, b.x - a.x), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; };
  const startPan = (x: number, y: number) => { const h = pick(x, y); hasGrab = !!h; if (h) grab.copy(h); mode = 'pan'; vel.x = vel.z = 0; };

  function onDown(e: PointerEvent) {
    if (!api.enabled) return;
    userInput();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capturable pointer */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastX = e.clientX; lastY = e.clientY; dragging = true;
    if (e.pointerType === 'touch') {
      if (pts.size === 1) startPan(e.clientX, e.clientY);
      else if (pts.size === 2) { mode = 'touch2'; const t = two(); pinch = { dist: t.dist, ang: t.ang, cy: t.cy }; }
    } else if (e.button === 2 || e.button === 1 || e.ctrlKey || e.shiftKey || e.metaKey) mode = 'orbit';
    else startPan(e.clientX, e.clientY);
  }
  function onMove(e: PointerEvent) {
    const p = pts.get(e.pointerId);
    if (!p || !api.enabled) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (mode === 'pan' && hasGrab) {
      const bx = goal.x, bz = goal.z;
      anchor(grab, e.clientX, e.clientY);
      const now = performance.now(), dt = Math.max(0.004, (now - lastMoveMs) / 1000);
      lastMoveMs = now;
      vel.x += ((goal.x - bx) / dt - vel.x) * 0.35; vel.z += ((goal.z - bz) / dt - vel.z) * 0.35;
    } else if (mode === 'orbit') {
      goal.heading -= dx * 0.25; goal.pitch += dy * 0.2;
    } else if (mode === 'touch2' && pts.size >= 2) {
      const t = two();
      if (pinch.dist > 0 && t.dist > 0) goal.range *= pinch.dist / t.dist;
      let da = t.ang - pinch.ang; if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
      goal.heading -= da / D2R;
      // Two fingers moving together vertically tilt; a pinch barely moves the centroid.
      const dcy = t.cy - pinch.cy;
      if (Math.abs(t.dist - pinch.dist) < Math.abs(dcy) * 1.5) goal.pitch += dcy * 0.25;
      pinch = { dist: t.dist, ang: t.ang, cy: t.cy };
    }
    clampPose(goal);
  }
  let lastMoveMs = 0;
  function onUp(e: PointerEvent) {
    pts.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (pts.size === 0) {
      if (mode !== 'pan' || performance.now() - lastMoveMs > 90) vel.x = vel.z = 0;
      mode = 'none'; dragging = false;
    } else if (pts.size === 1) { const p = [...pts.values()][0]; startPan(p.x, p.y); }
  }
  function onWheel(e: WheelEvent) {
    if (!api.enabled) return;
    e.preventDefault(); userInput();
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
    const d = Math.max(-240, Math.min(240, e.deltaY * unit));
    const f = Math.exp(d * (e.ctrlKey ? 0.012 : 0.0016));
    const p = pick(e.clientX, e.clientY);
    goal.range *= f; clampPose(goal);
    if (p) anchor(p, e.clientX, e.clientY);
    clampPose(goal); vel.x = vel.z = 0;
  }
  function onDbl(e: MouseEvent) {
    if (!api.enabled) return;
    const p = pick(e.clientX, e.clientY);
    if (!p) return;
    const [lon, lat] = xzToLonLat(p.x, p.z);
    api.flyTo({ lon, lat, range: Math.max(MIN_RANGE, goal.range / 2), seconds: 0.9 });
  }
  const keys = new Set<string>();
  function onKey(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.type === 'keydown') {
      if ('wasdqerf+-=_'.includes(k) || k.startsWith('Arrow')) { keys.add(k); userInput(); if (k.startsWith('Arrow')) e.preventDefault(); }
    } else keys.delete(k);
  }
  const onBlur = () => keys.clear();
  const noMenu = (e: Event) => e.preventDefault();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('contextmenu', noMenu);
  addEventListener('keydown', onKey); addEventListener('keyup', onKey); addEventListener('blur', onBlur);
  canvas.style.touchAction = 'none';

  // ---- deep link ----
  let linkAt = 0, lastLink = '';
  function writeLink(now: number) {
    if (now - linkAt < 0.6 || dragging || flight || auto) return;
    linkAt = now;
    const [lon, lat] = xzToLonLat(cur.x, cur.z);
    const s = `${lon.toFixed(5)},${lat.toFixed(5)},${Math.round(cur.range)},${(((cur.heading % 360) + 360) % 360).toFixed(1)},${cur.pitch.toFixed(1)}`;
    if (s === lastLink) return;
    lastLink = s;
    try {
      const u = new URL(location.href); u.searchParams.set('cam', s);
      history.replaceState(history.state, '', u.pathname + u.search.replace(/%2C/g, ',') + u.hash);
    } catch { /* sandboxed frames may refuse */ }
  }

  const ease = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const api: ControlsApi = {
    target, enabled: true,
    update(frame: Frame) {
      const dt = frame.dt;
      applyPadding(dt);
      if (auto) {
        const q = padTarget(), [W, H] = size(), key = `${W},${H},${q.l},${q.r},${q.t},${q.b}`;
        if (key !== autoKey) { const first = !autoKey; autoKey = key; frameIsland(goal); if (first || frame.now < 1.5) Object.assign(cur, goal); }
      }
      if (flight) {
        flight.t = Math.min(1, flight.t + dt / flight.dur);
        const e = ease(flight.t), a = flight.from, b = flight.to;
        cur.x = a.x + (b.x - a.x) * e; cur.z = a.z + (b.z - a.z) * e;
        cur.heading = a.heading + (b.heading - a.heading) * e; cur.pitch = a.pitch + (b.pitch - a.pitch) * e;
        // Zoom is interpolated in log space, with a hop when the ground distance is large against the range.
        const s = Math.sin(Math.PI * e);
        cur.range = Math.exp(Math.log(a.range) + (Math.log(b.range) - Math.log(a.range)) * e) + flight.hop * s * s;
        Object.assign(goal, cur);
        if (flight.t >= 1) { Object.assign(cur, b); Object.assign(goal, b); flight = null; }
      } else {
        if (keys.size) {
          const hr = goal.heading * D2R, sp = goal.range * 0.9 * dt;
          let f = 0, r = 0;
          if (keys.has('w') || keys.has('ArrowUp')) f += 1; if (keys.has('s') || keys.has('ArrowDown')) f -= 1;
          if (keys.has('d') || keys.has('ArrowRight')) r += 1; if (keys.has('a') || keys.has('ArrowLeft')) r -= 1;
          goal.x += (Math.sin(hr) * f + Math.cos(hr) * r) * sp; goal.z += (-Math.cos(hr) * f + Math.sin(hr) * r) * sp;
          if (keys.has('q')) goal.heading -= 70 * dt; if (keys.has('e')) goal.heading += 70 * dt;
          if (keys.has('r')) goal.pitch += 45 * dt; if (keys.has('f')) goal.pitch -= 45 * dt;
          if (keys.has('+') || keys.has('=')) goal.range *= Math.exp(-1.4 * dt); if (keys.has('-') || keys.has('_')) goal.range *= Math.exp(1.4 * dt);
        }
        if (mode === 'none' && (vel.x || vel.z)) {
          goal.x += vel.x * dt; goal.z += vel.z * dt;
          const k = Math.exp(-dt * 4.5); vel.x *= k; vel.z *= k;
          if (Math.hypot(vel.x, vel.z) < goal.range * 0.002) vel.x = vel.z = 0;
        }
        clampPose(goal);
        const k = reduced ? 1 : 1 - Math.exp(-dt * 14);
        cur.x += (goal.x - cur.x) * k; cur.z += (goal.z - cur.z) * k;
        cur.range = Math.exp(Math.log(cur.range) + (Math.log(goal.range) - Math.log(cur.range)) * k);
        cur.heading += (goal.heading - cur.heading) * k; cur.pitch += (goal.pitch - cur.pitch) * k;
      }
      // The target rides the ground; smoothed so refining tiles do not jolt the camera.
      const g = groundAt(cur.x, cur.z);
      if (!groundInit) { groundY = g; groundInit = true; } else groundY += (g - groundY) * (1 - Math.exp(-dt * 6));
      place(camera, cur, groundY);
      target.copy(tgt);
      const p = camera.position, floor = groundAt(p.x, p.z) - curveDrop(p.x, p.z) + CLEARANCE;
      if (p.y < floor) { p.y = floor; camera.lookAt(look); }
      writeLink(frame.now);
    },
    flyTo(v: FlyTo) {
      const [x, z] = lonLatToXZ(v.lon, v.lat);
      const to: Pose = { x, z, range: v.range ?? goal.range, heading: v.heading ?? goal.heading, pitch: v.pitch ?? goal.pitch };
      clampPose(to);
      const from: Pose = { ...cur };
      from.heading = ((from.heading % 360) + 360) % 360; to.heading = ((to.heading % 360) + 360) % 360;
      if (to.heading - from.heading > 180) from.heading += 360; else if (to.heading - from.heading < -180) from.heading -= 360;
      vel.x = vel.z = 0; auto = false;
      const dist = Math.hypot(to.x - from.x, to.z - from.z), big = Math.max(from.range, to.range);
      const dur = v.seconds ?? Math.min(5, Math.max(1.2, 1.2 + 0.7 * Math.log2(1 + dist / big) + 0.35 * Math.abs(Math.log2(to.range / from.range))));
      if (reduced || dur <= 0) { Object.assign(cur, to); Object.assign(goal, to); flight = null; groundInit = false; return; }
      // Long hops arc up and over: the apex is high enough to see both ends.
      flight = { from, to, t: 0, dur, hop: Math.max(0, Math.min(MAX_RANGE - big, Math.max(0, dist * 0.9 - big * 0.8))) };
    },
    view(): CameraView {
      const [lon, lat] = xzToLonLat(cur.x, cur.z);
      const p = camera.position;
      return { lon, lat, range: cur.range, heading: ((cur.heading % 360) + 360) % 360, pitch: cur.pitch, altitude: p.y + curveDrop(p.x, p.z) };
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('contextmenu', noMenu);
      removeEventListener('keydown', onKey); removeEventListener('keyup', onKey); removeEventListener('blur', onBlur);
    },
  };
  place(camera, cur, 0);
  target.copy(tgt);
  return api;
}
