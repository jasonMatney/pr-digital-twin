// Must be imported before @takram/three-atmosphere, which captures window.requestIdleCallback when it loads and uses
// it to spread the atmosphere's table precompute over idle time. A hidden page gets no idle callbacks, so the
// physical sky would never come up there (background tab, the owner's hidden browser pane): while the document is
// hidden, callbacks are run from a MessageChannel instead. A visible page is untouched.
const native = typeof window !== 'undefined' && window.requestIdleCallback ? window.requestIdleCallback.bind(window) : null;
if (native) {
  const ch = new MessageChannel();
  const queue: IdleRequestCallback[] = [];
  ch.port1.onmessage = () => { const cb = queue.shift(); if (cb) { try { cb({ didTimeout: true, timeRemaining: () => 0 }); } catch (e) { console.error(e); } } };
  window.requestIdleCallback = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => {
    if (!document.hidden) return native(cb, opts);
    queue.push(cb); ch.port2.postMessage(0);
    return 0;
  };
}
export {};
