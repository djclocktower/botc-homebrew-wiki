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
let nextId = 1;
const pending = new Map();

function startWorker() {
  if (worker || workerDead) return;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker');
    worker = new Worker('/assets/fancyscripts/pixel-worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data || {};
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
    // keep a copy of the message shape (not the buffers, which are about
    // to be transferred) so a dead worker can rerun it — the buffers are
    // handed back untouched by a worker that never started
    pending.set(id, { resolve, reject, msg });
    try {
      worker.postMessage({ ...msg, id }, transfer || []);
    } catch (err) {
      pending.delete(id);
      runInline(msg).then(resolve, reject);
    }
  });
}

export function pixelWorkerActive() { return !!worker && !workerDead; }
