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
    // Software GL draws a full-size frame in seconds, so the page loads at a fraction of the resolution (tiles stream
    // per frame) and is switched to full size for the final frames.
    const sep = s.url.includes('?') ? '&' : '?';
    const url = /[?&]scale=/.test(s.url) ? s.url : `${s.url}${sep}shot=1&scale=${s.loadScale ?? 0.3}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => globalThis.__garita && globalThis.__garita.ready, null, { timeout: s.ready ?? 400000 }).catch(() => logs.push('[shot] ready flag never set'));
    if (s.eval) await page.evaluate(s.eval).catch((e) => logs.push('[eval] ' + String(e).slice(0, 200)));
    await page.waitForTimeout(s.wait ?? 4000);
    r.loadMs = Date.now() - t0;
    await page.evaluate(() => new Promise((res) => {
      const g = globalThis.__garita; if (!g?.engine || !g.state?.renderScale) return res(0);
      g.state.renderScale.value = 1;
      let n = 0; const off = g.engine.onFrame(() => { if (++n >= 3) { off(); res(n); } });
      setTimeout(() => { off(); res(n); }, 150000);
    })).catch(() => {});
    // Debug first: under software GL a heavy frame can outlast the screenshot's own timeout, and then this is the evidence.
    r.debug = await page.evaluate(() => globalThis.__garita?.debug?.() ?? null).catch(() => null);
    r.frameMs = await page.evaluate(() => new Promise((res) => { const e = globalThis.__garita?.engine; if (!e) return res(null); let n = 0; const t0 = performance.now(); const off = e.onFrame(() => { n++; }); setTimeout(() => { off(); res(n ? Math.round((performance.now() - t0) / n) : -1); }, 6000); })).catch(() => null);
    await page.screenshot({ path: `${outDir}/${s.id}.jpg`, type: 'jpeg', quality: s.quality ?? 86, timeout: 180000 });
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
