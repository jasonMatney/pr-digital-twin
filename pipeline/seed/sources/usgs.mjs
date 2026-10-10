// USGS NWIS active real-time sites in Puerto Rico -> stream gauges and reservoirs.
import { fetchText, num, round, clean } from '../lib.mjs';
const URL_ = 'https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=pr&siteStatus=active&hasDataTypeCd=iv&siteOutput=expanded';
export const isReservoirName = (n) => /^(lago|embalse)\b/i.test(String(n).trim());
const SQMI = 2.58998811;

export async function build(ctx) {
  const text = await fetchText(URL_, { accept: 'text/plain' });
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const head = lines[0].split('\t');
  const rows = lines.slice(2).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])));
  const muni = await ctx.municipios().catch(() => ({ rows: [] }));
  const names = new Map(muni.rows.map((r) => [String(r.GEOID), String(r.BASENAME)]));
  const objects = [], links = [], skipped = {};
  for (const r of rows) {
    const tp = r.site_tp_cd || '';
    const reservoir = tp === 'LK' || isReservoirName(r.station_nm);
    if (!reservoir && !tp.startsWith('ST')) { skipped[tp] = (skipped[tp] || 0) + 1; continue; }
    const type = reservoir ? 'reservoir' : 'stream_gauge';
    const lat = num(r.dec_lat_va), lon = num(r.dec_long_va);
    const g = r.county_cd ? `72${r.county_cd}` : null;
    const da = num(r.drain_area_va);
    objects.push({ type, key: r.site_no, name: r.station_nm, ...(lat != null && lon != null ? { lon, lat } : {}), status: 'active',
      props: clean({ ...(type === 'stream_gauge' ? { drainage_km2: da != null ? round(da * SQMI, 2) : null } : {}), municipio_name: g ? names.get(g) : null }),
      text: `USGS ${r.site_no} ${tp} HUC ${r.huc_cd || ''}` });
    ctx.usgsType.set(r.site_no, type);
    if (g && names.has(g)) links.push({ src: `${type}:${r.site_no}`, type: 'located_in', dst: `municipio:${g}` });
  }
  return { file: '21-usgs-sites', batch: { source: 'usgs_nwis', fetchedAt: Date.now(), objects, links,
    note: `USGS site service, active sites with instantaneous data in PR (${rows.length} sites). Stream types (site_tp_cd ST*) -> stream_gauge; site_tp_cd LK or a name starting "Lago"/"Embalse" -> reservoir; other site types left out: ${JSON.stringify(skipped)}. drainage_km2 = drain_area_va (sq mi) x ${SQMI}. Municipio from county_cd.` } };
}
