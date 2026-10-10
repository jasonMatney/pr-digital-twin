// Stand-ins for the three parts of the scene, so each can be developed and tested without the others:
// a synthetic island with a seabed, a plain forward render, and a fixed camera. engine.ts falls back to these.
import * as THREE from 'three';
import type { ControlsApi, PostApi, TerrainApi, World } from './types';
import { curveDrop, xzToLonLat } from '../core/geo.ts';

/** Synthetic relief: a ridge about 160 km long rising to ~1100 m, shelving to a 30 m bank, then dropping to -3000 m. */
export function placeholderHeight(x: number, z: number): number {
  const u = x / 85000, v = z / 26000;
  const d = Math.sqrt(u * u + v * v);
  const ridge = Math.exp(-Math.pow(z / 14000, 2)) * (0.75 + 0.25 * Math.sin(x / 9000) * Math.cos(z / 5000));
  const land = Math.max(0, 1 - d);
  const h = land > 0 ? 20 + 1100 * Math.pow(land, 1.4) * ridge + 60 * land * Math.sin(x / 2300) * Math.sin(z / 1900) : 0;
  if (d <= 1) return h;
  const shelf = Math.min(1, (d - 1) / 0.12);          // 0..1 across the insular shelf
  if (shelf < 1) return -2 - 28 * shelf * shelf;
  return -30 - 2970 * Math.min(1, (d - 1.12) / 0.5);
}

export function createPlaceholderTerrain(world: World): TerrainApi {
  const group = new THREE.Group();
  const W = 420000, D = 280000, NX = 420, NZ = 280;
  const geo = new THREE.PlaneGeometry(W, D, NX, NZ).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), h = placeholderHeight(x, z);
    pos.setY(i, h - curveDrop(x, z));
    const c = h < 0 ? [0.62, 0.57, 0.46] : h < 30 ? [0.55, 0.52, 0.38] : [0.16 + h / 6000, 0.3 + h / 9000, 0.12];
    col.set(c, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  group.add(mesh);
  world.scene.add(group);
  const tmp = new THREE.Vector3();
  return {
    group,
    update() {},
    heightAt: (x, z) => (Math.abs(x) < W / 2 && Math.abs(z) < D / 2 ? placeholderHeight(x, z) : null),
    raycast(origin, dir, maxDist = 2e6) {
      let t = 0, step = 400;
      for (let i = 0; i < 4000 && t < maxDist; i++) {
        tmp.copy(origin).addScaledVector(dir, t);
        const g = placeholderHeight(tmp.x, tmp.z) - curveDrop(tmp.x, tmp.z);
        if (tmp.y <= g) return tmp.clone();
        step = Math.max(50, (tmp.y - g) * 0.5); t += step;
      }
      return null;
    },
    setOverlay() {},
    stats: () => ({ tiles: 1, pending: 0, maxZoom: 0 }),
    dispose() { geo.dispose(); },
  };
}

export function createPlaceholderPost(world: World): PostApi {
  const { renderer, scene, camera } = world;
  scene.background = new THREE.Color(0x7fa8cf);
  const sun = new THREE.DirectionalLight(0xfff0dc, 3);
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x55503f, 0.8);
  scene.add(sun, hemi);
  world.sunDir.set(0.3, 0.8, 0.5).normalize();
  return {
    render() { sun.position.copy(world.sunDir).multiplyScalar(1e5); renderer.render(scene, camera); },
    resize() {}, setTime() {}, setSeaLevel() {}, dispose() {},
  };
}

export function createPlaceholderControls(world: World): ControlsApi {
  const target = new THREE.Vector3(0, 0, 0);
  const state = { range: 260000, heading: 0, pitch: 55 };
  const apply = () => {
    const p = state.pitch * Math.PI / 180, h = state.heading * Math.PI / 180;
    const horiz = Math.cos(p) * state.range;
    world.camera.position.set(target.x - Math.sin(h) * horiz, target.y + Math.sin(p) * state.range, target.z + Math.cos(h) * horiz);
    world.camera.lookAt(target);
  };
  apply();
  return {
    target, enabled: true, update: apply,
    flyTo(v) { if (v.range) state.range = v.range; if (v.pitch != null) state.pitch = v.pitch; if (v.heading != null) state.heading = v.heading; },
    view() { const [lon, lat] = xzToLonLat(target.x, target.z); return { lon, lat, range: state.range, heading: state.heading, pitch: state.pitch, altitude: world.camera.position.y }; },
    dispose() {},
  };
}
