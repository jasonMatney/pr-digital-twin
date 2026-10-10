// Test page for the buildings layer: the whole scene, no UI.
//   ?cam=lon,lat,range,heading,pitch  ?t=<ISO>  ?sea=<m>  ?overlay=nfhl  ?q=low|medium|high  ?pump=1
import { bootApp } from '../app';
import { flag } from '../core/config';
import { createBuildings } from '../world/buildings/index';

// ?pump=1: drive frames from a MessageChannel instead of requestAnimationFrame, so the page keeps rendering in a
// hidden or background tab (testing only: it spins the CPU).
if (flag('pump')) {
  const ch = new MessageChannel(); let cb: FrameRequestCallback | null = null, last = 0;
  ch.port1.onmessage = () => {
    const now = performance.now();
    if (now - last < 15.5) { ch.port2.postMessage(0); return; }
    last = now; const c = cb; cb = null; c?.(now);
  };
  (globalThis as any).requestAnimationFrame = (f: FrameRequestCallback) => { cb = f; ch.port2.postMessage(0); return 1; };
}
bootApp({ layers: [createBuildings] });
