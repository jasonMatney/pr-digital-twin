// One material for every building tile: MeshStandardMaterial (sun, hemisphere light, scene.environment all apply,
// so buildings follow the terrain through the day) with the albedo painted procedurally from per-vertex facade
// coordinates. Ported, much lighter, from procedural-sanjuan (materials.js: window grid with frames, fwidth
// anti-aliasing, distance fade to a flat average, rooms lit one by one at night).
// Everything painted here is PROCEDURAL: colours, windows, lights. Only the hazard tints read real data.
import * as THREE from 'three';

export interface BuildingUniforms {
  [k: string]: THREE.IUniform;
  uBNight: { value: number }; uBLit: { value: number }; uBSea: { value: number }; uBNfhl: { value: number };
}

const VERT_PARS = /* glsl */`
  attribute vec4 aFac; attribute vec3 aBld;
  varying vec4 vFac; flat varying vec3 vBld; varying vec2 vLxz;
`;
const FRAG_PARS = /* glsl */`
  varying vec4 vFac; flat varying vec3 vBld; varying vec2 vLxz;
  uniform float uBNight, uBLit, uBSea, uBNfhl;
  vec3 gBEmis = vec3(0.0); float gBRough = 0.92;
  const vec3 B_HOUSE[12] = vec3[12](vec3(.93,.9,.8), vec3(.96,.86,.6), vec3(.78,.9,.8), vec3(.76,.86,.94), vec3(.96,.8,.7), vec3(.94,.78,.82),
    vec3(.96,.95,.92), vec3(.86,.84,.8), vec3(.98,.9,.5), vec3(.68,.86,.74), vec3(.86,.74,.9), vec3(.98,.72,.52));
  const vec3 B_APT[7] = vec3[7](vec3(.95,.94,.9), vec3(.93,.89,.8), vec3(.88,.86,.82), vec3(.96,.9,.78), vec3(.86,.9,.94), vec3(.95,.85,.76), vec3(.8,.88,.84));
  const vec3 B_COM[7] = vec3[7](vec3(.9,.89,.86), vec3(.74,.74,.73), vec3(.94,.9,.8), vec3(.56,.58,.6), vec3(.84,.78,.68), vec3(.92,.92,.91), vec3(.82,.88,.9));
  const vec3 B_PUB[4] = vec3[4](vec3(.95,.93,.87), vec3(.93,.85,.66), vec3(.86,.86,.84), vec3(.85,.74,.6));
  float bHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float bNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(bHash(i), bHash(i + vec2(1, 0)), f.x), mix(bHash(i + vec2(0, 1)), bHash(i + vec2(1, 1)), f.x), f.y); }
  float bBox(float x, float a, float b, float w) { return clamp(smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x), 0.0, 1.0); }
  vec3 bWall(float kind, float seed, float h) {
    vec3 c;
    if (kind < 0.5) c = B_HOUSE[int(seed * 11.999)];
    else if (kind < 1.5) c = B_APT[int(seed * 6.999)];
    else if (kind < 2.5) c = B_COM[int(seed * 6.999)];
    else if (kind < 3.5) c = mix(vec3(.72, .73, .74), vec3(.87, .87, .85), h);
    else c = B_PUB[int(seed * 3.999)];
    return pow(c, vec3(2.2)) * (0.74 + 0.18 * h);
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

    // flat concrete roof: off-white to grey, weathered, some with dark stains; a few small houses in metal
    float n1 = bNoise(vLxz * 0.13 + seed * 37.0);
    float nearK = 1.0 - smoothstep(120.0, 420.0, dist);
    // what Puerto Rican roofs look like from the air: white or silver sealant, bare concrete, dull red-brown
    // sealant on houses, a few old and dark
    vec3 roofC;
    if (h2 < 0.34) roofC = vec3(mix(0.5, 0.68, h3)) * vec3(1.0, 0.99, 0.95);
    else if (h2 < 0.78) roofC = vec3(mix(0.27, 0.44, h3)) * vec3(1.0, 0.97, 0.92);
    else if (h2 < 0.9) roofC = kind < 0.5 ? mix(vec3(0.3, 0.15, 0.11), vec3(0.37, 0.24, 0.19), h3) : vec3(0.4, 0.39, 0.37);
    else roofC = vec3(mix(0.16, 0.25, h3)) * vec3(1.0, 0.98, 0.95);
    roofC *= 0.76 + 0.42 * n1;
    roofC *= 1.0 - 0.14 * nearK * bNoise(vec2(vLxz.x * 0.9 + seed * 5.0, vLxz.y * 0.07 + seed * 3.0));   // rain streaks
    roofC *= 1.0 - 0.34 * smoothstep(0.5, 0.82, bNoise(vLxz * 0.045 + seed * 91.0)) * step(0.35, h1);
    roofC *= mix(1.0, 0.9 + 0.2 * bNoise(vLxz * 1.1 + seed * 11.0), nearK);
    if (kind < 0.5 && H < 5.0) {
      float corr = mix(1.0, 0.86 + 0.28 * abs(fract((vLxz.x * (0.5 + h2) + vLxz.y * (1.5 - h2)) * 1.1) - 0.5), nearK);
      if (h3 < 0.06) roofC = vec3(0.23, 0.085, 0.06) * (0.8 + 0.4 * n1) * corr;
      else if (h3 < 0.15) roofC = vec3(0.36, 0.38, 0.4) * (0.8 + 0.35 * n1) * corr;
    }
    {  // water tanks and roof plant: dark dots about 1.3 m across, gone before they can shimmer
      vec2 tg = vLxz / 6.5 + seed * 7.0, tc = floor(tg);
      float th = bHash(tc + seed * 13.0), tw = max(fwidth(tg.x), fwidth(tg.y));
      vec2 tp = fract(tg) - 0.5 - (vec2(bHash(tc + 3.7), bHash(tc + 9.1)) - 0.5) * 0.5;
      float tank = (1.0 - smoothstep(0.1 - tw, 0.1 + tw, length(tp))) * step(th, 0.2) * (1.0 - smoothstep(0.03, 0.1, tw));
      roofC = mix(roofC, th < 0.1 ? vec3(0.03, 0.035, 0.045) : th < 0.16 ? vec3(0.05, 0.09, 0.18) : vec3(0.6), tank);
    }
    roofC *= mix(1.0, 0.5, uBNight);                 // roofs go dark at night
    wallC *= mix(1.0, 0.72, uBNight);
    bool roofLike = part > 0.5 || !gl_FrontFacing;
    vec3 c;
    if (roofLike) {
      c = part > 0.5 ? roofC : roofC * 0.7;          // the inner face of the parapet
    } else {
      c = wallC;
      float floors = max(1.0, floor(H / 3.1 + 0.4)), floorH = H / floors;
      if (bayW > 0.0 && H > 2.4 && v > 0.0 && v < H) {
        vec2 g = vec2(u, v / floorH), cell = floor(g), f = fract(g);
        vec2 w = max(fwidth(g), vec2(1e-4));
        vec4 r = kind < 0.5 ? vec4(0.27, 0.73, 0.30, 0.71) : kind < 2.5 ? vec4(0.13, 0.87, 0.27, 0.80) : vec4(0.2, 0.8, 0.46, 0.8);
        float share = kind < 0.5 ? 0.76 : kind > 2.5 && kind < 3.5 ? 0.4 : 0.94;      // some bays are plain wall
        float has = step(bHash(cell * 1.31 + seed * 131.0), share);
        float win = bBox(f.x, r.x, r.y, w.x) * bBox(f.y, r.z, r.w, w.y) * has;
        vec2 fw = vec2(0.09 / bayW, 0.09 / floorH);
        float outer = bBox(f.x, r.x - fw.x, r.y + fw.x, w.x) * bBox(f.y, r.z - fw.y, r.w + fw.y, w.y) * has;
        // recessed glazing: darker under the head of the opening, a mullion down the middle of wide panes
        vec3 glass = vec3(0.035, 0.05, 0.065) * (0.6 + 0.8 * bHash(cell + seed * 17.0));
        glass *= mix(1.0, 0.45, smoothstep(r.w - 0.14, r.w, f.y));
        float mull = 1.0 - bBox(f.x, 0.5 - 0.02, 0.5 + 0.02, w.x);
        vec3 frameC = mix(wallC, vec3(0.78), 0.65);
        vec3 det = mix(c, frameC, clamp(outer - win, 0.0, 1.0));
        det = mix(det, mix(frameC, glass, mull), win);
        float cover = (r.y - r.x) * (r.w - r.z) * share;
        vec3 avg = mix(c, vec3(0.05, 0.065, 0.08), cover);
        float blur = smoothstep(0.22, 0.6, max(w.x, w.y));
        c = mix(det, avg, blur);
        gBRough = mix(0.92, mix(0.22, 0.92, blur), win);
        // night: rooms lit one by one; one building is asleep, the next is busy
        float busy = clamp(uBLit * (0.25 + 1.5 * h2), 0.0, 0.95);
        float lit = step(bHash(cell * 1.7 + seed * 53.0), busy);
        vec3 warm = mix(vec3(1.0, 0.6, 0.27), vec3(0.85, 0.88, 0.8), step(0.86, bHash(cell + seed * 3.0)));
        gBEmis = warm * uBNight * 1.15 * mix(win * lit * mull, cover * busy * 0.8, blur);
      }
      c *= mix(0.58, 1.0, smoothstep(0.0, 0.6, v)) * (0.9 + 0.1 * clamp(v / H, 0.0, 1.0));   // grounding
    }
    // hazard views. Bathtub screen: ground elevation against the scenario water level, nothing more.
    float upper = roofLike ? 1.0 : smoothstep(0.3, 0.7, v / max(H, 1.0));
    if (uBSea > 0.05 && ground <= uBSea) { c = mix(c, vec3(1.0, 0.145, 0.043), 0.56 * upper); gBEmis *= 1.0 - upper; }
    if (uBNfhl > 0.5 && roofLike && flood > 0.5)
      c = mix(c, flood < 1.5 ? vec3(0.915, 0.459, 0.0072) : flood < 2.5 ? vec3(0.038, 0.359, 0.807) : vec3(0.201, 0.119, 1.0), 0.66);
    diffuseColor.rgb = c;
  }
`;

export function createBuildingMaterial(): { material: THREE.MeshStandardMaterial; uniforms: BuildingUniforms } {
  const uniforms: BuildingUniforms = { uBNight: { value: 0 }, uBLit: { value: 0.4 }, uBSea: { value: 0 }, uBNfhl: { value: 0 } };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vFac = aFac; vBld = aBld; vLxz = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = gBRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += gBEmis;');
  };
  material.customProgramCacheKey = () => 'garita-buildings-4';
  return { material, uniforms };
}
