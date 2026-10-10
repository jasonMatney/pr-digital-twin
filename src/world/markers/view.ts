// Screen projection and terrain occlusion shared by the markers and the labels. No allocations per call.
import * as THREE from 'three';
import type { World } from '../types';

/** Anything with a world position that can be hidden by terrain. */
export interface OccPt { wx: number; wy: number; wz: number; dist: number; vis: number; occ: boolean; occStamp: number }

export class View {
  /** View-projection matrix (column-major), canvas size in CSS px, camera position. */
  m = new Float64Array(16);
  w = 1; h = 1;
  cx = 0; cy = 0; cz = 0;
  /** Results of project(). */
  sx = 0; sy = 0; depth = 0;
  /** Bumped when the camera has moved enough to invalidate cached occlusion results. */
  camStamp = 1;
  budget = 0;
  pending = false;
  private ox = 0; private oy = 0; private oz = 0; private or = 1;
  private vp = new THREE.Matrix4();
  private o = new THREE.Vector3();
  private d = new THREE.Vector3();
  constructor(private world: World) {}

  /** Returns true when the view changed since the last call. */
  sync(w: number, h: number, range: number): boolean {
    const cam = this.world.camera;
    this.vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const e = this.vp.elements, m = this.m;
    let changed = w !== this.w || h !== this.h;
    for (let i = 0; i < 16; i++) { if (m[i] !== e[i]) { m[i] = e[i]; changed = true; } }
    this.w = w; this.h = h;
    const p = cam.position;
    this.cx = p.x; this.cy = p.y; this.cz = p.z;
    const moved = Math.abs(p.x - this.ox) + Math.abs(p.y - this.oy) + Math.abs(p.z - this.oz);
    if (moved > Math.max(15, Math.min(range, this.or) * 0.02)) { this.ox = p.x; this.oy = p.y; this.oz = p.z; this.or = range; this.camStamp++; }
    return changed;
  }

  /** World point to CSS pixels. False when behind the camera. */
  project(x: number, y: number, z: number): boolean {
    const m = this.m;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 1e-6) return false;
    this.sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * this.w;
    this.sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * this.h;
    this.depth = w;
    return true;
  }

  /** Keeps `p.occ` current within the frame's budget and eases `p.vis` toward it. Returns p.vis. */
  occlude(p: OccPt, dt: number): number {
    if (p.occStamp !== this.camStamp) {
      if (this.budget > 0) {
        this.budget--;
        const lift = 4 + p.dist * 0.0015;
        this.o.set(this.cx, this.cy, this.cz);
        this.d.set(p.wx - this.cx, p.wy + lift - this.cy, p.wz - this.cz);
        const L = this.d.length();
        this.d.multiplyScalar(1 / L);
        const max = L - Math.max(10, L * 0.012);
        const hit = max > 0 ? this.world.terrain.raycast(this.o, this.d, max) : null;
        p.occ = !!hit && hit.distanceTo(this.o) < max;
        p.occStamp = this.camStamp;
      } else this.pending = true;
    }
    const target = p.occ ? 0 : 1;
    if (p.vis !== target) {
      const step = dt * 5;
      p.vis = target > p.vis ? Math.min(1, p.vis + step) : Math.max(0, p.vis - step);
      if (p.vis !== target) this.pending = true;
    }
    return p.vis;
  }
}

export const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
