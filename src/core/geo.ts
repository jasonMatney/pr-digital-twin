// World frame and tile maths, shared by the client and the pipeline (pipeline/ imports this file through tsx/esbuild).
//
// World frame: metres, x east, y up (above mean sea level), z SOUTH. Origin = island centre.
// Local equirectangular projection with WGS84 scales at the origin latitude. The island spans about
// +-150 km, so the scene also bends with the Earth: y_render = y - (x^2 + z^2) / (2 R) (see curveDrop).

export const ORIGIN = { lat: 18.22, lon: -66.45 } as const;
export const R_EARTH = 6371008.8;
export const M_PER_DEG_LAT = 110682.9;   // at 18.22 N
export const M_PER_DEG_LON = 105773.6;   // at 18.22 N
export const DEG = Math.PI / 180;

/** Whole area the twin covers: the six zoom-8 Web Mercator tiles x 79..81, y 114..115. */
export const ROOT_Z = 8;
export const ROOT_X0 = 79, ROOT_X1 = 81, ROOT_Y0 = 114, ROOT_Y1 = 115;
/** Land box used to decide which deeper tiles the pipeline mirrors (main island, Vieques, Culebra, Mona, Desecheo). */
export const LAND_BOX = { west: -67.98, south: 17.86, east: -65.2, north: 18.54 } as const;
/** San Juan time is UTC-4 all year. */
export const AST_OFFSET_H = -4;

export function lonLatToXZ(lon: number, lat: number): [number, number] {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}
export function xzToLonLat(x: number, z: number): [number, number] {
  return [ORIGIN.lon + x / M_PER_DEG_LON, ORIGIN.lat - z / M_PER_DEG_LAT];
}
/** How far the ground falls below the tangent plane at (x, z): the scene is a cap of the sphere. */
export function curveDrop(x: number, z: number): number {
  return (x * x + z * z) / (2 * R_EARTH);
}

// ---- Web Mercator tiles (XYZ, y down) ----
export function tileLon(x: number, z: number): number { return x / 2 ** z * 360 - 180; }
export function tileLat(y: number, z: number): number {
  const n = Math.PI * (1 - 2 * y / 2 ** z);
  return Math.atan(Math.sinh(n)) / DEG;
}
export function lonToTileX(lon: number, z: number): number { return (lon + 180) / 360 * 2 ** z; }
export function latToTileY(lat: number, z: number): number {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
}
export interface TileBounds { west: number; south: number; east: number; north: number }
export function tileBounds(z: number, x: number, y: number): TileBounds {
  return { west: tileLon(x, z), east: tileLon(x + 1, z), north: tileLat(y, z), south: tileLat(y + 1, z) };
}
export function tileKey(z: number, x: number, y: number): string { return `${z}/${x}/${y}`; }
/** Ground size of one tile pixel, metres, at the origin latitude. */
export function metresPerPixel(z: number, tilePx = 256): number {
  return 2 * Math.PI * 6378137 * Math.cos(ORIGIN.lat * DEG) / (tilePx * 2 ** z);
}
/** True when the tile touches the land box, grown by `pad` degrees. */
export function tileTouchesLand(z: number, x: number, y: number, pad = 0.02): boolean {
  const b = tileBounds(z, x, y);
  return b.east > LAND_BOX.west - pad && b.west < LAND_BOX.east + pad && b.north > LAND_BOX.south - pad && b.south < LAND_BOX.north + pad;
}
/** Terrarium encoding: metres = R*256 + G + B/256 - 32768. */
export function terrariumToMetres(r: number, g: number, b: number): number { return r * 256 + g + b / 256 - 32768; }

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}
