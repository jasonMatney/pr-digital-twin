// Runs on the GitHub runner: renders each requested page in headless Chromium (software GL) and saves a JPEG.
//   node tools/cloudshot-runner.mjs shots.request.json out/
// Request: { "shots": [{ "id": "island", "url": "https://…", "w": 1280, "h": 800, "wait": 4000, "ready": 180000, "eval": "js", "dpr": 1 }] }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.env.NODE_PATH ? process.env.NODE_PATH + '/' : import.meta.url);
const { chromium } = require('playwright');

const [reqPath, outDir] = process.argv.slice(2);
const req = JSON.parse(readFileSync(reqPath, 'utf8'));
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync', '--no-sandbox'] });
const results = [];
async function one(s) {
  const t0 = Date.now();
  const page = await browser.newPage({ viewport: { width: s.w ?? 1280, height: s.h ?? 800 }, deviceScaleFactor: s.dpr ?? 1 });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text().slice(0, 240)}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 300)}`));
  const failed = {};
  page.on('requestfailed', (r) => { try { const h = new URL(r.url()).host; failed[h] = (failed[h] ?? 0) + 1; } catch {} });
  const r = { id: s.id, url: s.url };
  try {
    await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => globalThis.__garita && globalThis.__garita.ready, null, { timeout: s.ready ?? 180000 }).catch(() => logs.push('[shot] ready flag never set'));
    if (s.eval) await page.evaluate(s.eval).catch((e) => logs.push('[eval] ' + String(e).slice(0, 200)));
    await page.waitForTimeout(s.wait ?? 4000);
    await page.screenshot({ path: `${outDir}/${s.id}.jpg`, type: 'jpeg', quality: s.quality ?? 86 });
    r.debug = await page.evaluate(() => globalThis.__garita?.debug?.() ?? null).catch(() => null);
    r.ok = true;
  } catch (e) { r.ok = false; r.error = String(e).slice(0, 400); }
  r.ms = Date.now() - t0; r.logs = [...new Set(logs)].slice(0, 30); r.failedHosts = failed;
  await page.close();
  results.push(r);
  console.log(r.id, r.ok ? 'ok' : 'FAILED', r.ms + ' ms');
}
// Two pages at a time: the runner has four cores and software GL uses several threads per page.
const queue = [...req.shots];
await Promise.all([0, 1].map(async () => { while (queue.length) await one(queue.shift()); }));
await browser.close();
writeFileSync(`${outDir}/results.json`, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
