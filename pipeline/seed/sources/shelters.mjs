// Emergency shelters, 2026 hurricane season list of the Departamento de la Vivienda (PDF). Step 1: get the text.
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBuf, UA, pool, normMuni, haversineKm, clean, round } from '../lib.mjs';
import { parseShelterText, facilityType, shelterKey } from './shelters_parse.mjs';
const PDF = 'https://docs.pr.gov/files/Vivienda/vivienda.pr.gov/Home/DVAVP_Refugios_Temporada_de_Huracanes_2026.pdf';

export async function build(ctx) {
  if (process.env.SEED_FIXTURES) throw new Error('needs the runner');
  const dir = join(ctx.tmp, 'shelters'); mkdirSync(dir, { recursive: true });
  const pdf = join(dir, 'refugios.pdf');
  writeFileSync(pdf, await fetchBuf(PDF, { timeout: 600000, accept: 'application/pdf' }));
  const info = execFileSync('pdfinfo', [pdf]).toString(); ctx.log(info); ctx.probe('shelters_pdfinfo', info);
  const pages = Number(info.match(/Pages:\s+(\d+)/)?.[1] || 0);
  let text = execFileSync('pdftotext', ['-layout', pdf, '-'], { maxBuffer: 1 << 28 }).toString();
  let method = 'pdftotext -layout';
  if (text.replace(/\s/g, '').length < 200 * Math.max(1, pages)) {
    method = 'pdftoppm -r 150 -gray + tesseract -l spa --psm 6';
    execSync(`pdftoppm -r 150 -gray -png "${pdf}" "${dir}/p"`, { stdio: 'inherit' });
    execSync(`ls "${dir}"/p*.png | xargs -P 4 -I{} tesseract {} {} -l spa --psm 6 >/dev/null 2>&1 || true`, { shell: '/bin/bash' });
    text = readdirSync(dir).filter((f) => f.endsWith('.png.txt')).sort().map((f) => `\f=== ${f} ===\n${readFileSync(join(dir, f), 'utf8')}`).join('\n');
  }
  ctx.writeProbeFile('shelters_text.txt', text);
  ctx.probe('shelters_text_method', method);
  ctx.log(`shelters: ${pages} pages, ${text.length} chars via ${method}\n${text.split('\n').filter((l) => l.trim()).slice(0, 60).join('\n')}`);
  const muni = await ctx.municipios();
  const names = new Map(muni.rows.map((r) => [normMuni(r.BASENAME), { geoid: String(r.GEOID), name: String(r.BASENAME), lat: Number(r.INTPTLAT), lon: Number(r.INTPTLON) }]));
  const { rows, problems } = parseShelterText(text, names);
  const links = (text.match(/https?:\/\/\S+/g) || []).length;
  if (rows.length < 50) throw new Error(`only ${rows.length} rows parsed from the shelter list (${links} links in the text)`);
  const created = Date.parse((info.match(/CreationDate:\s+\w+ (.*?) UTC/)?.[1] || '') + ' UTC');
  // The list gives a Google Maps link per shelter. Short links redirect to a maps URL that often carries the place coordinates.
  const located = await pool(rows, 4, async (r) => {
    try {
      let u = r.url;
      for (let hop = 0; hop < 4; hop++) {
        const res = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
        const loc = res.headers.get('location');
        if (!loc) break;
        u = new URL(loc, u).href;
        if (/!3d-?\d/.test(decodeURIComponent(u))) break;
      }
      let d = u; try { d = decodeURIComponent(u); } catch {}
      const m = d.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/), v = d.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/), q = d.match(/[?&](?:q|ll|query|center|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
      if (m) return { lat: +m[1], lon: +m[2], how: 'place coordinates in the resolved URL', conf: 0.9, final: u };
      if (q) return { lat: +q[1], lon: +q[2], how: 'coordinates in the resolved URL query', conf: 0.85, final: u };
      if (v) return { lat: +v[1], lon: +v[2], how: 'map view centre in the resolved URL', conf: 0.6, final: u };
      return { final: u };
    } catch (e) { return { error: e.message }; }
  });
  ctx.probe('shelters_link_samples', located.slice(0, 12).map((l, i) => ({ url: rows[i].url, ...l, final: String(l.final || '').slice(0, 300) })));
  const objects = [], olinks = [], perMuni = new Map(), seen = new Set(); let nLoc = 0, nFar = 0, nErr = 0;
  rows.forEach((r, i) => {
    const m = names.get(normMuni(r.municipio));
    let key = shelterKey(m.geoid, r.name); for (let n = 2; seen.has(key); n++) key = `${shelterKey(m.geoid, r.name)}-${n}`; seen.add(key);
    const l = located[i] || {}; let lon = null, lat = null, basis = 'not located';
    if (l.error) nErr++;
    if (l.lat != null && l.lat > 17.6 && l.lat < 18.7 && l.lon > -67.99 && l.lon < -65.1) {
      const km = haversineKm(l.lat, l.lon, m.lat, m.lon);
      if (km <= 25) { lon = l.lon; lat = l.lat; basis = `Google Maps link in the PRDOH list (${l.how})`; nLoc++; } else { nFar++; problems.push(`${r.municipio} / ${r.name}: link resolves ${round(km, 1)} km from the municipio internal point; coordinates not used`); }
    }
    objects.push({ type: 'shelter', key, name: r.name, ...(lon != null ? { lon, lat } : {}), status: 'listed', identities: [['prdoh:refugios2026', key]],
      props: clean({ facility_type: facilityType(r.name), list_year: 2026, location_basis: lon != null ? { value: basis, confidence: l.conf } : basis, operating_status: 'listed for 2026; not confirmed open', address: r.address, municipio_name: m.name, map_url: r.url }),
      text: `${r.name} ${r.address || ''} ${m.name}` });
    olinks.push({ src: `shelter:${key}`, type: 'located_in', dst: `municipio:${m.geoid}` });
    perMuni.set(m.geoid, (perMuni.get(m.geoid) || 0) + 1);
    if (r.note) problems.push(`${r.municipio} / ${r.name}: ${r.note}`);
  });
  for (const m of names.values()) objects.push({ type: 'municipio', key: m.geoid, name: m.name, props: { shelters: perMuni.get(m.geoid) || 0 } });
  problems.unshift(`${rows.length} shelters parsed; ${links} links in the text; located from the list's map links: ${nLoc} (${nFar} rejected as too far, ${nErr} link lookups failed); OpenStreetMap matching not run`);
  return { file: '40-shelters', problems, batch: { source: 'prdoh_shelters', fetchedAt: Date.now(), ...(Number.isFinite(created) ? { observedAt: created } : {}), objects, links: olinks,
    note: `Departamento de la Vivienda, "Refugios Temporada de Huracanes 2026" (PDF, ${pages} pages, text via ${method}). Columns in the document: municipio, facility, address, Google Maps link; it gives no capacities, so capacity is absent. ${rows.length} shelters. facility_type is read from the name's first words (Esc. = school, Centro Comunal = community centre, ...). Coordinates, where present (${nLoc} of ${rows.length}), come from the Google Maps link printed in the list: the short link is followed and the coordinates are read from the resolved URL; a point more than 25 km from the municipio's internal point is discarded. Shelters not located this way have no coordinates (location_basis "not located"). No matching to OpenStreetMap facilities has been done yet, so there are no housed_at links. municipio.shelters = shelters listed per municipio.` } };
}
