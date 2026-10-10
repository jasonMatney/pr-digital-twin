// The store in a real browser: start-up, persistence across a reload, and several tabs of one profile at once.
// Needs a served store.html, so it only runs when told where one is:
//   STORE_URL=http://127.0.0.1:5280/store.html node --test tests/ontology-browser.test.ts
// Optional: STORE_URL_B (the same build under another path of the origin, e.g. .../dev/r2/store.html) and
// STORE_HOLDER_URL (any other page of the origin; used to block the storage from outside the store).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const urlA = process.env.STORE_URL;
const urlB = process.env.STORE_URL_B ?? urlA;
const holderUrl = process.env.STORE_HOLDER_URL;

test('browser: cold and warm start, two tabs at once, handover, blocked storage', { skip: !urlA && 'set STORE_URL to run', timeout: 180000 }, async () => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext();
    const errors: string[] = [];
    const newPage = async () => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(String(e))); return p; };
    // store-dev.ts records `readyMs` (since navigation start) the moment store.ready resolves.
    const state = async (page: any, label: string) => {
      await page.waitForFunction(() => { const d = (globalThis as any).__garita?.debug?.(); return d && (d.readyMs != null || d.error); }, null, { timeout: 20000 });
      const early = await page.evaluate(() => (globalThis as any).__garita.debug());
      await page.waitForFunction(() => (globalThis as any).__garita.ready, null, { timeout: 60000 });
      const d = await page.evaluate(() => (globalThis as any).__garita.debug());
      assert.equal(d.error, undefined, `${label}: ${d.error}`);
      console.log(`# ${label}: ready ${early.readyMs} ms after navigation, ${d.vfs}, ${d.origin}, worker ${JSON.stringify(d.timings)}${d.notes.length ? `, notes: ${d.notes.join(' | ').slice(0, 160)}` : ''}`);
      return { readyMs: early.readyMs as number, persistent: early.info.persistent as boolean, objects: early.info.objects as number, origin: d.origin as string, stages: d.stages as string[] };
    };

    const solo = await newPage();
    await solo.goto(urlA!);
    const cold = await state(solo, 'cold start');
    assert.equal(cold.persistent, true);
    assert.ok(cold.stages.includes('ready 1.00'), 'onProgress reported the stages');
    await solo.reload();
    const warm = await state(solo, 'warm start');
    assert.deepEqual([warm.persistent, warm.origin], [true, 'existing']);
    assert.ok(warm.objects >= cold.objects, 'what the first visit ingested is still there');
    await solo.close();

    const a = await newPage(), b = await newPage();
    await Promise.all([a.goto(urlA!), b.goto(urlB!)]);
    const sa = await state(a, 'tab A, opened together with B'), sb = await state(b, 'tab B');
    assert.ok(sa.readyMs <= 5000 && sb.readyMs <= 5000, 'both tabs are ready within 5 s');
    assert.notEqual(sa.persistent, sb.persistent, 'exactly one tab owns the persistent database');
    assert.ok((sa.persistent ? sb : sa).objects > 0, 'the other tab works on a copy of the seed');
    const owner = sa.persistent ? a : b, other = sa.persistent ? b : a;
    await owner.close();
    await other.reload();
    assert.equal((await state(other, 'the other tab, reloaded after the owner closed')).persistent, true);
    await other.close();

    if (holderUrl) {
      // A worker outside the store takes the pool's files without taking the tab lock: storage fails outright.
      const holder = await newPage();
      await holder.goto(holderUrl);
      const held = await holder.evaluate(() => new Promise((res) => {
        const src = `(async () => { const root = await navigator.storage.getDirectory(); const d = await (await root.getDirectoryHandle('.garita-db')).getDirectoryHandle('.opaque'); self.keep = []; for await (const [, h] of d.entries()) self.keep.push(await h.createSyncAccessHandle()); postMessage(self.keep.length); })().catch((e) => postMessage('ERR ' + e));`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = (e) => { (globalThis as any).__holder = w; res(e.data); };
      }));
      assert.ok(typeof held === 'number' && held > 0, `holder took ${held}`);
      const victim = await newPage();
      await victim.goto(urlA!);
      const v = await state(victim, `storage blocked (${held} files held elsewhere)`);
      assert.ok(v.persistent === false && v.objects > 0 && v.readyMs <= 5000, 'falls back to memory with the data');
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
