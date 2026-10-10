// Tile material: MeshStandardMaterial (so the sun, hemisphere light and scene.environment all apply) with the
// albedo, normal and seabed logic patched in. One GLSL program is shared by every tile.
import * as THREE from 'three';

export interface TileUniforms {
  tPhoto: { value: THREE.Texture };
  tNorm: { value: THREE.Texture };       // RG = world normal x,z; B = height code: metres = B*128 - 96 (clamped)
  tOverlay: { value: THREE.Texture };
  uOvXf: { value: THREE.Vector4 };
  uHasPhoto: { value: number };
  uTint: { value: THREE.Color };
}
export interface GlobalUniforms { uOvOpacity: { value: number }; uRelief: { value: number }; uLod: { value: number } }

const PARS = /* glsl */`
uniform sampler2D tPhoto; uniform sampler2D tNorm; uniform sampler2D tOverlay;
uniform vec4 uOvXf; uniform float uHasPhoto; uniform float uOvOpacity; uniform float uRelief; uniform float uLod; uniform vec3 uTint;
varying float vH;
vec3 gToLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
`;

const ALBEDO = /* glsl */`
{
  vec4 nt = texture2D(tNorm, vUv);
  float hC = nt.b * 128.0 - 96.0;
  float h = hC < -95.0 ? min(hC, vH) : (hC > 31.0 ? max(hC, vH) : hC);
  vec3 lin = texture2D(tPhoto, vUv).rgb;
  // Grade in display space: the aerial photo carries a blue haze veil and crushed shadows.
  vec3 s = pow(max(lin, 0.0), vec3(1.0 / 2.2));
  s = max(s - vec3(0.020, 0.034, 0.062), 0.0) * 1.11;
  float warm = max(s.r, s.g);
  if (s.b > warm) s.b = warm + (s.b - warm) * 0.45;
  float l = dot(s, vec3(0.30, 0.59, 0.11));
  float l2 = 0.035 + 0.965 * l;
  s = clamp(l2 + (s - l) * 1.16, 0.0, 1.0);
  vec3 land = gToLin(s);
  // The imagery is pure black where there is no coverage (offshore). Near sea level show deep water, not a black slab.
  float nodata = (1.0 - smoothstep(0.0012, 0.006, max(lin.r, max(lin.g, lin.b)))) * (1.0 - smoothstep(1.0, 3.0, h)) * uHasPhoto;
  land = mix(land, vec3(0.012, 0.034, 0.048), nodata);
  if (uHasPhoto < 0.5) {
    // No photo yet: colour by elevation so the page never shows nothing.
    float t = clamp(h / 1200.0, 0.0, 1.0);
    vec3 c = mix(vec3(0.33, 0.42, 0.22), vec3(0.20, 0.33, 0.15), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(0.42, 0.40, 0.30), smoothstep(0.55, 1.0, t));
    c = mix(vec3(0.20, 0.25, 0.27), c, smoothstep(0.5, 2.0, h));   // unknown ground at sea level reads as water, not lawn
    land = gToLin(c); l = 0.45;
  }
  // Below sea level the photo shows the water surface, not the bottom: paint a seabed for the ocean pass to tint.
  float depth = max(0.0, -h);
  float shallow = 1.0 - smoothstep(0.0, 25.0, depth);
  float veg = smoothstep(0.36, 0.14, l) * shallow * uHasPhoto;
  vec3 bed = mix(vec3(0.31, 0.285, 0.215), vec3(0.075, 0.10, 0.068), veg * 0.85);
  bed = mix(bed, vec3(0.055, 0.058, 0.060), smoothstep(22.0, 62.0, depth));
  // Lidar tiles hold harbours and the nearshore at about 0 m with no bathymetry: there the photographed water is the
  // best evidence, so the seabed only takes over where the model shows real depth.
  float under = smoothstep(-0.4, -2.6, h);
  vec3 alb = mix(land, bed, under);
  vec2 ouv = vUv * uOvXf.xy + uOvXf.zw;
  vec4 ov = texture2D(tOverlay, ouv);
  alb = mix(alb, gToLin(pow(ov.rgb, vec3(1.0 / 2.2))), ov.a * uOvOpacity);
  alb = mix(alb, alb * 0.35 + uTint * 0.65, uLod);
  diffuseColor.rgb = alb;
}
`;

const NORMAL = /* glsl */`
{
  vec2 nxz = texture2D(tNorm, vUv).rg * 2.0 - 1.0;
  // The photo already holds the real sun's shading, so the lit response is softened: horizontal part scaled down.
  nxz *= uRelief;
  vec3 nW = vec3(nxz.x, sqrt(max(0.05, 1.0 - dot(nxz, nxz))), nxz.y);
  normal = normalize(mat3(viewMatrix) * normalize(nW));
  nonPerturbedNormal = normal;
}
`;

const LOD_COLORS = [0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x46f0f0, 0xf032e6, 0xbcf60c, 0xfabebe];

export function makeTileMaterial(g: GlobalUniforms, photo: THREE.Texture, norm: THREE.Texture, overlay: THREE.Texture, hasPhoto: boolean, z: number) {
  const uniforms: TileUniforms = {
    tPhoto: { value: photo }, tNorm: { value: norm }, tOverlay: { value: overlay },
    uOvXf: { value: new THREE.Vector4(1, 1, 0, 0) }, uHasPhoto: { value: hasPhoto ? 1 : 0 },
    uTint: { value: new THREE.Color(LOD_COLORS[z % LOD_COLORS.length]) },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, color: 0xffffff });
  material.defines = { USE_UV: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, g);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        { vec4 wp = modelMatrix * vec4(transformed, 1.0); vH = wp.y + (wp.x * wp.x + wp.z * wp.z) / (2.0 * 6371008.8); }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <map_fragment>', ALBEDO)
      .replace('#include <normal_fragment_maps>', NORMAL);
  };
  material.customProgramCacheKey = () => 'garita-tile-6';
  return { material, uniforms };
}
