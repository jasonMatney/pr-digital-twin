import * as THREE from 'three';
import { curveDrop, lonLatToXZ } from '../core/geo.ts';

/** World position of a point `h` metres above MSL at (x, z): the scene is a cap of the globe. */
export function curved(x: number, z: number, h: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, h - curveDrop(x, z), z);
}
export function curvedLonLat(lon: number, lat: number, h: number, out = new THREE.Vector3()): THREE.Vector3 {
  const [x, z] = lonLatToXZ(lon, lat);
  return curved(x, z, h, out);
}
/** GLSL: lowers a world-space position by the Earth's curvature. Include in vertex shaders that draw ground geometry. */
export const CURVE_GLSL = /* glsl */`
  const float R_EARTH = 6371008.8;
  vec3 curveWorld(vec3 p) { return vec3(p.x, p.y - (p.x * p.x + p.z * p.z) / (2.0 * R_EARTH), p.z); }
`;
