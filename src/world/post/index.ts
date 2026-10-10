// Everything between "geometry is in the scene" and "pixels on screen": sun and moon, scene lights, sky, aerial
// perspective, clouds, the ocean, bloom, tone mapping, anti-aliasing.
//
// Chain:  scene + ocean (ocean.ts)  ->  x UNITS  ->  clouds + aerial perspective (takram)  ->  x exposure / UNITS
//         ->  bloom + tone mapping  ->  SMAA + dither.
// If the physical atmosphere cannot run (set-up throws, a shader fails, ?post=basic) the ocean pass draws an
// analytic sky and haze instead and the rest of the chain is unchanged; if even that fails, a plain render.
import * as THREE from 'three';
import { EffectComposer, EffectPass, Effect, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, SMAAPreset } from 'postprocessing';
import { AerialPerspectiveEffect, PrecomputedTexturesGenerator, getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere';
import { CloudsEffect, CLOUD_SHAPE_TEXTURE_SIZE, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE } from '@takram/three-clouds';
import { DataTextureLoader, Ellipsoid, Geodetic, parseUint8Array, radians, STBNLoader } from '@takram/three-geospatial';
import * as S from '../../core/state';
import { ORIGIN } from '../../core/geo.ts';
import { dataUrl, params } from '../../core/config';
import type { Frame, PostApi, World } from '../types';
import { SceneOceanPass, SKY_GLSL } from './ocean';

// Scene lights by sun elevation (after procedural-sanjuan's tables). A sunlit white wall is about 1 in scene units.
const DAY = { hemi: 0.45, sun: 3.4, sunColor: new THREE.Color(0xfff0dc), exposure: 0.9, bloom: 0.25 };
const NIGHT = { hemi: 0.10, sun: 0.17, sunColor: new THREE.Color(0x9fb4e0), exposure: 3.0, bloom: 0.4 };
const SUNSET = new THREE.Color(0xff9a52);
// Scene radiance -> the atmosphere's units. The takram sun delivers solarIrradiance (1.47, 1.85, 1.91) x transmittance
// (about 0.8 at noon) on the ground, so its sunlit white wall is ~1.43 / pi; ours is DAY.sun / pi.
const UNITS = +(params.get('units') ?? 0) || 1.43 / DAY.sun;
const SHADE = 0.45;   // what is left of a surface's light under a thick cloud
const ASSETS = 'assets-static/takram';
const off = (name: string) => params.get(name) === '0';

class Scale extends Effect {
  constructor(k: number) {
    super('Scale', 'uniform float k; void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) { outputColor = vec4(min(inputColor.rgb * k, vec3(48.0)), inputColor.a); }',  // (capped: the sun's disc would otherwise bloom into a white blob)
      { uniforms: new Map([['k', new THREE.Uniform(k)]]) });
  }
  set k(v: number) { this.uniforms.get('k')!.value = v; }
}

type Mode = 'takram' | 'basic' | 'plain';

export function createPost(world: World): PostApi {
  const { renderer, scene, camera } = world;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1;
  let mode: Mode = 'basic';
  let lutsReady = false, shaderFailed = false, oceanFailed = false, warned = false, wantTakram = params.get('post') !== 'basic' && !off('aerial');
  const warn = (why: unknown) => { if (!warned) { warned = true; console.warn('[garita/post] physical atmosphere unavailable, using the analytic sky fallback:', why); } };

  // ---- lights (owned here)
  const sun = new THREE.DirectionalLight(0xffffff, DAY.sun);
  const hemi = new THREE.HemisphereLight(0xcfe2ff, 0x6b6456, DAY.hemi);
  scene.add(sun, sun.target, hemi);
  const lightDir = new THREE.Vector3(0, 1, 0);
  const st = { elevation: 45, dark: 0, daylight: 1, moonlight: 0, warmth: 0, exposure: DAY.exposure, bloom: DAY.bloom };

  // ---- where the scene sits on the globe: world (east, up, south) -> ECEF
  const ecef = new Geodetic(radians(ORIGIN.lon), radians(ORIGIN.lat), 0).toECEF();
  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  Ellipsoid.WGS84.getEastNorthUpVectors(ecef, east, north, up);
  const worldToECEF = new THREE.Matrix4().makeBasis(east, up, north.clone().negate()).setPosition(ecef);
  const toWorld = new THREE.Matrix3().setFromMatrix4(worldToECEF).transpose();
  const sunE = new THREE.Vector3(), moonE = new THREE.Vector3(), date = new Date();

  // ---- passes
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  const ocean = new SceneOceanPass(scene, camera);
  ocean.uniforms.uOcean.value = off('ocean') ? 0 : 1;
  ocean.uniforms.uDeepGain.value = +(params.get('deep') ?? 2.0);
  composer.addPass(ocean);
  const scaleIn = new Scale(UNITS), scaleOut = new Scale(1);
  const scaleInPass = new EffectPass(camera, scaleIn);

  let aerial: any = null, plain: any = null, clouds: any = null, cloudPass: EffectPass | null = null, skyPass: EffectPass | null = null;
  const wantClouds = !off('clouds');
  if (wantTakram) {
    try {
      const patch = (fx: any) => { // clouds shade the ground although the scene keeps its own lights
        const hook = 'radiance = inputColor.rgb;\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)';
        const src: string = fx.getFragmentShader();
        if (src.includes(hook)) fx.setFragmentShader(src.replace(hook, `radiance = inputColor.rgb * mix(${SHADE.toFixed(2)}, 1.0, sunTransmittance);\n  #endif // defined(SUN_LIGHT) || defined(SKY_LIGHT)`));
      };
      const make = () => {
        const fx: any = new AerialPerspectiveEffect(camera);
        fx.sky = true; fx.sun = true; fx.moon = true; fx.ground = false;
        fx.worldToECEFMatrix.copy(worldToECEF);
        return fx;
      };
      plain = make();
      const generator = new PrecomputedTexturesGenerator(renderer);
      generator.update().then(() => { lutsReady = true; }).catch((e: unknown) => { wantTakram = false; warn(e); });
      Object.assign(plain, generator.textures);
      composer.addPass(scaleInPass);
      if (wantClouds) {
        aerial = make(); patch(aerial);
        Object.assign(aerial, generator.textures);
        clouds = new CloudsEffect(camera);
        clouds.worldToECEFMatrix.copy(worldToECEF);
        clouds.localWeatherVelocity.set(0.0006, 0.0002);
        Object.assign(clouds, generator.textures);
        const pass = (property: string) => {
          if (property === 'atmosphereOverlay') aerial.overlay = clouds.atmosphereOverlay;
          else if (property === 'atmosphereShadow') aerial.shadow = clouds.atmosphereShadow;
          else if (property === 'atmosphereShadowLength') aerial.shadowLength = clouds.atmosphereShadowLength;
        };
        clouds.events.addEventListener('change', (e: any) => pass(e.property));
        const repeat = (t: THREE.Texture) => { t.minFilter = THREE.LinearMipMapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; };
        const volume = (size: number) => new (DataTextureLoader as any)(THREE.Data3DTexture, parseUint8Array, {
          width: size, height: size, depth: size, format: THREE.RedFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, wrapR: THREE.RepeatWrapping, colorSpace: THREE.NoColorSpace,
        });
        clouds.localWeatherTexture = new THREE.TextureLoader().load(dataUrl(`${ASSETS}/local_weather.png`), repeat);
        clouds.turbulenceTexture = new THREE.TextureLoader().load(dataUrl(`${ASSETS}/turbulence.png`), repeat);
        clouds.shapeTexture = volume(CLOUD_SHAPE_TEXTURE_SIZE).load(dataUrl(`${ASSETS}/shape.bin`));
        clouds.shapeDetailTexture = volume(CLOUD_SHAPE_DETAIL_TEXTURE_SIZE).load(dataUrl(`${ASSETS}/shape_detail.bin`));
        const stbn = new STBNLoader().load(dataUrl(`${ASSETS}/stbn.bin`));
        clouds.stbnTexture = stbn; aerial.stbnTexture = stbn; plain.stbnTexture = stbn;
        cloudPass = new EffectPass(camera, clouds, aerial);
        cloudPass.enabled = false;
        composer.addPass(cloudPass);
        (['atmosphereOverlay', 'atmosphereShadow', 'atmosphereShadowLength']).forEach(pass);
      }
      skyPass = new EffectPass(camera, plain);
      composer.addPass(skyPass);
    } catch (e) { wantTakram = false; warn(e); }
  }
  composer.addPass(new EffectPass(camera, scaleOut));
  const bloom = new BloomEffect({ intensity: DAY.bloom, luminanceThreshold: 1.0, luminanceSmoothing: 0.35, mipmapBlur: true, radius: 0.7 });
  const tone = new ToneMappingEffect({ mode: params.get('tm') === 'aces' ? ToneMappingMode.ACES_FILMIC : params.get('tm') === 'neutral' ? ToneMappingMode.NEUTRAL : ToneMappingMode.AGX });
  composer.addPass(new EffectPass(camera, bloom, tone));
  const aaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }));
  (aaPass as any).dithering = true;
  composer.addPass(aaPass);

  const prevOnShaderError = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    shaderFailed = true;
    if ((gl.getShaderSource(fs) || '').includes('uDeepGain')) oceanFailed = true;
    console.warn('[garita/post] shader failed:', (gl.getProgramInfoLog(program) || '').slice(0, 300), (gl.getShaderInfoLog(fs) || '').slice(0, 600), (gl.getShaderInfoLog(vs) || '').slice(0, 300));
  };

  // ---- environment map: the analytic sky, re-baked when the sun has moved
  const pmrem = new THREE.PMREMGenerator(renderer);
  const skyU = ocean.uniforms;
  const envMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false, toneMapped: false,
    uniforms: { uZen: skyU.uZen, uHor: skyU.uHor, uGlow: skyU.uGlow, uSunDir: skyU.uSunDir },
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir; ${SKY_GLSL} void main() { vec3 d = normalize(vDir); vec3 c = d.y >= 0.0 ? skyRad(d, d.y) : mix(uHor, vec3(0.02, 0.05, 0.07), smoothstep(0.0, -0.25, d.y)); gl_FragColor = vec4(c, 1.0); }`,
  });
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envMat));
  const bakedSun = new THREE.Vector3(0, -2, 0);
  let envRT: THREE.WebGLRenderTarget | null = null;
  const bakeEnv = () => {
    const old = envRT;
    envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
    scene.environment = envRT.texture;
    old?.dispose();
    bakedSun.copy(world.sunDir);
  };

  const sstep = THREE.MathUtils.smoothstep, lerp = THREE.MathUtils.lerp;
  const cDayZen = new THREE.Vector3(0.050, 0.115, 0.30), cDayHor = new THREE.Vector3(0.34, 0.42, 0.53);
  const cDuskZen = new THREE.Vector3(0.022, 0.040, 0.105), cDuskHor = new THREE.Vector3(0.46, 0.27, 0.13);
  const cNightZen = new THREE.Vector3(0.0022, 0.0034, 0.0075), cNightHor = new THREE.Vector3(0.0050, 0.0066, 0.0110);
  const tmpC = new THREE.Color();

  function setTime(epochMs: number): void {
    date.setTime(epochMs);
    getSunDirectionECEF(date, sunE);
    getMoonDirectionECEF(date, moonE);
    world.sunDir.copy(sunE).applyMatrix3(toWorld).normalize();
    world.moonDir.copy(moonE).applyMatrix3(toWorld).normalize();
    for (const fx of [aerial, plain]) if (fx) { fx.sunDirection.copy(sunE); fx.moonDirection.copy(moonE); }
    if (clouds) clouds.sunDirection.copy(sunE);

    const deg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(world.sunDir.y, -1, 1)));
    st.elevation = deg;
    st.dark = 1 - sstep(deg, -13, 5);
    st.daylight = sstep(deg, -5, 9);
    st.moonlight = 1 - sstep(deg, -14, -5.5);
    st.warmth = 1 - sstep(deg, 3, 24);
    world.night = st.dark;
    const moonUp = sstep(world.moonDir.y, 0.0, 0.25);
    if (deg > -5.5) lightDir.copy(world.sunDir).setY(Math.max(world.sunDir.y, 0.03)).normalize();
    else if (world.moonDir.y > 0.02) lightDir.copy(world.moonDir);
    else lightDir.set(0.3, 0.8, 0.5).normalize();
    // the low sun is dimmer as well as warmer: more air in the way
    const airmass = sstep(deg, -2, 30);
    sun.intensity = DAY.sun * st.daylight * (0.35 + 0.65 * airmass) + NIGHT.sun * st.moonlight * (0.25 + 0.75 * moonUp);
    sun.color.copy(DAY.sunColor).lerp(SUNSET, st.warmth * 0.85).lerp(NIGHT.sunColor, st.moonlight);
    hemi.intensity = lerp(DAY.hemi, NIGHT.hemi, st.dark);
    st.exposure = lerp(DAY.exposure, NIGHT.exposure, st.dark) * (1 + 0.25 * st.warmth * (1 - st.dark));
    st.bloom = lerp(DAY.bloom, NIGHT.bloom, st.dark);
    bloom.intensity = st.bloom;

    // analytic sky colours (scene units) for the water's reflection, the environment map and the fallback sky
    const u = ocean.uniforms, dusk = st.warmth * (1 - sstep(deg, 8, 24) * 0.6), day = 0.25 + 0.75 * sstep(deg, -4, 20);
    (u.uZen.value as THREE.Vector3).copy(cDayZen).lerp(cDuskZen, dusk).multiplyScalar(day).lerp(cNightZen, st.dark);
    (u.uHor.value as THREE.Vector3).copy(cDayHor).lerp(cDuskHor, dusk * 0.8).multiplyScalar(day).lerp(cNightHor, st.dark);
    tmpC.copy(sun.color).multiplyScalar(sun.intensity);
    (u.uGlow.value as THREE.Vector3).set(tmpC.r, tmpC.g, tmpC.b).multiplyScalar(0.22 * st.daylight);
    (u.uSunDir.value as THREE.Vector3).copy(world.sunDir);
    (u.uLightDir.value as THREE.Vector3).copy(lightDir);
    (u.uLightE.value as THREE.Vector3).set(tmpC.r, tmpC.g, tmpC.b);
    const zen = u.uZen.value as THREE.Vector3, hor = u.uHor.value as THREE.Vector3, k = Math.max(lightDir.y, 0) / Math.PI;
    (u.uEd.value as THREE.Vector3).set(tmpC.r * k + 0.5 * (zen.x + hor.x), tmpC.g * k + 0.5 * (zen.y + hor.y), tmpC.b * k + 0.5 * (zen.z + hor.z));
    u.uNight.value = st.dark;
    if (bakedSun.angleTo(world.sunDir) > 0.035) bakeEnv();
  }

  function applyMode(next: Mode): void {
    mode = next;
    const tk = next === 'takram';
    const q = S.quality.value;
    const cloudsOn = tk && !!cloudPass && q !== 'low' && S.layerOn.value.clouds !== false;
    scaleInPass.enabled = tk;
    if (cloudPass) cloudPass.enabled = cloudsOn;
    if (skyPass) skyPass.enabled = tk && !cloudsOn;
    ocean.uniforms.uBasic.value = tk ? 0 : 1;
  }
  applyMode('basic');

  let lastQuality = '', lastCover = -1;
  const oin = { seaLevel: 0, time: 0, windMs: 6, windDirDeg: 80, waveH: 1.2, wavePeriod: 8, waveDirDeg: 60 };   // reused: nothing allocates per frame
  function render(frame: Frame): void {
    if (mode === 'plain') { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
    if (shaderFailed) {
      shaderFailed = false;
      if (!oceanFailed && wantTakram) { wantTakram = false; warn('shader compile error'); applyMode('basic'); }
      else { mode = 'plain'; scene.background = new THREE.Color(0x7fa8cf); console.warn('[garita/post] ocean pass failed too: plain render'); return; }
    }
    const want: Mode = wantTakram && lutsReady ? 'takram' : 'basic';
    const q = S.quality.value, cover = S.weather.value.cloudCover;
    if (want !== mode || q !== lastQuality) {
      lastQuality = q;
      if (clouds) clouds.qualityPreset = q === 'high' ? 'high' : 'medium';
      bloom.blendMode.opacity.value = q === 'low' ? 0.6 : 1;
      applyMode(want);
    }
    if (clouds && cover !== lastCover) { lastCover = cover; clouds.coverage = THREE.MathUtils.clamp(0.12 + 0.62 * cover, 0, 0.9); }
    scaleOut.k = mode === 'takram' ? st.exposure / UNITS : st.exposure;
    sun.target.position.copy(world.controls?.target ?? sun.target.position);
    sun.position.copy(sun.target.position).addScaledVector(lightDir, 1e5);
    const w = S.weather.value;
    oin.seaLevel = world.seaLevel; oin.time = frame.now; oin.windMs = w.windMs; oin.windDirDeg = w.windDirDeg;
    oin.waveH = w.waveHeightM; oin.wavePeriod = w.wavePeriodS; oin.waveDirDeg = w.waveDirDeg;
    ocean.update(oin);
    try { composer.render(frame.dt); }
    catch (e) { if (mode === 'takram') { wantTakram = false; warn(e); applyMode('basic'); } else { mode = 'plain'; console.warn('[garita/post] render failed: plain render', e); } }
  }

  setTime(S.sceneTime.value);
  bakeEnv();

  return {
    render,
    resize(width, height, dpr) { renderer.setPixelRatio(dpr); composer.setSize(width, height, false); },
    setTime,
    setSeaLevel(m) { world.seaLevel = m; },
    dispose() {
      renderer.debug.onShaderError = prevOnShaderError;
      scene.remove(sun, sun.target, hemi);
      scene.environment = null; envRT?.dispose(); pmrem.dispose();
      composer.dispose();
    },
    // not part of PostApi: for the test page
    ...({ debug: () => ({ mode, lutsReady, clouds: !!cloudPass?.enabled, units: UNITS, ...st, sun: world.sunDir.toArray().map((v) => +v.toFixed(3)) }) } as object),
  };
}
