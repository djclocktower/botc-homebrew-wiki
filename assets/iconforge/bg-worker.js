/* Icon Forge — background removal, off the main thread.

   The segmentation is a neural network running under the ONNX runtime's
   WebAssembly build, and it is NOT incremental: a single call chews through
   several seconds of solid CPU. On the main thread that freezes the tab —
   no scrolling, no clicking, and no way for the progress bar to move, so the
   page looks crashed. Here it is just a busy worker; the page stays live and
   the reported progress actually animates.

   Everything this file touches is worker-safe: the vendored library prefers
   OffscreenCanvas and only falls back to document.createElement when it has
   to, and the artwork travels in and out as transferable ImageBitmaps.

   Messages in:  { bitmap }              — the artwork, transferred
   Messages out: { type: 'progress', fraction, label }
                 { type: 'done', bitmap }   — the cutout, transferred
                 { type: 'error', message, stage } */

/** Composite onto opaque white. The segmentation model reads RGB and ignores
 *  the alpha channel, so transparent pixels arrive as BLACK — including the
 *  spots an editor erased, which would otherwise come back as ghost blobs in
 *  the cutout. White reads as empty background. */
function toWhiteBackedBlob(bitmap) {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

self.onmessage = async (e) => {
  const bitmap = e.data && e.data.bitmap;
  if (!bitmap) return;
  // Which step failed matters to the page: a failure before the model has
  // been asked for means the worker itself is unusable (an old browser, a
  // blocked module import), and the page retries on the main thread.
  let stage = 'load';
  try {
    const { removeBackground } = await import('./vendor/imgly-bg-removal.js');
    stage = 'prepare';
    const blob = await toWhiteBackedBlob(bitmap);
    bitmap.close();
    stage = 'run';
    const out = await removeBackground(blob, {
      // Quantized small model: ~4x smaller download than the default, and for
      // bold line-art shapes the segmentation difference is negligible.
      model: 'isnet_quint8',
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        self.postMessage({
          type: 'progress',
          fraction: total > 0 ? current / total : 0,
          label: String(key).startsWith('fetch:')
            ? 'Downloading the AI model…'
            : 'Cutting out the background…'
        });
      }
    });
    const cutout = await createImageBitmap(out);
    self.postMessage({ type: 'done', bitmap: cutout }, [cutout]);
  } catch (err) {
    self.postMessage({
      type: 'error',
      stage,
      message: (err && err.message) || String(err)
    });
  }
};
