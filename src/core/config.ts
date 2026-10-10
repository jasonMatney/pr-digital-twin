// Where static data lives. In production the page sits at the site root, so './'. Dev builds deployed under a
// sub-path (dev/<name>/) point back at the root with VITE_DATA_BASE='../../'.
const base = new URL(import.meta.env.VITE_DATA_BASE ?? './', location.href);
export const dataUrl = (path: string) => new URL(path, base).href;
export const params = new URLSearchParams(location.search);
export const flag = (name: string) => params.has(name) && params.get(name) !== '0';

export const UPSTREAM = {
  /** AWS Terrain Tiles, terrarium encoding, CORS enabled. */
  dem: (z: number, x: number, y: number) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  /** USGS The National Map orthoimagery (public domain). Note the z/y/x order. */
  img: (z: number, x: number, y: number) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
  demMaxZoom: 15,
  imgMaxZoom: 16,
};
