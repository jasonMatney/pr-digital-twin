// Maps a live URL to the recorded payload that stands in for it in fixtures mode (?fixtures=1) and in tests.
// Pure: the scheduler resolves the name against dataUrl('fixtures/<name>').
export const RELAY_BASE = 'https://raw.githubusercontent.com/webgpu-demos/garita/relay/';
export const relayUrl = (file: string) => RELAY_BASE + file;

const RULES: [test: RegExp, file: string | ((m: RegExpExecArray) => string)][] = [
  // The live "active" file was empty when recorded; the 40 recent alerts share its schema and exercise the mapping.
  [/^https:\/\/api\.weather\.gov\/alerts\/active\?area=PR/, 'nws_alerts_all_recent.json'],
  [/^https:\/\/api\.weather\.gov\/stations\/([A-Z0-9]+)\/observations\/latest/, (m) => `nws_obs_${m[1]}.json`],
  [/^https:\/\/earthquake\.usgs\.gov\/fdsnws\/event\/1\/query\?/, 'usgs_quakes_30d.json'],
  [/^https:\/\/waterservices\.usgs\.gov\/nwis\/iv\//, 'usgs_nwis_iv.json'],
  [/^https:\/\/api\.water\.noaa\.gov\/nwps\/v1\/gauges\?/, 'nwps_gauges.json'],
  [/^https:\/\/api\.tidesandcurrents\.noaa\.gov\/api\/prod\/datagetter\?.*date=latest.*station=(\d+).*product=water_level/, (m) => `coops_latest_${m[1]}.json`],
  [/^https:\/\/api\.tidesandcurrents\.noaa\.gov\/api\/prod\/datagetter\?.*station=(\d+).*product=water_level/, (m) => `coops_wl_${m[1]}.json`],
  [/^https:\/\/api\.tidesandcurrents\.noaa\.gov\/api\/prod\/datagetter\?.*station=(\d+).*product=predictions/, (m) => `coops_pred_${m[1]}.json`],
  [/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/, 'open_meteo_grid.json'],
  [/^https:\/\/marine-api\.open-meteo\.com\/v1\/marine\?/, 'open_meteo_marine.json'],
  [/^https:\/\/air-quality-api\.open-meteo\.com\/v1\/air-quality\?/, 'open_meteo_air.json'],
  // Relay files: the fixtures are the raw upstream payloads (no { fetchedAt, source, data } wrapper).
  [/\/relay\/nhc\.json$/, 'nhc_current.json'],
  [/\/relay\/ndbc\.json$/, 'ndbc_latest_obs.txt'],
  [/\/relay\/luma\.json$/, 'luma_regions.json'],
  [/\/relay\/adsb\.json$/, 'adsb_lol.json'],
  [/\/relay\/tsunami\.json$/, 'tsunami_atom.xml'],
];
/** Fixtures that were actually recorded (per-station files exist for one station only). */
export const RECORDED = new Set([
  'nws_alerts_all_recent.json', 'nws_obs_TJSJ.json', 'usgs_quakes_30d.json', 'usgs_nwis_iv.json', 'nwps_gauges.json', 'coops_latest_9755371.json',
  'coops_wl_9755371.json', 'coops_pred_9755371.json', 'open_meteo_grid.json', 'open_meteo_marine.json', 'open_meteo_air.json', 'nhc_current.json',
  'ndbc_latest_obs.txt', 'luma_regions.json', 'adsb_lol.json', 'tsunami_atom.xml',
]);
/** The fixture file name for a URL, or null when nothing was recorded for it. */
export function fixtureFor(url: string): string | null {
  for (const [re, file] of RULES) {
    const m = re.exec(url);
    if (!m) continue;
    const name = typeof file === 'string' ? file : file(m);
    return RECORDED.has(name) ? name : null;
  }
  return null;
}
