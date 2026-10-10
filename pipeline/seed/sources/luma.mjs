// LUMA power regions from the outage API.
import { fetchJson, fetchText, slug, num, normMuni } from '../lib.mjs';
const B = 'https://api.miluma.lumapr.com/miluma-outage-api/outage';
export async function build(ctx) {
  const j = await fetchJson(`${B}/regionsWithoutService`);
  const regions = j.regions || [];
  const objects = regions.map((r) => ({ type: 'power_region', key: slug(r.name), name: r.name, props: { customers: num(r.totalClients) } }));
  const links = [], problems = []; let townsNote = 'The towns endpoint returned no municipio lists, so no municipio part_of power_region links are published.';
  if (!process.env.SEED_FIXTURES) try {
    const t = await fetchText(`${B}/municipality/towns`, { method: 'POST', body: JSON.stringify(regions.map((r) => r.name)), headers: { 'Content-Type': 'application/json' }, tries: 2 });
    ctx.probe('luma_towns_post', t.slice(0, 20000));
    const towns = JSON.parse(t);
    const muni = await ctx.municipios();
    const byName = new Map(muni.rows.map((r) => [normMuni(r.BASENAME), r]));
    const objs = new Map(); let n = 0;
    for (const [region, list] of Object.entries(towns)) {
      for (const it of Array.isArray(list) ? list : []) {
        const name = typeof it === 'string' ? it : it?.name || it?.town || it?.municipality;
        const m = name && byName.get(normMuni(name));
        if (!m) { problems.push(`LUMA town "${JSON.stringify(it).slice(0, 80)}" in ${region} not matched to a municipio`); continue; }
        links.push({ src: `municipio:${m.GEOID}`, type: 'part_of', dst: `power_region:${slug(region)}` });
        objs.set(String(m.GEOID), { type: 'municipio', key: String(m.GEOID), name: String(m.BASENAME), props: { power_region: region } }); n++;
      }
    }
    objects.push(...objs.values());
    if (n) townsNote = `Municipio -> region from POST ${B}/municipality/towns (${n} towns matched).`;
  } catch (e) { problems.push(`towns endpoint: ${e.message}`); }
  return { file: '26-power-regions', problems, batch: { source: 'luma', fetchedAt: Date.now(), objects, links, note: `LUMA outage API regionsWithoutService: ${regions.length} regions, customers = totalClients. Region names as the API spells them. ${townsNote}` } };
}
