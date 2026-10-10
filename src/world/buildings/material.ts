// Building material: MeshStandardMaterial (sun, hemisphere light, scene.environment and the sun shadow map all
// apply, so buildings follow the terrain through the day) with the albedo painted from per-vertex data.
// One instance per tile (its own roof photo and fade), one shared program.
//   REAL: the roof albedo is the aerial photo itself (the imagery the terrain drapes), lifted to the roof.
//   PROCEDURAL: walls, windows, lit rooms, the parapet rim, and roofs where the photo has no data.
// Ported, much lighter, from procedural-sanjuan (materials.js: window grid with frames, filtered so it never
// shimmers, rooms lit one by one at night).
import * as THREE from 'three';

export interface SharedUniforms {
  [k: string]: THREE.IUniform;
  uBNight: { value: number }; uBLit: { value: number }; uBSea: { value: number }; uBNfhl: { value: number };
}
export interface TileUniforms {
  tBPhoto: { value: THREE.Texture | null }; uBPhotoXf: { value: THREE.Vector4 }; uBPhotoOn: { value: number }; uBFade: { value: number };
}
export const createSharedUniforms = (): SharedUniforms => ({ uBNight: { value: 0 }, uBLit: { value: 0.3 }, uBSea: { value: 0 }, uBNfhl: { value: 0 } });

const VERT_PARS = /* glsl */`
  attribute vec4 aFac; attribute vec3 aBld; attribute vec3 aEdge;
  uniform float uBFade;
  varying vec4 vFac; flat varying vec3 vBld; varying vec2 vLxz; varying vec3 vEdge; varying vec2 vWN;
`;
const VERT_MAIN = /* glsl */`
  transformed.y -= (1.0 - uBFade) * max(aFac.y, 0.0) * 0.97;     // rise from the building's own base
  vFac = aFac; vBld = aBld; vLxz = position.xz; vEdge = aEdge; vWN = normal.xz;
`;
const FRAG_PARS = /* glsl */`
  varying vec4 vFac; flat varying vec3 vBld; varying vec2 vLxz; varying vec3 vEdge; varying vec2 vWN;
  uniform float uBNight, uBLit, uBSea, uBNfhl, uBPhotoOn;
  uniform sampler2D tBPhoto; uniform vec4 uBPhotoXf;
  vec3 gBEmis = vec3(0.0); float gBRough = 0.92, gBMetal = 0.0;
  const vec3 B_HOUSE[12] = vec3[12](vec3(.93,.9,.8), vec3(.96,.86,.6), vec3(.78,.9,.8), vec3(.76,.86,.94), vec3(.96,.8,.7), vec3(.94,.78,.82),
    vec3(.96,.95,.92), vec3(.86,.84,.8), vec3(.98,.9,.5), vec3(.68,.86,.74), vec3(.86,.74,.9), vec3(.98,.72,.52));
  const vec3 B_APT[7] = vec3[7](vec3(.95,.94,.9), vec3(.93,.89,.8), vec3(.88,.86,.82), vec3(.96,.9,.78), vec3(.86,.9,.94), vec3(.95,.85,.76), vec3(.8,.88,.84));
  const vec3 B_COM[7] = vec3[7](vec3(.9,.89,.86), vec3(.74,.74,.73), vec3(.94,.9,.8), vec3(.56,.58,.6), vec3(.84,.78,.68), vec3(.92,.92,.91), vec3(.82,.88,.9));
  const vec3 B_PUB[4] = vec3[4](vec3(.95,.93,.87), vec3(.93,.85,.66), vec3(.86,.86,.84), vec3(.85,.74,.6));
  float bHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float bNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(bHash(i), bHash(i + vec2(1, 0)), f.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), f.x), f.y); }
  // Box-filtered periodic rectangle: the exact share of [x - w/2, x + w/2] that lies inside [a, b] of each unit cell.
  // Crisp up close, and it settles on the average (b - a) by itself far away: nothing left to shimmer.
  float bInt(float x, float a, float b) { return floor(x) * (b - a) + clamp(fract(x) - a, 0.0, b - a); }
  float bCov(float x, float a, float b, float w) { return clamp((bInt(x + 0.5 * w, a, b) - bInt(x - 0.5 * w, a, b)) / w, 0.0, 1.0); }
  vec3 bWall(float kind, float seed, float h) {
    vec3 c;
    if (kind < 0.5) c = B_HOUSE[int(seed * 11.999)];
    else if (kind < 1.5) c = B_APT[int(seed * 6.999)];
    else if (kind < 2.5) c = B_COM[int(seed * 6.999)];
    else if (kind < 3.5) c = mix(vec3(.72, .73, .74), vec3(.87, .87, .85), h);
    else if (kind < 4.5) c = B_PUB[int(seed * 3.999)];
    else c = mix(vec3(.42, .47, .52), vec3(.66, .69, .72), h);
    c = pow(c, vec3(2.2)) * (0.74 + 0.18 * h);
    float l = dot(c, vec3(0.3, 0.59, 0.11));
    return max(l + (c - l) * 1.32, 0.0);            // a little more saturated than the paint chart: walls wash out in haze
  }
  // The terrain's grade of the aerial photo (terrain/material.ts), so a roof matches the ground beside it.
  vec3 bGrade(vec3 lin) {
    vec3 s = pow(max(lin, 0.0), vec3(1.0 / 2.2));
    s = max(s - vec3(0.020, 0.034, 0.062), 0.0) * 1.11;
    float warm = max(s.r, s.g);
    if (s.b > warm) s.b = warm + (s.b - warm) * 0.45;
    float l = dot(s, vec3(0.30, 0.59, 0.11));
    s = clamp(0.035 + 0.965 * l + (s - l) * 1.16, 0.0, 1.0);
    return pow(s, vec3(2.2));
  }
  // Photo colour and coverage (0 where the service painted blank white or black, or nothing is loaded).
  vec4 bPhoto(vec2 lxz, float bias) {
    vec3 p = texture2D(tBPhoto, lxz * uBPhotoXf.xy + uBPhotoXf.zw, bias).rgb;
    float hi = max(p.r, max(p.g, p.b)), lo = min(p.r, min(p.g, p.b));
    return vec4(bGrade(p), uBPhotoOn * smoothstep(0.001, 0.006, hi) * (1.0 - smoothstep(0.975, 0.998, lo)));
  }
`;
const FRAG_COLOR = /* glsl */`
  {
    float code = floor(vBld.z + 0.5);
    float flood = floor(code / 32.0); code -= flood * 32.0;
    float part = floor(code / 8.0), kind = code - part * 8.0;
    float H = vBld.x * 0.1, ground = vBld.y * 0.1;
    float u = vFac.x, v = vFac.y, seed = vFac.z, bayW = vFac.w;
    float dist = length(vViewPosition);
    float h1 = bHash(vec2(seed * 917.0, 3.1)), h2 = bHash(vec2(seed * 573.0, 9.7)), h3 = bHash(vec2(seed * 331.0, 5.3));
    vec3 wallC = bWall(kind, seed, h1);
    bool roof = part > 0.5;
    float edgeM = min(vEdge.x, min(vEdge.y, vEdge.z)) * 0.1;      // metres to the footprint outline (roofs)
    vec3 c;
    if (roof) {
      // fallback where the photo has nothing: what Puerto Rican roofs look like from the air (white or silver
      // sealant, bare concrete, dull red-brown sealant on houses, a few old and dark), weathered
      vec3 roofC;
      if (h2 < 0.34) roofC = vec3(mix(0.5, 0.68, h3)) * vec3(1.0, 0.99, 0.95);
      else if (h2 < 0.78) roofC = vec3(mix(0.27, 0.44, h3)) * vec3(1.0, 0.97, 0.92);
      else if (h2 < 0.9) roofC = kind < 0.5 ? mix(vec3(0.3, 0.15, 0.11), vec3(0.37, 0.24, 0.19), h3) : vec3(0.4, 0.39, 0.37);
      else roofC = vec3(mix(0.16, 0.25, h3)) * vec3(1.0, 0.98, 0.95);
      roofC *= 0.76 + 0.42 * bNoise(vLxz * 0.13 + seed * 37.0);
      vec4 ph = bPhoto(vLxz, -0.5);
      c = mix(roofC, ph.rgb, ph.a);
      // parapet: a lighter cap along the outline and the line of shade inside it; gone before it can alias
      float ew = max(fwidth(edgeM), 1e-3), keep = 1.0 - smoothstep(0.25, 0.7, ew);
      float cap = 1.0 - smoothstep(0.24 - ew, 0.24 + ew, edgeM);
      float shade = (1.0 - smoothstep(0.24, 0.7, edgeM)) * (1.0 - cap);
      c = mix(c, c * 0.7, shade * keep * 0.8);
      c = mix(c, mix(c, wallC, 0.35) * 1.12 + 0.015, cap * keep);
    } else {
      // plaster, pulled a little toward the photographed roof just inside this wall
      vec4 rp = bPhoto(vLxz - vWN * 3.0, 2.5);
      wallC = mix(wallC, rp.rgb * 1.1, 0.16 * rp.a);
      wallC *= mix(1.0, 0.74, uBNight);
      c = wallC;
      float floors = max(1.0, floor(H / 3.1 + 0.4)), floorH = H / floors;
      if (bayW > 0.0 && H > 2.4 && v > 0.0 && v < H) {
        vec2 g = vec2(u, v / floorH), cell = floor(g), f = fract(g);
        vec2 w = max(fwidth(g), vec2(1e-4));
        float glassT = step(4.5, kind);
        vec4 r = kind < 0.5 ? vec4(0.27, 0.73, 0.30, 0.71) : kind < 2.5 ? vec4(0.13, 0.87, 0.27, 0.80) : kind < 3.5 ? vec4(0.2, 0.8, 0.46, 0.8)
          : kind < 4.5 ? vec4(0.22, 0.78, 0.26, 0.8) : vec4(0.035, 0.965, 0.1, 0.93);
        float share = kind < 0.5 ? 0.76 : kind > 2.5 && kind < 3.5 ? 0.4 : 1.0;      // some bays are plain wall
        float blur = smoothstep(0.3, 0.8, max(w.x, w.y));                            // per-room detail gives way to its mean
        float has = mix(step(bHash(cell * 1.31 + seed * 131.0), share), share, blur);
        float win = bCov(g.x, r.x, r.y, w.x) * bCov(g.y, r.z, r.w, w.y) * has;
        vec2 fw = vec2(0.09 / bayW, 0.09 / floorH);
        float outer = bCov(g.x, r.x - fw.x, r.y + fw.x, w.x) * bCov(g.y, r.z - fw.y, r.w + fw.y, w.y) * has;
        // recessed glazing: darker under the head of the opening, a mullion down the middle of the pane
        vec3 glass = mix(vec3(0.035, 0.05, 0.065), vec3(0.12, 0.17, 0.22), glassT) * mix(0.6 + 0.8 * bHash(cell + seed * 17.0), 1.0, blur);
        // From afar a curtain wall is the sky it reflects, not a black slab: when the environment map is dim or
        // missing (analytic-sky fallback) the reflection alone leaves towers black.
        glass = mix(glass, vec3(0.20, 0.27, 0.33) * mix(1.0, 0.25, uBNight), blur * glassT * 0.6);
        glass *= mix(1.0, mix(1.0, 0.5, smoothstep(r.w - 0.14, r.w, f.y)), 1.0 - blur);
        float mull = 1.0 - (1.0 - bCov(g.x, 0.0, 0.48, w.x) - bCov(g.x, 0.52, 1.0, w.x)) * (1.0 - blur);
        vec3 frameC = mix(wallC, vec3(0.74), 0.65);
        vec3 det = mix(c, frameC, clamp(outer - win, 0.0, 1.0));
        c = mix(det, mix(frameC, glass, mull), win);
        gBRough = mix(0.92, mix(0.16, 0.07, glassT), win);
        gBMetal = win * mix(0.3, 0.45, glassT) * (1.0 - 0.6 * blur);
        // night: rooms lit one by one; one building is asleep, the next is busy
        float busy = clamp(uBLit * (0.25 + 1.5 * h2), 0.0, 0.95);
        float lit = mix(step(bHash(cell * 1.7 + seed * 53.0), busy), busy * 0.8, blur);
        vec3 warm = mix(vec3(1.0, 0.6, 0.27), vec3(0.85, 0.88, 0.8), step(0.86, bHash(cell + seed * 3.0)) * (1.0 - blur));
        gBEmis = warm * uBNight * 1.15 * win * lit * mull;
      }
      // grounding: a darker plinth line, then a soft gradient up the wall
      float vw = max(fwidth(v), 1e-3);
      c *= mix(0.72, 1.0, smoothstep(0.5 - vw, 0.5 + vw, v)) * mix(0.9, 1.0, smoothstep(0.5, 2.2, v)) * (0.93 + 0.07 * clamp(v / H, 0.0, 1.0));
    }
    // Hazard views: a strong rim along the roof outline and the top of the walls, a partial tint over the rest of the
    // roof (the photo stays readable). Scenario = bathtub screen: ground elevation against the water level, no more.
    float rim = roof ? 1.0 - smoothstep(0.9, 1.5, edgeM) : smoothstep(H - 1.7, H - 1.3, v);
    float body = roof ? 0.42 : 0.3 * smoothstep(0.3, 0.7, v / max(H, 1.0));
    if (uBSea > 0.05 && ground <= uBSea) { float k = max(body, 0.92 * rim); c = mix(c, vec3(1.0, 0.145, 0.043), k); gBEmis *= 1.0 - k; }
    if (uBNfhl > 0.5 && flood > 0.5)
      c = mix(c, flood < 1.5 ? vec3(0.915, 0.459, 0.0072) : flood < 2.5 ? vec3(0.038, 0.359, 0.807) : vec3(0.201, 0.119, 1.0), max(roof ? 0.45 : 0.0, 0.92 * rim));
    diffuseColor.rgb = c;
  }
`;

export function createBuildingMaterial(shared: SharedUniforms): { material: THREE.MeshStandardMaterial; uniforms: TileUniforms } {
  const uniforms: TileUniforms = { tBPhoto: { value: null }, uBPhotoXf: { value: new THREE.Vector4(1, 1, 0, 0) }, uBPhotoOn: { value: 0 }, uBFade: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = gBRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = gBMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += gBEmis;');
  };
  material.customProgramCacheKey = () => 'garita-buildings-7';
  return { material, uniforms };
}
