// The scene render and the ocean, as one composer pass.
//
// The scene (terrain WITH its seabed, buildings, markers) is rendered to a private target. A full-screen pass then
// intersects every view ray analytically with the curved sea surface y = seaLevel - (x^2 + z^2) / (2R) and, where the
// ray meets the water before the geometry, shades the water over the seabed that was rendered there: Fresnel
// reflection of the sky, Cox-Munk sun glitter, per-channel Beer-Lambert absorption (Jerlov IB), in-scatter, foam.
// It writes colour AND depth (the water surface's depth) into the composer's buffer, so the effects that follow
// (clouds, aerial perspective) haze the sea surface, not the abyss below it.
import * as THREE from 'three';
import { Pass } from 'postprocessing';
import { R_EARTH } from '../../core/geo.ts';

/** Meshes on this layer (and not on layer 0) are drawn after the ocean when `overWater` is on. */
export const OVER_WATER_LAYER = 3;
export const N_OCT = 6, N_PER = 6, N_WAVES = N_OCT * N_PER;

/** Analytic sky radiance (scene units) shared by the water's reflection, the fallback sky and the environment map. */
export const SKY_GLSL = /* glsl */`
  uniform vec3 uZen, uHor, uGlow, uSunDir;
  vec3 skyRad(vec3 d, float up) {
    float y = clamp(up, 0.0, 1.0);
    vec3 c = mix(uHor, uZen, 1.0 - pow(1.0 - y, 4.5));
    float m = max(dot(d, uSunDir), 0.0);
    c += uGlow * (0.55 * pow(m, 48.0) + 0.16 * pow(m, 7.0)) * (0.35 + 0.65 * pow(1.0 - y, 3.0));
    // low sun: the horizon glows toward the sun's azimuth
    float az = max(dot(normalize(d.xz + 1e-5), normalize(uSunDir.xz + 1e-5)), 0.0);
    c += uGlow * 1.6 * az * az * pow(1.0 - y, 5.0) * pow(1.0 - clamp(uSunDir.y, 0.0, 1.0), 8.0);
    return c;
  }
`;

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }
`;

const FRAG = /* glsl */`
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform float uNear, uFar, uCamH, uTime, uPix, uOcean, uBasic, uMss, uWindMs, uWaveH, uNight, uDeepGain, uRise;
  uniform vec2 uTan, uOR, uWrap;
  uniform float uOrbit, uDbgAlpha;
  uniform vec4 uCloud2;   // threshold, softness, ground shadow strength, cover bias
  uniform vec3 uCamPos, uRight, uUp, uFwd, uLightDir, uLightE, uEd, uK, uDeepR;
  uniform vec4 uWave[${N_WAVES}];   // kx, kz, phase at the camera, slope amplitude
  uniform vec2 uOct[${N_OCT}];      // wavelength, share of the mean-square slope
  ${SKY_GLSL}
  const float R = ${R_EARTH.toFixed(1)};
  const float N_W = 1.333;
  const float PI = 3.14159265;

  float fresnelAir(float cosi) { // exact, unpolarised, air -> water
    float c = clamp(cosi, 0.0, 1.0);
    float sin2t = (1.0 - c * c) / (N_W * N_W);
    float cost = sqrt(max(1.0 - sin2t, 0.0));
    float rs = (c - N_W * cost) / (c + N_W * cost + 1e-6);
    float rp = (N_W * c - cost) / (N_W * c + cost + 1e-6);
    return 0.5 * (rs * rs + rp * rp);
  }
  // Fresnel averaged over a Gaussian slope distribution of mean-square slope s (Bruneton, Neyret & Poulin 2010),
  // as a scale on the smooth-surface value.
  float avgFresnelScale(float c, float s) {
    float cc = clamp(c, 0.0, 1.0);
    float smooth1 = 0.02 + 0.98 * pow(1.0 - cc, 5.0);
    float avg = 0.02 + 0.98 * pow(1.0 - cc, 5.0 * exp(-2.69 * s)) / (1.0 + 22.7 * pow(s, 1.5));
    return avg / max(smooth1, 1e-4);
  }
  float hash(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
  float vnoise(vec2 p, float per) { // value noise, periodic in 'per' cells
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = hash(mod(i, per)), b = hash(mod(i + vec2(1.0, 0.0), per)), c = hash(mod(i + vec2(0.0, 1.0), per)), d = hash(mod(i + vec2(1.0, 1.0), per));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float lace(vec2 p, float t) { // foam: thin bright filaments between dark cells, drifting
    float n1 = vnoise(p + vec2(t * 0.11, -t * 0.07), 256.0), n2 = vnoise(p * 2.03 + vec2(-t * 0.09, t * 0.13) + 17.0, 512.0);
    float r = 1.0 - abs(2.0 * n1 - 1.0); float q = 1.0 - abs(2.0 * n2 - 1.0);
    return smoothstep(0.55, 0.95, r) * 0.7 + smoothstep(0.6, 0.97, q) * 0.5;
  }

  // Cloud cover as seen from orbit: a procedural 2D field on a shell 2.2 km up, driven by the cloud-cover value
  // only (it is NOT observed weather, and is switched off whenever a radar or satellite overlay is shown). Cloud
  // masses tens of km across broken into cumulus cells, with clear lanes and more over the island; the coordinates
  // are warped so that edges curl instead of following the noise lattice, and the edge is crisp in some regions and
  // frayed in others.
  float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p, 4096.0); p = p * 2.07 + 13.7; a *= 0.5; } return s / 0.9375; }
  float fbm2(vec2 p) { return (vnoise(p, 4096.0) + 0.5 * vnoise(p * 2.11 + 19.3, 4096.0)) / 1.5; }
  float cloud2D(vec2 p) {
    vec2 wv = (vec2(fbm2(p / 21000.0 + 7.1), fbm2(p / 21000.0 + 53.4)) - 0.5) * 11000.0, q = p + wv;
    float field = fbm(p / 90000.0 + 31.0);
    float mass = fbm2(q / 30000.0 + 11.0);
    float cells = fbm(q / 7500.0 + 5.0);
    float fray = fbm2((p + 0.3 * wv) / 1700.0 + 41.0);   // (barely warped: stretched fine detail reads as brush strokes)
    float island = exp(-(p.x * p.x) / (2.0 * 70000.0 * 70000.0) - ((p.y - 3000.0) * (p.y - 3000.0)) / (2.0 * 17000.0 * 17000.0));
    float c = 0.5 + (0.36 * mass + 0.44 * cells + 0.20 * fray - 0.5) * 1.3;
    c += (smoothstep(0.38, 0.62, field) - 0.5) * 0.30 + 0.10 * island + uCloud2.w;
    float soft = uCloud2.y * mix(0.55, 2.1, smoothstep(0.3, 0.7, fbm2(p / 52000.0 + 77.0)));
    float mid = uCloud2.x + 0.5 * uCloud2.y;
    return smoothstep(mid - 0.5 * soft, mid + 0.5 * soft, c);
  }
  float stars(vec3 d) {
    vec3 p = d * 230.0, q = floor(p), f = p - q - 0.5;
    float h = hash(q.xy + q.z * 37.17), h2 = fract(h * 91.7);
    float r = length(f + (vec3(h2, fract(h * 13.3), fract(h * 57.1)) - 0.5) * 0.5);
    return step(0.93, h) * smoothstep(0.28, 0.03, r) * (0.04 + 0.5 * h2 * h2 * h2);
  }

  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 rd = normalize(uFwd + ndc.x * uTan.x * uRight + ndc.y * uTan.y * uUp);
    float cosF = dot(rd, uFwd);
    float d = texture2D(tDepth, vUv).r;
    vec4 sc = texture2D(tColor, vUv);   // alpha < 1 marks what must stay visible over the sea (OverlaySource.aboveWater)
    vec3 col = sc.rgb;
    bool sky = d >= 0.9999999;
    // linear view depth -> distance along the ray (no inverse projection: exact enough from 2 m to 500 km up)
    float tScene = sky ? 1e12 : (uNear * uFar / (uFar - d * (uFar - uNear))) / cosF;
    float outDepth = d;

    // ray x paraboloid: a t^2 + b t + c = 0, smallest positive root in the cancellation-free form
    float a = dot(rd.xz, rd.xz) * (0.5 / R);
    float b = rd.y + dot(uOR, rd.xz);
    float disc = b * b - 4.0 * a * uCamH;
    float tW = 2.0 * uCamH / (-b + sqrt(max(disc, 0.0)));
    // what the depth buffer and the terrain mesh can tell apart at this distance: closer than this to sea level, the
    // seabed's depth is unknown (it must not flicker between wet and dry, or foam, pixel by pixel)
    float eps = min(0.03 + tW * 1.2e-4, 2.0);
    // (rays that miss the sea by less than 0.04 degrees still count: no sliver of below-horizon sky between sea and sky)
    bool water = uOcean > 0.5 && uCamH > 0.0 && b < 0.0 && (disc > 0.0 || (b - 7e-4) * (b - 7e-4) > 4.0 * a * uCamH) && tW < tScene + eps;

    if (water) {
      vec2 rel = rd.xz * tW;                         // hit point, relative to the camera
      vec2 pxz = uCamPos.xz + rel;
      vec3 n0 = normalize(vec3(pxz.x / R, 1.0, pxz.y / R));
      float cosI0 = max(-dot(rd, n0), 1e-3);
      float fp = tW * uPix / pow(cosI0, 0.8);         // pixel footprint on the water, metres (long axis, nearly)

      // ---- waves: resolved scales tilt the normal, unresolved ones widen the slope distribution
      vec2 slope = vec2(0.0);
      float resid = uMss * 0.30;                     // capillaries: never resolved
      for (int i = 0; i < ${N_OCT}; i++) {
        float w = clamp((uOct[i].x / fp - 3.0) / 6.0, 0.0, 1.0);   // gone below 3 px per wavelength, whole above 9
        if (w > 0.0) {
          // wave groups: each scale comes and goes in patches a few wavelengths across (cells divide 4096 m, so the
          // pattern is seamless when the camera's wrapped position rolls over)
          float cell = 4096.0 / exp2(floor(log2(4096.0 / (uOct[i].x * 3.5)) + 0.5));
          float grp = 0.35 + 1.3 * vnoise((uWrap + rel) / cell + float(i) * 7.3, 4096.0 / cell);
          vec2 so = vec2(0.0);
          for (int j = 0; j < ${N_PER}; j++) {
            vec4 wv = uWave[i * ${N_PER} + j];
            so += (wv.w * cos(dot(wv.xy, rel) + wv.z)) * normalize(wv.xy);
          }
          slope += w * grp * so;
        }
        resid += uOct[i].y * (1.0 - w * w);
      }
      vec3 n = normalize(vec3(pxz.x / R - slope.x, 1.0, pxz.y / R - slope.y));
      vec3 v = -rd;
      float nv = max(dot(n, v), 1e-3);

      // ---- water column: straight-line path to the seabed, then the refracted one over a locally flat bottom
      float pathView = max(tScene - tW, 0.0);
      float dV = pathView * cosI0;                   // depth of the seabed below the surface
      float cosT = sqrt(1.0 - (1.0 - cosI0 * cosI0) / (N_W * N_W));
      float sunT = sqrt(1.0 - (1.0 - uLightDir.y * uLightDir.y) / (N_W * N_W));
      float pathW = dV / cosT;
      // enclosed, very shallow water is a little turbid; open water is Jerlov IB
      vec3 K = uK * (1.0 + 0.6 * exp(-dV / 3.0));
      vec3 att = exp(-K * (pathW + dV / max(sunT, 0.3)));
      vec3 deep = uDeepR * uEd * uDeepGain;          // radiance leaving optically deep water, just below the surface
      vec3 Lw = col * att + deep * (1.0 - exp(-K * (pathW + dV) * 0.5));
      if (sky) Lw = deep;
      // Scenario water over what is land today (ground above present sea level, under the raised one): clear
      // water a few decimetres deep would be invisible over the photo, so it is drawn as an opaque-ish blue wash.
      // A map convention, not optics: it marks the bathtub extent the Scenario panel counts.
      float flood = step(0.05, uRise) * (1.0 - smoothstep(uRise - 0.30, uRise - 0.12, dV)) * smoothstep(eps, eps + 0.05, dV) * (sky ? 0.0 : 1.0);
      Lw = mix(Lw, vec3(0.055, 0.26, 0.50) * (uEd.g * 1.6 + 0.02), 0.72 * flood);

      // ---- reflection
      float F = fresnelAir(nv) * avgFresnelScale(nv, resid);
      vec3 r = reflect(rd, n);
      float rUp = dot(r, n0);
      if (rUp < 0.0) { r -= 2.0 * rUp * n0; rUp = -rUp; }
      // a rough sea reflects sky from higher up than a mirror would: the horizon line softens
      vec3 Ls = skyRad(r, rUp + 1.2 * sqrt(resid) * (1.0 - rUp));

      // ---- sun glitter: Beckmann distribution of the unresolved slopes about the resolved normal
      vec3 h = normalize(uLightDir + v);
      float nh = max(dot(n, h), 1e-4), nl = max(dot(n, uLightDir), 0.0), vh = max(dot(v, h), 1e-4);
      float s2 = max(resid, 2e-4);
      float t2 = (1.0 - nh * nh) / (nh * nh);
      float D = exp(-t2 / s2) / (PI * s2 * nh * nh * nh * nh);
      float G = min(1.0, min(2.0 * nh * nv / vh, 2.0 * nh * nl / vh));
      vec3 glint = uLightE * (fresnelAir(vh) * D * G / (4.0 * max(nv, 0.02))) * step(0.0, uLightDir.y);
      glint = min(glint, vec3(60.0));

      // ---- foam: lace at the waterline, breakers over the shallows, whitecaps in wind
      float near1 = clamp(1.6 / fp - 0.6, 0.0, 1.0);  // lace (cells ~1.8 m) resolved? otherwise its mean
      float lc = mix(0.32, lace((uWrap + rel) * 0.55, uTime), near1);
      float band = fwidth(dV);
      float flat0 = 1.0 - smoothstep(eps, 2.5 * eps, dV);     // seabed indistinguishable from sea level
      // ... and the photo there shows water (terrain tiles without bathymetry): the photo is then the water's own colour,
      // and it gets the surface (reflection, glitter) but no absorption and no foam
      float photoSea = flat0 * smoothstep(0.02, 0.12, (col.b - col.r) / max(col.b + col.r, 1e-3));
      float edge = (1.0 - smoothstep(0.02, 0.45, dV)) * clamp(0.45 / max(band, 1e-3), 0.0, 1.0) * (1.0 - flat0) * clamp(3.0 / fp - 0.5, 0.0, 1.0);
      float surfD = 0.6 + 1.2 * uWaveH;
      float surf = (1.0 - smoothstep(0.25 * surfD, surfD, dV)) * clamp(surfD / max(band, 1e-3), 0.0, 1.0) * (1.0 - flat0) * clamp(12.0 / fp - 0.5, 0.0, 1.0);
      float cap = clamp(3.84e-6 * pow(max(uWindMs, 0.0), 3.41), 0.0, 0.25) * smoothstep(6.0, 9.0, uWindMs);
      float capN = mix(cap, smoothstep(1.0 - 2.5 * cap, 1.0, vnoise((uWrap + rel) * 0.045 + uTime * 0.02, 64.0)) * lc * 2.2, clamp(3.0 / fp - 1.0, 0.0, 1.0));   // the crests are a few metres across: unresolved, they are only their mean whiteness
      float foam = clamp(edge * (0.35 + 0.65 * lc) * 0.75 + surf * lc * 0.5 + capN, 0.0, 0.9);
      foam *= smoothstep(eps, 2.0 * eps + 0.03, dV);

      float wet = max(smoothstep(eps, eps + 0.06, dV), photoSea);   // the film at the very edge neither mirrors nor glitters
      vec3 sea = Lw * (1.0 - F) / (N_W * N_W) * mix(1.0, N_W * N_W / max(1.0 - F, 0.05), 1.0 - wet) * mix(1.0, N_W * N_W, photoSea) + (Ls * F + glint) * wet;
      col = mix(sea, uEd * 0.82, foam);
      col = mix(col, sc.rgb, clamp(1.0 - sc.a, 0.0, 1.0));
      float vz = tW * cosF;
      outDepth = clamp(uFar * (1.0 - uNear / vz) / (uFar - uNear), 0.0, 0.999999);
      sky = false;
    }

    if (uOrbit > 0.001 && !sky) {
      const float CLOUD_H = 2200.0;
      float hc = uCamH - CLOUD_H, dc = b * b - 4.0 * a * hc;
      if (hc > 0.0 && b < 0.0 && dc > 0.0) {
        float tC = 2.0 * hc / (-b + sqrt(dc)), tG = water ? tW : tScene;
        vec2 gp = uCamPos.xz + rd.xz * tG;
        vec2 toSun = uLightDir.xz / max(uLightDir.y, 0.2);
        // the shadow on the sea and the land beneath: two taps along the light, so it is softer than the cloud that casts it
        float sh = 0.6 * cloud2D(gp + toSun * CLOUD_H) + 0.4 * cloud2D(gp + toSun * (CLOUD_H + 900.0) + 700.0);
        col *= 1.0 - uCloud2.z * uOrbit * sh;
        if (tC < tG) {
          vec2 cp = uCamPos.xz + rd.xz * tC, sd = normalize(uLightDir.xz + 1e-4);
          float cv = cloud2D(cp);
          if (cv > 0.002) {
            // shading from the sun's side: thinner toward the sun = a lit flank, thicker toward it = in the cloud's own shade;
            // thick tops are mottled, thin edges take the colour of what is under them
            float g = cv - 0.5 * (cloud2D(cp + sd * 900.0) + cloud2D(cp + sd * 2600.0));
            float low = clamp(uLightDir.y * 2.5, 0.25, 1.0);
            float bump = vnoise(cp / 520.0 + 3.0, 4096.0) - 0.5;
            float lit = clamp(0.70 + 1.5 * g / low - 0.16 * cv * cv + 0.22 * bump * cv, 0.0, 1.0);
            vec3 cc = uEd * 0.86 * mix(vec3(0.46, 0.53, 0.66), vec3(1.0), lit);
            col = mix(col, cc, pow(cv, 1.25) * uOrbit * 0.95);
          }
        }
      }
    }
    if (sky) col = (skyRad(rd, rd.y + sqrt(max(2.0 * uCamH / R, 0.0))) + vec3(stars(rd)) * smoothstep(-0.02, 0.08, rd.y) * uNight) * uNight;   // night sky and stars: the aerial effect adds its sky to this
    if (uBasic > 0.5) { // fallback: analytic sky and haze, when the physical atmosphere is not running
      if (sky) {
        col = mix(skyRad(rd, rd.y + sqrt(max(2.0 * uCamH / R, 0.0))), col, uNight * uNight);
        col += uLightE * 40.0 * smoothstep(0.99996, 0.99999, dot(rd, uSunDir));
      } else {
        float t = min(tScene, water ? tW : tScene);
        float f = 1.0 - exp(-t * clamp(8000.0 / max(uCamH, 8000.0), 0.0, 1.0) / 160000.0);   // only the lowest ~8 km of the path is hazy
        col = mix(col, uHor * 0.8 + uZen * 0.2, f * 0.85);
      }
    }
    if (uDbgAlpha > 0.5) col = vec3(step(0.004, abs(1.0 - sc.a))) * 3.0;   // ?alpha=1: white wherever the scene wrote alpha != 1
    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    gl_FragDepth = outDepth;
  }
`;

export interface OceanInputs {
  seaLevel: number; time: number; windMs: number; windDirDeg: number; waveH: number; wavePeriod: number; waveDirDeg: number;
}

export class SceneOceanPass extends Pass {
  readonly target: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  private srcScene: THREE.Scene;
  private srcCamera: THREE.PerspectiveCamera;
  overWater = false;
  private height = 1;
  private seed: Float32Array;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    super('SceneOceanPass');
    this.srcScene = scene; this.srcCamera = camera;
    this.needsSwap = false;
    (this as any).needsDepthBlit = true;   // the composer copies this buffer's depth to the texture the effects read
    const depthTexture = new THREE.DepthTexture(1, 1);
    depthTexture.type = THREE.UnsignedIntType;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture, depthBuffer: true, stencilBuffer: false, samples: 0 });
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.NearestFilter;
    const v3 = () => new THREE.Vector3();
    this.uniforms = {
      tColor: { value: this.target.texture }, tDepth: { value: depthTexture },
      uNear: { value: 1 }, uFar: { value: 1e6 }, uCamH: { value: 100 }, uTime: { value: 0 }, uPix: { value: 0.001 },
      uOcean: { value: 1 }, uBasic: { value: 0 }, uMss: { value: 0.03 }, uWindMs: { value: 6 }, uWaveH: { value: 1 }, uNight: { value: 0 }, uDeepGain: { value: 1 }, uRise: { value: 0 },
      uOrbit: { value: 0 }, uDbgAlpha: { value: 0 }, uCloud2: { value: new THREE.Vector4(0.60, 0.24, 0.62, 0) },
      uTan: { value: new THREE.Vector2(1, 1) }, uOR: { value: new THREE.Vector2() }, uWrap: { value: new THREE.Vector2() },
      uCamPos: { value: v3() }, uRight: { value: v3() }, uUp: { value: v3() }, uFwd: { value: v3() },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uLightE: { value: new THREE.Vector3(3, 3, 3) }, uEd: { value: new THREE.Vector3(1, 1, 1) },
      uK: { value: new THREE.Vector3(0.370, 0.072, 0.035) },        // Jerlov IB diffuse attenuation, 1/m
      uDeepR: { value: new THREE.Vector3(0.0005, 0.0092, 0.019) },  // Jerlov IB deep-water reflectance
      uWave: { value: Array.from({ length: N_WAVES }, () => new THREE.Vector4(1, 0, 0, 0)) },
      uOct: { value: Array.from({ length: N_OCT }, () => new THREE.Vector2(1, 0)) },
      uZen: { value: v3() }, uHor: { value: v3() }, uGlow: { value: v3() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    };
    this.material = new THREE.ShaderMaterial({
      name: 'GaritaOcean', uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth, toneMapped: false,
    });
    this.fullscreenMaterial = this.material;
    // fixed per-wave randomness: direction offset, wavelength factor, phase
    this.seed = new Float32Array(N_WAVES * 3);
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    for (let i = 0; i < this.seed.length; i++) this.seed[i] = rnd();
  }

  /** Per-frame uniforms. Phases are computed here in double precision relative to the camera, so that short waves stay stable 200 km from the origin. */
  update(inp: OceanInputs): void {
    const u = this.uniforms, cam = this.srcCamera, e = cam.matrixWorld.elements, p = cam.position;
    (u.uRight.value as THREE.Vector3).set(e[0], e[1], e[2]).normalize();
    (u.uUp.value as THREE.Vector3).set(e[4], e[5], e[6]).normalize();
    (u.uFwd.value as THREE.Vector3).set(-e[8], -e[9], -e[10]).normalize();
    (u.uCamPos.value as THREE.Vector3).copy(p);
    const th = Math.tan(cam.fov * Math.PI / 360);
    (u.uTan.value as THREE.Vector2).set(th * cam.aspect, th);
    u.uPix.value = 2 * th / this.height;
    u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uCamH.value = p.y - inp.seaLevel + (p.x * p.x + p.z * p.z) / (2 * R_EARTH);
    (u.uOR.value as THREE.Vector2).set(p.x / R_EARTH, p.z / R_EARTH);
    (u.uWrap.value as THREE.Vector2).set(((p.x % 4096) + 4096) % 4096, ((p.z % 4096) + 4096) % 4096);
    u.uTime.value = inp.time % 3600;
    const U = Math.max(0.5, inp.windMs);
    const mss = 0.003 + 0.00512 * U;                               // Cox & Munk 1954
    u.uMss.value = mss; u.uWindMs.value = U; u.uWaveH.value = inp.waveH;
    // octave 0 is the swell (period and height from the feed); 1..5 are the wind sea down to ~0.6 m
    const L0 = Math.min(260, Math.max(30, 1.56 * inp.wavePeriod * inp.wavePeriod));
    const swellSlope = Math.PI * inp.waveH * 0.5 / L0;             // a k for an amplitude of Hs / 4 per component pair
    const swellMss = Math.min(mss * 0.2, swellSlope * swellSlope * 0.5);
    const shares = [0, 0.11, 0.15, 0.19, 0.25, 0.30];
    const oct = u.uOct.value as THREE.Vector2[], waves = u.uWave.value as THREE.Vector4[];
    const windTo = (inp.windDirDeg + 180) * Math.PI / 180, swellTo = (inp.waveDirDeg + 180) * Math.PI / 180;
    let lam = L0;
    for (let i = 0; i < N_OCT; i++) {
      const share = i === 0 ? swellMss : mss * 0.70 * shares[i];
      oct[i].set(lam, share);
      const amp = Math.sqrt(2 * share / N_PER);
      const spread = i === 0 ? 0.5 : 1.5 + 0.3 * i;                // radians, total: short waves are nearly isotropic
      for (let j = 0; j < N_PER; j++) {
        const q = (i * N_PER + j) * 3;
        const ang = (i === 0 ? swellTo : windTo) + (this.seed[q] - 0.5) * spread;
        const l = lam * (0.58 + 1.05 * this.seed[q + 1]);            // bands overlap: no two components share a lattice
        const k = 2 * Math.PI / l, kx = Math.sin(ang) * k, kz = -Math.cos(ang) * k;   // bearing -> (east, south)
        const omega = Math.sqrt(9.81 * k);
        const ph = (kx * p.x + kz * p.z - omega * inp.time + this.seed[q + 2] * 6.2832) % 6.283185307179586;
        waves[i * N_PER + j].set(kx, kz, ph, amp * (0.6 + 0.8 * this.seed[(q + 7) % this.seed.length]));
      }
      lam /= 2.7;
    }
  }

  override render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget): void {
    renderer.setRenderTarget(this.target);
    renderer.clear(true, true, false);
    renderer.render(this.srcScene, this.srcCamera);
    renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
    renderer.render(this.scene, this.camera);
    if (this.overWater) {   // meshes on OVER_WATER_LAYER: drawn after the sea, depth-tested against land and water
      const cam = this.srcCamera, mask = cam.layers.mask, auto = renderer.autoClear, bg = this.srcScene.background;
      cam.layers.set(OVER_WATER_LAYER); renderer.autoClear = false; this.srcScene.background = null;
      renderer.render(this.srcScene, cam);
      cam.layers.mask = mask; renderer.autoClear = auto; this.srcScene.background = bg;
    }
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(Math.max(1, width), Math.max(1, height));
    this.height = Math.max(1, height);
  }

  override dispose(): void { this.target.dispose(); this.material.dispose(); super.dispose(); }
}
