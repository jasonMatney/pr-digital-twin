// Headless screenshot of a page, for checking the scene without a display.
//   node tools/shot.mjs <url> <out.png> [--w 1600] [--h 900] [--wait 8000] [--eval "js"] [--dpr 1]
// Uses the pre-installed Chromium with software GL (SwiftShader): correct but slow, a frame can take seconds.
// The page signals readiness by setting window.__garita.ready = true; we wait for that, then --wait ms more.
import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const [url, out] = args;
const W = +opt('w', 1600), H = +opt('h', 900), wait = +opt('wait', 6000), dpr = +opt('dpr', 1);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync', '--no-sandbox'],
}).catch(async () => (await import('playwright-core')).chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] }));
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
const logs = [];
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 400)}`));
page.on('requestfailed', (r) => { const u = r.url(); if (!/amazonaws|nationalmap|arcgis|weather\.gov|usgs\.gov|noaa\.gov|open-meteo|rainviewer|githubusercontent|fema\.gov|adsb|celestrak|openfreemap|earthdata|iastate/.test(u)) logs.push(`[requestfailed] ${u.slice(0, 160)}`); });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => globalThis.__garita && globalThis.__garita.ready, null, { timeout: +opt('ready', 180000) }).catch(() => logs.push('[shot] ready flag never set'));
const ev = opt('eval', '');
if (ev) await page.evaluate(ev).catch((e) => logs.push('[eval] ' + e));
await page.waitForTimeout(wait);
// --final 1: the page loaded at a fraction of the resolution (?scale=); draw the last frames at full size.
if (opt('final', '')) await page.evaluate(() => new Promise((res) => {
  const g = globalThis.__garita; if (!g?.engine || !g.state?.renderScale) return res(0);
  g.state.renderScale.value = 1;
  let n = 0; const off = g.engine.onFrame(() => { if (++n >= 3) { off(); res(n); } });
  setTimeout(() => { off(); res(n); }, 240000);
})).catch(() => {});
await page.screenshot({ path: out, type: out.endsWith('.jpg') ? 'jpeg' : 'png', quality: out.endsWith('.jpg') ? 88 : undefined, timeout: 240000 });
const info = await page.evaluate(() => globalThis.__garita?.debug?.() ?? null).catch(() => null);
console.log(JSON.stringify({ out, info, logs: logs.slice(0, 40) }, null, 1));
await browser.close();
