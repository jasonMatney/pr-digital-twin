// Emergency shelters, 2026 hurricane season list of the Departamento de la Vivienda (PDF). Step 1: get the text.
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBuf } from '../lib.mjs';
import { parseShelters } from './shelters_parse.mjs';
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
  return parseShelters(text, method, ctx);
}
