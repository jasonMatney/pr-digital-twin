// The one raster overlay draped on the terrain (S.overlay): live rain radar, GOES-East, FEMA flood zones, NOAA sea
// level rise mapping, a municipio choropleth drawn in the browser, or the terrain's own elevation tint.
// Every overlay publishes a legend (S.overlayLegend) that says what is shown, for when, and who publishes it.
import { effect, signal, untracked } from '@preact/signals';
import * as S from '../core/state';
import { AST_OFFSET_H, ORIGIN, latToTileY, lonToTileX, tileLat, tileLon } from '../core/geo.ts';
import type { LayerFactory } from './layers';
import type { OverlaySource } from './types';
import { DERIVED_SFHA, NO_DATA, choroplethDef, choroplethValues, formatValue, loadMunicipios, makeChoropleth } from './choropleth';

const tr = (en: string, es: string) => (S.lang.value === 'es' ? es : en);
const ast = (ms: number) => { const d = new Date(ms + AST_OFFSET_H * 3600000); return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} AST`; };
const HALF = 20037508.342789244;

// RainViewer "Universal Blue" (colour scheme 2), as listed at rainviewer.com/api/color-schemes.html.
const RV_STOPS: [number, string][] = [[15, '#88ddee'], [20, '#0099cc'], [25, '#0077aa'], [30, '#005588'], [35, '#ffee00'], [40, '#ffaa00'], [45, '#ff7700'], [50, '#ff4400'], [55, '#ee0000'], [60, '#990000'], [65, '#ffaaff']];
// Below the first listed stop RainViewer shades weak echoes from transparent grey to tan (to be checked against the page above).
const RV_WEAK = '#cec087';
// NWS base reflectivity colours used by the Iowa Environmental Mesonet N0Q tiles.
const NWS_STOPS: [number, string][] = [[5, '#04e9e7'], [10, '#019ff4'], [15, '#0300f4'], [20, '#02fd02'], [25, '#01c501'], [30, '#008e00'], [35, '#fdf802'], [40, '#e5bc00'], [45, '#fd9500'], [50, '#fd0000'], [55, '#d40000'], [60, '#bc0000'], [65, '#f800fd']];
const dbz = (st: [number, string][]) => st.map(([v, color], i) => ({ color, label: i === st.length - 1 ? `≥ ${v}` : `${v}` }));

// Overlays of things in the air (radar, satellite) are carried over the open sea by the terrain's far-sea plane, which
// covers this box (terrain/index.ts, loadAbyssalOverlay). The picture is faded out over the last degrees inside
// it, so that coverage ends in a gradient instead of a hard rectangle. Tiles well inside the box are untouched.
const AIR_BOX = { west: -76, east: -58, south: 11, north: 26 }, AIR_FEATHER = 2.5;
function feathered(url: (z: number, x: number, y: number) => string): NonNullable<OverlaySource['draw']> {
  return async (z, x, y) => {
    const r = await fetch(url(z, x, y), { mode: 'cors' });
    if (!r.ok) return null;
    const blob = await r.blob();
    const w = tileLon(x, z), e = tileLon(x + 1, z), n = tileLat(y, z), s = tileLat(y + 1, z), F = AIR_FEATHER;
    // (straight alpha, as the terrain's own loader asks for: its shader blends by the alpha itself)
    if (w >= AIR_BOX.west + F && e <= AIR_BOX.east - F && s >= AIR_BOX.south + F && n <= AIR_BOX.north - F) return createImageBitmap(blob, { premultiplyAlpha: 'none' });
    const img = await createImageBitmap(blob);
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0); img.close?.();
    const d = g.getImageData(0, 0, cv.width, cv.height), px = d.data;
    for (let j = 0; j < cv.height; j++) {
      const lat = tileLat(y + (j + 0.5) / cv.height, z), fy = Math.min(lat - AIR_BOX.south, AIR_BOX.north - lat);
      for (let i = 0; i < cv.width; i++) {
        const lon = w + ((i + 0.5) / cv.width) * (e - w);
        const f = Math.max(0, Math.min(1, Math.min(fy, lon - AIR_BOX.west, AIR_BOX.east - lon) / F));
        if (f < 1) px[(j * cv.width + i) * 4 + 3] *= f * f * (3 - 2 * f);
      }
    }
    g.putImageData(d, 0, 0);
    return cv;
  };
}

/** NOAA maps sea level rise in half-foot steps from 0 to 10 ft; the service name spells 1.5 as "1_5". */
export function slrStep(seaLevelM: number): { ft: number; name: string; substituted: boolean } {
  const want = Math.min(10, Math.max(0, Math.round((seaLevelM / 0.3048) * 2) / 2));
  const ft = want === 0 ? 1 : want;
  return { ft, name: String(ft).replace('.', '_'), substituted: want === 0 };
}

export const createOverlays: LayerFactory = ({ world, store }) => {
  const terrain = world.terrain;
  const refresh = signal(0);
  let gen = 0, cur: OverlaySource | null = null, timer: ReturnType<typeof setTimeout> | null = null, tinted = false;
  let nfhlLegend: S.Legend | null = null, nfhlFar: boolean | null = null, lastError = '';

  const show = (source: OverlaySource | null, legend: S.Legend | null) => {
    cur = source;
    terrain.setOverlay(source, untracked(() => S.overlayOpacity.value));
    S.overlayLegend.value = legend;
  };
  const again = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(() => { refresh.value++; }, ms); };

  async function radar(my: number) {
    try {
      const j = await fetch('https://api.rainviewer.com/public/weather-maps.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
      const past = j?.radar?.past as { time: number; path: string }[] | undefined;
      if (!j?.host || !past?.length) throw new Error('no radar frames listed');
      const f = past[past.length - 1], base = `${j.host}${f.path}/256`;
      if (my !== gen) return;
      const rv = (z: number, x: number, y: number) => `${base}/${z}/${x}/${y}/2/1_1.png`;
      show({ id: `radar:rainviewer:${f.time}`, minZoom: 0, maxZoom: 7, tileSize: 256, aboveWater: true, url: rv, draw: feathered(rv) }, {
        title: tr('Rain radar', 'Radar de lluvia'), unit: 'dBZ', stops: [{ color: RV_WEAK, label: tr('< 15 (weak echoes)', '< 15 (ecos débiles)') }, ...dbz(RV_STOPS)],
        note: tr(`Reflectivity, frame of ${ast(f.time * 1000)}. Refreshes every 5 minutes. Mosaic resolution is about 1 km (tiles to zoom 7). The pale fringe around the echoes is reflectivity below 15 dBZ as RainViewer draws it (drizzle, or returns that are not rain).`, `Reflectividad, imagen de ${ast(f.time * 1000)}. Se actualiza cada 5 minutos. Resolución del mosaico: cerca de 1 km (teselas hasta zoom 7). El borde pálido alrededor de los ecos es reflectividad menor de 15 dBZ tal como la dibuja RainViewer (llovizna o ecos que no son lluvia).`),
        source: 'RainViewer radar mosaic (rainviewer.com), from NWS NEXRAD TJUA',
      });
    } catch (e) {
      lastError = 'rainviewer: ' + String(e);
      if (my !== gen) return;
      const bust = Math.floor(Date.now() / 300000);
      const iem = (z: number, x: number, y: number) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::JUA-N0Q-0/${z}/${x}/${y}.png?_=${bust}`;
      show({ id: `radar:iem:${bust}`, minZoom: 0, maxZoom: 10, tileSize: 256, aboveWater: true, url: iem, draw: feathered(iem) }, {
        title: tr('Rain radar · San Juan (TJUA)', 'Radar de lluvia · San Juan (TJUA)'), unit: 'dBZ', stops: dbz(NWS_STOPS),
        note: tr(`Base reflectivity, latest scan available at ${ast(Date.now())} (the tiles carry no time stamp). Refreshes every 5 minutes.`, `Reflectividad base, último barrido disponible a las ${ast(Date.now())} (las teselas no traen hora). Se actualiza cada 5 minutos.`),
        source: 'NWS NEXRAD TJUA via Iowa Environmental Mesonet (mesonet.agron.iastate.edu)',
      });
    }
    again(300000);
  }

  async function goes(my: number) {
    const tile = (time: string, z: number, x: number, y: number) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/${time}/GoogleMapsCompatible_Level7/${z}/${y}/${x}.png`;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + 'Z';
    const step = 600000, t0 = Math.floor((Date.now() - 30 * 60000) / step) * step;
    const pz = 6, px = Math.floor(lonToTileX(ORIGIN.lon, pz)), py = Math.floor(latToTileY(ORIGIN.lat, pz));
    let found: number | null = null;
    // The newest image is usually 30 to 60 minutes old: ask for four 10-minute slots at a time, newest first, up to 4 hours back.
    for (let k = 0; k < 24 && found == null; k += 4) {
      const slots = [0, 1, 2, 3].map((i) => t0 - (k + i) * step);
      const ok = await Promise.all(slots.map((t) => fetch(tile(iso(t), pz, px, py), { mode: 'cors' }).then((r) => r.ok && (r.headers.get('content-type') ?? 'image').startsWith('image')).catch(() => false)));
      if (my !== gen) return;
      const i = ok.indexOf(true);
      if (i >= 0) found = slots[i];
    }
    if (my !== gen) return;
    if (found == null) {
      lastError = 'goes: no image answered in the last 4 hours';
      show(null, { title: 'GOES-East GeoColor', stops: [], note: tr('No image from the last 4 hours answered. Trying again in 5 minutes.', 'No respondió ninguna imagen de las últimas 4 horas. Se intentará de nuevo en 5 minutos.'), source: 'NASA GIBS · NOAA GOES-East ABI' });
      again(300000);
      return;
    }
    const time = iso(found);
    show({ id: `goes:${time}`, minZoom: 0, maxZoom: 7, tileSize: 256, aboveWater: true, url: (z, x, y) => tile(time, z, x, y), draw: feathered((z, x, y) => tile(time, z, x, y)) }, {
      title: tr('Satellite · GOES-East GeoColor', 'Satélite · GOES-East GeoColor'),
      stops: [{ color: '#f4f6f7', label: tr('Cloud (day: true colour)', 'Nubes (día: color real)') }, { color: '#9db7e0', label: tr('Night: low cloud and fog', 'Noche: nubes bajas y niebla') }, { color: '#e9ecef', label: tr('Night: high cloud (infrared)', 'Noche: nubes altas (infrarrojo)') }],
      note: tr(`Image of ${ast(found)}, about ${Math.round((Date.now() - found) / 60000)} min old. Resolution about 1 km (tiles to zoom 7). At night the land under the cloud is a static city-lights picture, not live.`, `Imagen de ${ast(found)}, de hace unos ${Math.round((Date.now() - found) / 60000)} min. Resolución cerca de 1 km (teselas hasta zoom 7). De noche el suelo es una imagen fija de luces urbanas, no en vivo.`),
      source: 'NOAA GOES-East ABI GeoColor (CIRA) via NASA GIBS',
    });
    again(600000);
  }

  function nfhl() {
    const url = (z: number, x: number, y: number) => {
      const res = (2 * HALF) / 2 ** z, minx = -HALF + x * res, maxy = HALF - y * res;
      return `https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/export?bbox=${minx},${maxy - res},${minx + res},${maxy}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:28&f=image`;
    };
    nfhlFar = null;
    nfhlLegend = {
      title: tr('FEMA flood hazard zones', 'Zonas de riesgo de inundación de FEMA'),
      stops: [
        { color: '#00c5ff', label: tr('1 % annual chance (zones A, AE, AH, AO; coastal VE)', '1 % de probabilidad anual (zonas A, AE, AH, AO; costera VE)') },
        { color: '#3b6fd6', label: tr('Regulatory floodway (hatched)', 'Cauce regulatorio (rayado)') },
        { color: '#ff9d3c', label: tr('0.2 % annual chance (shaded zone X)', '0.2 % de probabilidad anual (zona X sombreada)') },
      ],
      note: '',
      source: 'FEMA National Flood Hazard Layer, layer 28 "Flood Hazard Zones" (hazards.fema.gov), drawn by FEMA\'s map service',
    };
    show({ id: 'nfhl', minZoom: 11, maxZoom: 16, tileSize: 256, url }, nfhlLegend);
    nfhlNote();
  }
  function nfhlNote() {
    if (!nfhlLegend || untracked(() => S.overlay.value) !== 'nfhl') return;
    const far = terrain.stats().maxZoom < 11;
    if (far === nfhlFar) return;
    nfhlFar = far;
    const base = tr('Effective flood insurance rate map zones, colours as FEMA draws them. Coastal high hazard zones (V, VE) are 1 % annual chance zones too.', 'Zonas vigentes del mapa de tasas de seguro de inundación, con los colores de FEMA. Las zonas costeras de alto riesgo (V, VE) también son de 1 % anual.');
    S.overlayLegend.value = { ...nfhlLegend, note: far ? tr('Zoom in to see the zones: FEMA\'s service draws them only at close range (tile zoom 11 and deeper). ', 'Acérquese para ver las zonas: el servicio de FEMA solo las dibuja de cerca (zoom 11 o mayor). ') + base : base };
  }

  function slr(seaLevelM: number) {
    const s = slrStep(seaLevelM), m = seaLevelM.toFixed(seaLevelM < 1 ? 2 : 1);
    const shown = tr(`NOAA mapping at +${s.ft} ft`, `Mapa de NOAA a +${s.ft} pies`);
    const why = s.substituted
      ? tr(` (your scenario is +${m} m; +1 ft is the first step shown here)`, ` (su escenario es +${m} m; +1 pie es el primer paso que se muestra)`)
      : tr(` (nearest to your +${m} m)`, ` (el más cercano a su +${m} m)`);
    show({ id: `slr:${s.name}`, minZoom: 0, maxZoom: 16, tileSize: 256, url: (z, x, y) => `https://coast.noaa.gov/arcgis/rest/services/dc_slr/slr_${s.name}ft/MapServer/tile/${z}/${y}/${x}` }, {
      title: tr('Sea level rise inundation', 'Inundación por aumento del nivel del mar'),
      stops: [
        { color: '#a6cee3', label: tr('Water, shallower', 'Agua, menos profunda') },
        { color: '#1f5fa8', label: tr('Water, deeper', 'Agua, más profunda') },
        { color: '#8fd64f', label: tr('Low-lying, not connected to the sea', 'Zona baja sin conexión con el mar') },
      ],
      note: shown + why + tr(' above mean higher high water. A bathtub model on lidar elevation: no waves, storm surge, erosion or drainage.', ' sobre la pleamar media más alta. Modelo de "bañera" sobre elevación lidar: sin oleaje, marejada, erosión ni drenaje.'),
      source: 'NOAA Office for Coastal Management, Sea Level Rise Viewer (coast.noaa.gov/slr)',
    });
  }

  async function choropleth(my: number, prop: string) {
    const def = choroplethDef(store, prop), derived = prop === DERIVED_SFHA;
    const lang = untracked(() => S.lang.value);
    const title = def?.label?.[lang] ?? prop;
    try {
      const [list, got] = await Promise.all([loadMunicipios(), choroplethValues(store, prop)]);
      if (my !== gen) return;
      const { values, sample } = got;
      let source: string | undefined;
      if (sample) {
        const rec = await store.getObject(sample).catch(() => null);
        if (my !== gen) return;
        const sid = rec?.allProps.find((p) => p.key === got.sourceProp)?.source, sd = store.ontology.sources.find((x) => x.id === sid);
        source = sd ? `${sd.name} · ${sd.org}` : sid;
        if (derived) source = tr('Derived here: buildings in the 1 % zone ÷ mapped buildings × 1,000. Inputs: ', 'Derivado aquí: edificios en la zona de 1 % ÷ edificios cartografiados × 1,000. Insumos: ') + (source ?? '');
      }
      const c = makeChoropleth(list, values, prop);
      const fmt = (v: number) => formatValue(v, def, lang);
      const edges = [c.min, ...c.breaks, c.max];
      const stops = c.colors.map((color, i) => ({ color, label: i === c.colors.length - 1 ? `${fmt(edges[i])} – ${fmt(edges[i + 1])}` : `${fmt(edges[i])} – < ${fmt(edges[i + 1])}` }));
      if (c.missing) stops.push({ color: NO_DATA, label: tr(`No data (${c.missing})`, `Sin datos (${c.missing})`) });
      show(values.size ? c.source : null, {
        title, unit: def?.format === 'pct' || def?.format === 'usd' ? undefined : def?.unit, stops: values.size ? stops : [],
        note: values.size
          ? tr(`${values.size} of ${list.length} municipios, ${c.colors.length} classes with equal counts (quantiles); darker = higher.`, `${values.size} de ${list.length} municipios, ${c.colors.length} clases con igual número (cuantiles); más oscuro = mayor.`)
          : tr('The store holds no values for this property.', 'El almacén no tiene valores para esta propiedad.'),
        source,
      });
    } catch (e) {
      lastError = 'choropleth: ' + String(e);
      if (my === gen) show(null, { title, stops: [], note: tr('Could not draw this map: ', 'No se pudo dibujar este mapa: ') + String((e as Error)?.message ?? e) });
    }
  }

  function elevation() {
    const has = typeof terrain.setTint === 'function';
    if (has) { terrain.setTint!('elevation'); tinted = true; }
    const ramp = (terrain as any).tintLegend as { color: string; label: string }[] | undefined;
    show(null, {
      title: tr('Elevation', 'Elevación'), unit: 'm',
      stops: ramp ?? [{ color: '#174085', label: tr('Sea floor, 2,000 m deep', 'Fondo marino, 2,000 m') }, { color: '#4594cc', label: tr('Sea floor, 60 m deep', 'Fondo marino, 60 m') }, { color: '#216633', label: '0' }, { color: '#5c9140', label: '150' }, { color: '#c7bd70', label: '450' }, { color: '#ad855c', label: '850' }, { color: '#f2ede0', label: '≥ 1,300' }],
      note: has ? tr('Height above mean sea level, coloured from the terrain model itself and shaded by the brightness of the photo; colours blend between the heights listed. Highest point: Cerro de Punta, 1,338 m.', 'Altura sobre el nivel medio del mar, coloreada desde el propio modelo del terreno y sombreada con el brillo de la foto; los colores se mezclan entre las alturas indicadas. Punto más alto: Cerro de Punta, 1,338 m.')
        : tr('This build of the terrain has no elevation tint yet; the photo is shown unchanged.', 'Esta versión del terreno aún no tiene tinte de elevación; la foto se muestra sin cambios.'),
      source: 'USGS 3DEP elevation via AWS Terrain Tiles (the terrain model drawn here)',
    });
  }

  const stop = effect(() => {
    const id = S.overlay.value;
    S.lang.value; refresh.value;
    const sea = id === 'slr' ? S.scenario.value.seaLevelM : 0;
    const prop = id === 'choropleth' ? S.choroplethProp.value : '';
    const my = ++gen;
    if (timer) { clearTimeout(timer); timer = null; }
    untracked(() => {
      if (id !== 'elevation' && tinted) { terrain.setTint?.('none'); tinted = false; }
      if (id !== 'nfhl') nfhlLegend = null;
      if (id === 'radar') void radar(my);
      else if (id === 'goes') void goes(my);
      else if (id === 'nfhl') nfhl();
      else if (id === 'slr') slr(sea);
      else if (id === 'choropleth') void choropleth(my, prop);
      else if (id === 'elevation') elevation();
      else show(null, null);
    });
  });
  const stopOpacity = effect(() => { const o = S.overlayOpacity.value; terrain.setOverlay(cur, o); });
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const offChange = store.onChange((e) => {
    if (S.overlay.value !== 'choropleth' || !e.types.includes('municipio')) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { refresh.value++; }, 1500);
  });

  return {
    update(f) { if (f.index % 20 === 0) nfhlNote(); },
    dispose() {
      stop(); stopOpacity(); offChange();
      if (timer) clearTimeout(timer); if (debounce) clearTimeout(debounce);
      if (tinted) terrain.setTint?.('none');
      terrain.setOverlay(null, 0); S.overlayLegend.value = null;
    },
    ...({ debug: () => ({ overlay: S.overlay.value, source: cur?.id ?? null, aboveWater: !!cur?.aboveWater, lastError, legend: S.overlayLegend.value && { title: S.overlayLegend.value.title, note: S.overlayLegend.value.note, stops: S.overlayLegend.value.stops.length } }) } as object),
  };
};
