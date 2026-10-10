// Parser for the text layer of the PRDOH 2026 shelter list (pdftotext -layout). Columns: MUNICIPIO, FACILIDAD, DIRECCIÓN, Google Maps.
// On some pages pdftotext emits the cells of two rows on separate lines (municipios, then facilities, then addresses, then links),
// so cells are classified by column and paired in reading order through four queues.
import { normMuni, slug, strip } from '../lib.mjs';

export function parseShelterText(text, muniNames /* Map(norm name -> {geoid,name}) */) {
  const rows = [], problems = [];
  const pages = text.split('\f');
  const cellsOf = (line) => { const out = []; const re = /\S+(?: \S+)*/g; let m; while ((m = re.exec(line))) out.push({ off: m.index, s: m[0] }); return out; };
  const isUrl = (s) => /^https?:\/\//.test(s);
  const isJunk = (s) => /^(lista de|refugios 2026|municipio|facilidad|direcci[oó]n|google maps)$/i.test(s.trim());
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : null; };
  let gF = [], gA = [];
  // The page title ("Lista de" / "Refugios 2026") sits beside a block of two rows whose cells come out on separate lines: it marks where such a block starts.
  const parsed = pages.map((pg) => pg.split('\n').map(cellsOf).map((cs) => { const k = cs.filter((c) => !isJunk(c.s)); k.blockStart = cs.some((c) => /^(lista de|refugios 2026)$/i.test(c.s.trim())); return k; }).filter((cs) => cs.length));
  for (const lines of parsed) for (const cs of lines) if (cs.length === 4 && muniNames.has(normMuni(cs[0].s)) && isUrl(cs[3].s)) { gF.push(cs[1].off); gA.push(cs[2].off); }
  const gFm = med(gF), gAm = med(gA);
  parsed.forEach((lines, pi) => {
    const f = [], a = [];
    for (const cs of lines) if (cs.length === 4 && muniNames.has(normMuni(cs[0].s)) && isUrl(cs[3].s)) { f.push(cs[1].off); a.push(cs[2].off); }
    const fS = med(f) ?? gFm, aS = med(a) ?? gAm;
    const q = { m: [], f: [], a: [], u: [] };
    const flush = () => { while (q.m.length && q.f.length && q.a.length && q.u.length) rows.push({ page: pi + 1, municipio: q.m.shift(), name: q.f.shift(), address: q.a.shift(), url: q.u.shift() }); };
    const complete = (cs) => cs.length === 4 && muniNames.has(normMuni(cs[0].s)) && isUrl(cs[3].s);
    const drain = (why) => {
      // A block row whose address was fused into the facility cell (single space between them): split at the first address word.
      while (q.m.length && q.f.length && q.u.length && !q.a.length) {
        const f = q.f.shift(); const m = f.match(/^(.*?\S)\s+((?:PR-\d|Carr\.?\s|Calle\s|Ave\.?\s|Urb\.?\s|Bo\.?\s).*)$/);
        rows.push({ page: pi + 1, municipio: q.m.shift(), name: m ? m[1] : f, address: m ? m[2] : null, url: q.u.shift(), note: m ? 'name and address split from one fused cell' : 'no address cell found' });
      }
      const left = q.m.length + q.f.length + q.a.length + q.u.length;
      if (left) problems.push(`page ${pi + 1}: cells left unpaired ${why} (dropped): ${JSON.stringify(q).slice(0, 400)}`);
      q.m.length = q.f.length = q.a.length = q.u.length = 0;
    };
    for (const cs of lines) {
      // A whole row on one line is taken as it stands, so a wrapped cell elsewhere cannot shift it.
      if (complete(cs)) { flush(); drain('before a complete row'); rows.push({ page: pi + 1, municipio: cs[0].s, name: cs[1].s, address: cs[2].s, url: cs[3].s }); continue; }
      if (cs.blockStart) { flush(); drain('before the next block'); }
      for (const c of cs) {
        if (isUrl(c.s)) q.u.push(c.s);
        else if (c.off < fS - 4 && muniNames.has(normMuni(c.s))) q.m.push(c.s);
        else if (c.off < fS - 4) problems.push(`page ${pi + 1}: unrecognised text in the municipio column: "${c.s}"`);
        else if (Math.abs(c.off - fS) <= Math.abs(c.off - aS)) { if (/^[(a-zñ]/.test(c.s) && q.f.length) q.f[q.f.length - 1] += ` ${c.s}`; else q.f.push(c.s); }
        else q.a.push(c.s);
      }
    }
    flush();
    drain('at the end of the page');
  });
  return { rows, problems };
}

export const facilityType = (name) => {
  const n = strip(name).toLowerCase();
  if (/^esc\b|^escuela\b|^s\. ?u\.|^segunda unidad|^colegio/.test(n)) return 'school';
  if (/coliseo|cancha|gimnasio|polideportivo|complejo deportivo/.test(n)) return 'sports facility';
  if (/centro comunal|centro comunitario/.test(n)) return 'community centre';
  if (/centro/.test(n)) return 'centre';
  if (/iglesia|parroquia|templo/.test(n)) return 'church';
  return null;
};
export const shelterKey = (geoid, name) => `${geoid}-${slug(name).slice(0, 60)}`;
