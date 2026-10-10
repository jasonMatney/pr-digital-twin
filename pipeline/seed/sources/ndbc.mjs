// NDBC active stations around Puerto Rico.
import { fetchText, num } from '../lib.mjs';
export async function build() {
  const xml = await fetchText('https://www.ndbc.noaa.gov/activestations.xml', { accept: 'text/xml' });
  const objects = [];
  for (const m of xml.matchAll(/<station\s+([^>]*?)\/?>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const lat = num(a.lat), lon = num(a.lon);
    if (lat == null || lon == null || lat < 16.5 || lat > 20 || lon < -69 || lon > -63.5) continue;
    const name = a.name.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"');
    objects.push({ type: 'buoy', key: a.id.toUpperCase(), name, lon, lat, status: 'active', text: `NDBC ${a.id} ${a.owner || ''} ${a.type || ''} met=${a.met || ''}` });
  }
  const created = xml.match(/created="([^"]+)"/)?.[1];
  return { file: '25-buoys', batch: { source: 'ndbc', fetchedAt: Date.now(), ...(created && Date.parse(created.replace('UTC', 'Z')) ? { observedAt: Date.parse(created.replace('UTC', 'Z')) } : {}), objects,
    note: 'NDBC activestations.xml, stations with 16.5 <= lat <= 20 and -69 <= lon <= -63.5 (all station types: buoys, C-MAN, tide and DART stations).' } };
}
