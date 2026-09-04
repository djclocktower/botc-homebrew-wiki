/* Fancy Scripts — the Web Worker that runs the per-pixel passes.
 *
 * A module worker (jobs.js starts it with {type: 'module'}) so the maths
 * is imported from pixel.js rather than copied. Messages carry the RGBA
 * buffer as a transferable, so nothing is copied in either direction:
 *   {type: 'tint', id, buf, dH, sRatio, lRatio}         → {id, buf}
 *   {type: 'back', id, buf, vbuf, p, w, h}              → {id, buf}
 * A thrown error comes back as {id, error} and jobs.js falls back to the
 * main thread for that job.
 */

import { tintHSL, colorizeBack } from './pixel.js';

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'tint') {
      const d = new Uint8ClampedArray(m.buf);
      tintHSL(d, m.dH, m.sRatio, m.lRatio);
      self.postMessage({ id: m.id, buf: d.buffer }, [d.buffer]);
    } else if (m.type === 'back') {
      const d = new Uint8ClampedArray(m.buf);
      const v = new Uint8ClampedArray(m.vbuf);
      colorizeBack(d, v, m.p, m.w, m.h);
      self.postMessage({ id: m.id, buf: d.buffer }, [d.buffer]);
    } else {
      self.postMessage({ id: m.id, error: 'unknown job' });
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
