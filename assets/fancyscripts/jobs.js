/* Fancy Scripts — the main-thread side of the pixel worker.
 *
 * runPixelJob(msg, transfer) → Promise<ArrayBuffer>. Starts the worker on
 * first use; if the browser cannot run a module worker (or the worker
 * dies), every job from then on runs the same pixel.js function on the
 * main thread — off the current frame, so a picker drag still gets its
 * paint in before the pass starts. Callers never know which happened.
 */

import { tintHSL, colorizeBack } from './pixel.js';

let worker = null;
let workerDead = false;
let proven = false;
let nextId = 1;
const pending = new Map();

function startWorker() {
  if (worker || workerDead) return;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker');
    worker = new Worker('/assets/fancyscripts/pixel-worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
      proven = true;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.buf);
    };
    worker.onerror = () => {
      // the worker script failed to load or threw at top level: every job
      // in flight is redone inline, and no more are sent
      workerDead = true;
      const inflight = [...pending.values()];
      pending.clear();
      try { worker.terminate(); } catch { /* already gone */ }
      worker = null;
      for (const p of inflight) runInline(p.msg).then(p.resolve, p.reject);
    };
  } catch {
    workerDead = true;
    worker = null;
  }
}

function runInline(msg) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        if (msg.type === 'tint') {
          const d = new Uint8ClampedArray(msg.buf);
          tintHSL(d, msg.dH, msg.sRatio, msg.lRatio);
          resolve(d.buffer);
        } else if (msg.type === 'back') {
          const d = new Uint8ClampedArray(msg.buf);
          const v = new Uint8ClampedArray(msg.vbuf);
          colorizeBack(d, v, msg.p, msg.w, msg.h);
          resolve(d.buffer);
        } else reject(new Error('unknown job'));
      } catch (err) { reject(err); }
    }, 0);
  });
}

export function runPixelJob(msg, transfer) {
  startWorker();
  if (!worker) return runInline(msg);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    // kept so a worker that dies can have its jobs rerun inline
    pending.set(id, { resolve, reject, msg });
    try {
      // Until the worker has answered once the buffers are copied, not
      // handed over: a worker that never started would take them with it,
      // and the inline rerun would be left with empty ones.
      worker.postMessage({ ...msg, id }, proven ? transfer || [] : []);
    } catch (err) {
      pending.delete(id);
      runInline(msg).then(resolve, reject);
    }
  });
}

export function pixelWorkerActive() { return !!worker && !workerDead; }
