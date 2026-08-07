/**
 * Icon Forge — core rendering engine.
 *
 * Turns clean line art / vectors into Blood-on-the-Clocktower-style icons:
 *   1. Rasterize + fit source into a padded square working canvas.
 *   2. Classify pixels into a "colour body" mask and a "white detail" mask.
 *   3. Grow a smooth cream border by stamping the union mask around a circle.
 *   4. Fill each region with the official-style grunge textures, applied as a
 *      single continuous field (pan / zoom / rotate) — the same way the real
 *      icons were made, where every icon is a random crop of one big texture.
 *   5. Composite border → body → details, then downscale for crisp output.
 *
 * Ported from the original TypeScript engine (Icon Forge handoff) to plain
 * browser ES modules — the wiki has no build step. Behaviour is unchanged;
 * only the type annotations are gone. The option documentation the interface
 * carried is kept below, because it IS the reference for every control.
 *
 * OPTIONS (see DEFAULT_OPTIONS for the values):
 *   mode            'auto' (dark pixels → colour texture, light → white
 *                   detail) or 'silhouette' (every opaque pixel → colour).
 *   invert          Swap the dark/light classification (auto), or swap body ↔
 *                   detail in silhouette / keyed modes.
 *   threshold       Luminance cut-off between body and detail, 0–255 (auto).
 *   edgeOuter       Outer silhouette edge softening, output px (0–3).
 *   edgeInner       Inner white-detail edge softening, output px (0–3).
 *   lineThicken     Colour line thickness, output px (−10…+10). Positive
 *                   dilates the colour mask, negative erodes it.
 *   padding         Transparent margin around the art, fraction of canvas.
 *   trim            Auto-crop empty margins before fitting.
 *   removeWhiteBg   Key out a near-white background (scans of line art).
 *   chromaKey       [r,g,b] background colour to key out, or null.
 *   bgTolerance     How hard the white/chroma key bites, 0–100.
 *   aiTolerance     Smart-AI cleanup strength, 0–100. Read by bgremoval.js,
 *                   not by the engine itself.
 *   innerDetails    Enclosed whites become white detail, not holes.
 *   fillHoles       Fill EVERY enclosed space with white texture.
 *   bucketFills     [{x, y, fill}] paint-bucket taps, canvas fractions.
 *                   fill is 'white' | 'color' | 'hatch'.
 *   whiteUnderlay   Krita stack: white texture under the whole silhouette.
 *   highlights      Rim-highlight strength, 0 = off.
 *   highlightAngle  Light direction in degrees (45 = lit from top-left).
 *   highlightWidth  Rim-highlight reach, output px (1–10).
 *   bevel           Auto 3D heightfield shading strength, 0 = off.
 *   bevelSize       Rounded-edge width for that shading, output px.
 *   lineDetails     Local-contrast line extraction strength, 0 = off.
 *   lineRadius      Feature scale for line detection, output px.
 *   lineMode        'dark' | 'bright' | 'both' — which lines to catch.
 *   colorEdges      Colour-boundary edge lines, 0 = off.
 *   texScale        Texture zoom; 1 = texture spans the whole icon.
 *   texRotation     Texture rotation in degrees.
 *   texOffsetX/Y    Texture pan, −1…1 of the field half-width.
 *   colorSat/Bright/Vib/Grad   Colour texture grade (1/1/0/0 = unchanged).
 *   whiteSat/Bright/Vib/Grad   Parchment texture grade.
 *   borderWidth     Border width, output px (0–40).
 *   borderStyle     'white' (official) or 'cream' (paper-textured).
 *   borderEdge      Border edge softening, output px.
 *   shadowOpacity   Drop shadow opacity, 0 = off.
 *   shadowBlur      Drop shadow blur, output px.
 *   shadowDistance  Drop shadow offset, output px.
 *   shadowAngle     Drop shadow direction in degrees (45 = down-right).
 *   splitPosition   Traveller split: divider position across the icon, 0–100%.
 *   splitThickness  Traveller split: divider line thickness, px. 0 = none.
 *   hatchIntensity  Hatching strength, 0 = off.
 *   hatchAngle      Hatching line angle in degrees.
 *   flipH           Mirror the finished icon horizontally.
 *   rotate          Rotate the finished icon, −180…180°.
 */
export const DEFAULT_OPTIONS = {
  mode: 'auto',
  invert: false,
  threshold: 128,
  edgeOuter: 0.8,
  edgeInner: 0.8,
  borderWidth: 4,
  borderStyle: 'white',
  borderEdge: 0.6,
  lineThicken: 0,
  shadowOpacity: 0.4,
  shadowBlur: 8,
  shadowDistance: 6,
  shadowAngle: 45,
  padding: 0.1,
  trim: true,
  removeWhiteBg: false,
  chromaKey: null,
  bgTolerance: 40,
  aiTolerance: 50,
  innerDetails: true,
  fillHoles: true,
  bucketFills: [],
  whiteUnderlay: false,
  highlights: 0.8,
  highlightAngle: 45,
  highlightWidth: 5,
  bevel: 0,
  bevelSize: 10,
  lineDetails: 0.55,
  lineRadius: 6,
  lineMode: 'dark',
  colorEdges: 0.5,
  texScale: 1,
  texRotation: 0,
  texOffsetX: 0,
  texOffsetY: 0,
  colorSat: 1,
  colorBright: 1,
  colorVib: 0,
  colorGrad: 0,
  whiteSat: 1,
  whiteBright: 1,
  whiteVib: 0,
  whiteGrad: 0,
  splitPosition: 50,
  splitThickness: 5,
  hatchIntensity: 0,
  hatchAngle: 45,
  flipH: false,
  rotate: 0,
};
function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function ctx2d(c) {
  const x = c.getContext('2d');
  if (!x) throw new Error('Canvas 2D context unavailable');
  return x;
}
/** Draw a canvas onto another with a blur filter, returning a fresh canvas. */
function blurred(src, radius) {
  if (radius <= 0.01) return src;
  const out = makeCanvas(src.width, src.height);
  const ctx = ctx2d(out);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = 'none';
  return out;
}
/** Find the bounding box of visible ink (alpha, or darkness when keying). */
function findInkBox(data, w, h, key, chroma) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3];
      if (a < 10) continue;
      let ink;
      if (key === 'white') {
        const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        ink = lum < 242;
      } else if (key === 'chroma' && chroma) {
        const dr = data[i] - chroma[0];
        const dg = data[i + 1] - chroma[1];
        const db = data[i + 2] - chroma[2];
        ink = dr * dr + dg * dg + db * db > 40 * 40;
      } else {
        ink = true;
      }
      if (ink) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
/** Rasterize the source into a padded square working canvas of side W. */
function prepSource(source, W, opts) {
  const sw =
    source instanceof HTMLCanvasElement ? source.width : source.naturalWidth || source.width;
  const sh =
    source instanceof HTMLCanvasElement ? source.height : source.naturalHeight || source.height;
  // Draw at natural resolution (capped) so we can measure + crop accurately.
  const cap = 2400;
  const scaleDown = Math.min(1, cap / Math.max(sw, sh));
  const aw = Math.max(1, Math.round(sw * scaleDown));
  const ah = Math.max(1, Math.round(sh * scaleDown));
  const analysis = makeCanvas(aw, ah);
  const actx = ctx2d(analysis);
  actx.imageSmoothingEnabled = true;
  actx.imageSmoothingQuality = 'high';
  actx.drawImage(source, 0, 0, aw, ah);
  let box = { x: 0, y: 0, w: aw, h: ah };
  if (opts.trim) {
    const data = actx.getImageData(0, 0, aw, ah).data;
    const found = findInkBox(
      data,
      aw,
      ah,
      opts.removeWhiteBg ? 'white' : opts.chromaKey ? 'chroma' : 'none',
      opts.chromaKey ?? undefined,
    );
    if (found) {
      const margin = Math.round(Math.max(found.w, found.h) * 0.02) + 1;
      box = {
        x: Math.max(0, found.x - margin),
        y: Math.max(0, found.y - margin),
        w: Math.min(aw, found.w + margin * 2),
        h: Math.min(ah, found.h + margin * 2),
      };
    }
  }
  const out = makeCanvas(W);
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const content = W * (1 - opts.padding * 2);
  const s = Math.min(content / box.w, content / box.h);
  const dw = box.w * s;
  const dh = box.h * s;
  ctx.drawImage(analysis, box.x, box.y, box.w, box.h, (W - dw) / 2, (W - dh) / 2, dw, dh);
  return out;
}
/** Split the fitted source into body / detail / union alpha masks. */
function buildMasks(src, opts, ss) {
  const W = src.width;
  const ctx = ctx2d(src);
  const img = ctx.getImageData(0, 0, W, W);
  const d = img.data;
  let colorImg = new ImageData(W, W);
  let whiteImg = new ImageData(W, W);
  let cd = colorImg.data;
  let wd = whiteImg.data;
  const tol = opts.bgTolerance;
  const keyHi = 255 - tol * 0.6; // fully opaque below this luminance
  // Narrow fade band: a near-binary cut keeps anti-aliased edges crisp
  // (Photoshop-style) instead of turning every grey pixel into fog.
  const keyLo = Math.min(255, keyHi + 12); // fades out to transparent
  const ck = opts.chromaKey;
  const ckLo = tol * 1.6; // colour distance: fully transparent at/below
  const ckHi = Math.min(441, ckLo + 32); // fades up to opaque
  const n = W * W;
  const effA = new Float32Array(n); // alpha after keying
  const lumA = new Uint8Array(n);
  const srcOpaque = new Uint8Array(n); // 1 when the source pixel had alpha
  for (let i = 0; i < d.length; i += 4) {
    const p = i >> 2;
    const sa = d[i + 3];
    let a = sa / 255;
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    lumA[p] = lum;
    srcOpaque[p] = sa > 8 ? 1 : 0;
    if (opts.removeWhiteBg) {
      // Soft-key the near-white background; ink darkness becomes alpha.
      a *= Math.min(1, Math.max(0, (keyLo - lum) / (keyLo - keyHi)));
    } else if (ck) {
      // Chroma key: colour distance from the picked background colour.
      const dr = d[i] - ck[0];
      const dg = d[i + 1] - ck[1];
      const db = d[i + 2] - ck[2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      a *= Math.min(1, Math.max(0, (dist - ckLo) / (ckHi - ckLo)));
    }
    effA[p] = a;
    let cw = 0;
    let ww = 0;
    if (a > 0) {
      if (opts.mode === 'silhouette' || opts.removeWhiteBg || ck) {
        cw = a;
      } else {
        const isColor = opts.invert ? lum >= opts.threshold : lum < opts.threshold;
        if (isColor) cw = a;
        else ww = a;
      }
    }
    cd[i] = 255;
    cd[i + 1] = 255;
    cd[i + 2] = 255;
    cd[i + 3] = Math.round(cw * 255);
    wd[i] = 255;
    wd[i + 1] = 255;
    wd[i + 2] = 255;
    wd[i + 3] = Math.round(ww * 255);
  }
  // Enclosed-space maps: flood-fill the "outside" from the canvas border
  // through transparent pixels. Transparent pixels the fill cannot reach are
  // fully surrounded by ink — enclosed spaces (handle loops, rings, eyes).
  // Computed for the fillHoles/innerDetails rescue AND the paint bucket.
  let openMask;
  let exteriorMask;
  const wantRescue = opts.fillHoles || (opts.innerDetails && opts.mode !== 'silhouette');
  if (wantRescue || opts.bucketFills.length > 0) {
    const open = new Uint8Array(n);
    for (let p = 0; p < n; p++) open[p] = effA[p] < 0.5 ? 1 : 0;
    const seen = new Uint8Array(n);
    const stack = new Int32Array(n);
    let sp = 0;
    const push = (q) => {
      if (open[q] && !seen[q]) {
        seen[q] = 1;
        stack[sp++] = q;
      }
    };
    for (let x = 0; x < W; x++) {
      push(x);
      push((W - 1) * W + x);
    }
    for (let y = 0; y < W; y++) {
      push(y * W);
      push(y * W + W - 1);
    }
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % W;
      const py = (p / W) | 0;
      if (px > 0) push(p - 1);
      if (px < W - 1) push(p + 1);
      if (py > 0) push(p - W);
      if (py < W - 1) push(p + W);
    }
    openMask = open;
    exteriorMask = seen;
    if (wantRescue) {
      for (let p = 0; p < n; p++) {
        if (!open[p] || seen[p]) continue;
        // Paper-coloured (respecting invert), or a hollow transparent region in
        // the source art — either way it reads as a white detail, not a hole.
        const paperLike = opts.invert ? lumA[p] < opts.threshold : lumA[p] >= opts.threshold;
        if (opts.fillHoles || paperLike || !srcOpaque[p]) {
          const i = p << 2;
          cd[i + 3] = 0;
          wd[i + 3] = 255;
        }
      }
    }
  }
  // Local-contrast line extraction — the "line recognition" for coloured art,
  // scans and photos. A pixel that is much darker (or brighter) than the
  // average of its neighbourhood is a *line*, not a region: handle wraps,
  // stitching, hatching. Those become white detail. The neighbourhood average
  // is alpha-weighted so the silhouette edge doesn't register as a line.
  // Skipped in auto+keep mode, where the global ink threshold already does
  // this job properly for black-&-white line art.
  if (
    opts.lineDetails > 0.001 &&
    (opts.mode === 'silhouette' || opts.removeWhiteBg || !!opts.chromaKey)
  ) {
    const lumCanvas = makeCanvas(W);
    const lctx = ctx2d(lumCanvas);
    const lumImg = lctx.createImageData(W, W);
    const ld2 = lumImg.data;
    for (let p = 0; p < n; p++) {
      const i = p << 2;
      ld2[i] = lumA[p];
      ld2[i + 1] = lumA[p];
      ld2[i + 2] = lumA[p];
      ld2[i + 3] = Math.round(effA[p] * 255);
    }
    lctx.putImageData(lumImg, 0, 0);
    // Blur of premultiplied lum*alpha; getImageData un-premultiplies, so the
    // red channel inside the shape is the alpha-weighted neighbourhood mean.
    const mean = ctx2d(blurred(lumCanvas, opts.lineRadius * ss)).getImageData(0, 0, W, W).data;
    // Sensitivity: stronger extraction -> lower contrast threshold.
    const T = 8 + (1 - opts.lineDetails) * 52;
    for (let p = 0; p < n; p++) {
      if (effA[p] <= 0.35) continue;
      const i = p << 2;
      const m = mean[i];
      const darkLine = m - lumA[p] > T;
      const brightLine = lumA[p] - m > T;
      const hit =
        opts.lineMode === 'dark'
          ? darkLine
          : opts.lineMode === 'bright'
            ? brightLine
            : darkLine || brightLine;
      if (hit) {
        cd[i + 3] = 0;
        wd[i + 3] = Math.max(wd[i + 3], Math.round(effA[p] * 255));
      }
    }
  }
  // Colour-edge extraction — finds boundaries between *colours* (brown handle
  // vs black cord, sleeve vs skin) that luminance line detection can't see,
  // and draws them as thin white detail lines. Central-difference gradient on
  // the RGB channels; both samples of a pair must be inside the shape so the
  // silhouette edge never registers as a colour edge.
  if (
    opts.colorEdges > 0.001 &&
    (opts.mode === 'silhouette' || opts.removeWhiteBg || !!opts.chromaKey)
  ) {
    const Te = 20 + (1 - opts.colorEdges) * 110;
    for (let y = 1; y < W - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (effA[p] <= 0.35) continue;
        let gx2 = 0;
        let gy2 = 0;
        if (effA[p - 1] > 0.35 && effA[p + 1] > 0.35) {
          const il = (p - 1) << 2;
          const ir = (p + 1) << 2;
          for (let ch = 0; ch < 3; ch++) {
            const g = d[ir + ch] - d[il + ch];
            gx2 += g * g;
          }
        }
        if (effA[p - W] > 0.35 && effA[p + W] > 0.35) {
          const iu = (p - W) << 2;
          const idn = (p + W) << 2;
          for (let ch = 0; ch < 3; ch++) {
            const g = d[idn + ch] - d[iu + ch];
            gy2 += g * g;
          }
        }
        if (gx2 + gy2 > Te * Te) {
          const i = p << 2;
          cd[i + 3] = 0;
          wd[i + 3] = Math.max(wd[i + 3], Math.round(effA[p] * 255));
        }
      }
    }
  }
  // In keyed / silhouette modes there is no luminance classification for
  // "Invert ink" to flip — so swap the finished body and detail masks instead
  // (white-bodied icons, inverted line art).
  if (opts.invert && (opts.mode === 'silhouette' || opts.removeWhiteBg || opts.chromaKey)) {
    const tmp = colorImg;
    colorImg = whiteImg;
    whiteImg = tmp;
    cd = colorImg.data;
    wd = whiteImg.data;
  }
  // Paint bucket: fill user-picked enclosed regions with colour or parchment.
  // Applied AFTER the invert swap so "parchment" always means parchment, and
  // before thickening/blur so the fill edges soften exactly like fillHoles.
  // A seed on solid ink or in the exterior is ignored (the UI probes first).
  let hatchSeen = null;
  let solidMask = null;
  if (opts.bucketFills.length > 0 && openMask && exteriorMask) {
    const stack = new Int32Array(n);
    const rseen = new Uint8Array(n);
    for (const bf of opts.bucketFills) {
      const sx = Math.min(W - 1, Math.max(0, Math.round(bf.x * (W - 1))));
      const sy = Math.min(W - 1, Math.max(0, Math.round(bf.y * (W - 1))));
      const seed = sy * W + sx;
      // Colour/parchment fills target enclosed open spaces; hatching targets
      // whatever sits under the tap — an enclosed space OR a connected area
      // of solid ink (so body regions can be hatched too).
      let floodMap = openMask;
      if (bf.fill === 'hatch') {
        if (openMask[seed]) {
          if (exteriorMask[seed]) continue;
        } else {
          if (solidMask === null) {
            solidMask = new Uint8Array(n);
            for (let p = 0; p < n; p++) solidMask[p] = effA[p] >= 0.5 ? 1 : 0;
          }
          floodMap = solidMask;
        }
      } else if (!openMask[seed] || exteriorMask[seed]) continue;
      // Reset per fill: two clicks in the same region = last one wins.
      rseen.fill(0);
      let sp = 0;
      rseen[seed] = 1;
      stack[sp++] = seed;
      while (sp > 0) {
        const p = stack[--sp];
        const i = p << 2;
        if (bf.fill === 'hatch') {
          // Keep the region's fill; just mark it for hatching.
          if (hatchSeen === null) hatchSeen = new Uint8Array(n);
          hatchSeen[p] = 1;
        } else if (bf.fill === 'white') {
          cd[i + 3] = 0;
          wd[i + 3] = 255;
        } else {
          cd[i + 3] = 255;
          wd[i + 3] = 0;
        }
        const px = p % W;
        const py = (p / W) | 0;
        // The region is fully enclosed, so the flood never leaves it — no
        // need to consult the exterior map here.
        if (px > 0 && floodMap[p - 1] && !rseen[p - 1]) {
          rseen[p - 1] = 1;
          stack[sp++] = p - 1;
        }
        if (px < W - 1 && floodMap[p + 1] && !rseen[p + 1]) {
          rseen[p + 1] = 1;
          stack[sp++] = p + 1;
        }
        if (py > 0 && floodMap[p - W] && !rseen[p - W]) {
          rseen[p - W] = 1;
          stack[sp++] = p - W;
        }
        if (py < W - 1 && floodMap[p + W] && !rseen[p + W]) {
          rseen[p + W] = 1;
          stack[sp++] = p + W;
        }
      }
    }
  }
  // Ink thickness: dilate the colour mask with a blur-and-levels grow so
  // thin coloured strokes get bolder (and white detail yields to them), or
  // erode it with a blur-and-levels cut so heavy strokes turn finer.
  if (opts.lineThicken > 0.001) {
    const tmp = makeCanvas(W);
    ctx2d(tmp).putImageData(colorImg, 0, 0);
    const g = ctx2d(blurred(tmp, opts.lineThicken * ss * 0.6)).getImageData(0, 0, W, W).data;
    for (let p = 0; p < n; p++) {
      const i = p << 2;
      const add = Math.min(1, Math.max(0, (g[i + 3] / 255 - 0.25) / 0.6));
      if (add > 0) {
        cd[i + 3] = Math.max(cd[i + 3], Math.round(add * 255));
        // White detail is drawn OVER the colour at composite time — the grown
        // ink must eat into the white mask or the thickening stays invisible.
        wd[i + 3] = Math.round(wd[i + 3] * (1 - add));
      }
    }
  } else if (opts.lineThicken < -0.001) {
    const tmp = makeCanvas(W);
    ctx2d(tmp).putImageData(colorImg, 0, 0);
    const g = ctx2d(blurred(tmp, -opts.lineThicken * ss * 0.6)).getImageData(0, 0, W, W).data;
    for (let p = 0; p < n; p++) {
      const i = p << 2;
      if (cd[i + 3] === 0) continue;
      // Fully interior pixels keep their alpha; near the edge the blurred
      // value drops, and the levels cut pushes it to zero — the stroke
      // recedes inward by roughly the blur radius.
      const keep = Math.min(1, Math.max(0, (g[i + 3] / 255 - 0.35) / 0.45));
      cd[i + 3] = Math.round(cd[i + 3] * keep);
    }
  }
  const softOuter = opts.edgeOuter * ss;
  const softInner = opts.edgeInner * ss;
  const color = makeCanvas(W);
  ctx2d(color).putImageData(colorImg, 0, 0);
  const white = makeCanvas(W);
  ctx2d(white).putImageData(whiteImg, 0, 0);
  const colorSoft = blurred(color, softOuter);
  let whiteSoft = blurred(white, softInner);
  // Procedural lighting — crescent highlight strokes merge into the white
  // detail mask (they take the grunge texture); the shadow band darkens the
  // colour fill via a multiply layer at composite time.
  const lighting = buildLighting(colorSoft, whiteSoft, opts, ss);
  if (lighting.rim) {
    const merged = makeCanvas(W);
    const mctx = ctx2d(merged);
    mctx.drawImage(whiteSoft, 0, 0);
    mctx.globalCompositeOperation = 'lighter';
    mctx.drawImage(lighting.rim, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    whiteSoft = merged;
  }
  // Auto shading: light the silhouette as a rounded 3D heightfield — depth
  // for completely flat sources. Specular sheen joins the white detail mask,
  // the shade joins the multiply layer on the colour fill.
  const bevel = buildBevel(colorSoft, opts, ss);
  let shade = lighting.shade;
  if (bevel) {
    const merged = makeCanvas(W);
    const mctx = ctx2d(merged);
    mctx.drawImage(whiteSoft, 0, 0);
    mctx.globalCompositeOperation = 'lighter';
    mctx.drawImage(bevel.spec, 0, 0);
    mctx.globalCompositeOperation = 'source-over';
    whiteSoft = merged;
    if (!shade) {
      shade = bevel.shade;
    } else {
      const sm = makeCanvas(W);
      const smctx = ctx2d(sm);
      smctx.drawImage(shade, 0, 0);
      smctx.globalCompositeOperation = 'multiply';
      smctx.drawImage(bevel.shade, 0, 0);
      shade = sm;
    }
  }
  const union = makeCanvas(W);
  const uctx = ctx2d(union);
  uctx.drawImage(colorSoft, 0, 0);
  uctx.drawImage(whiteSoft, 0, 0);
  // Bucket-picked hatch regions -> soft alpha mask.
  let hatchMask;
  if (hatchSeen !== null) {
    const hc = makeCanvas(W);
    const hctx = ctx2d(hc);
    const him = hctx.createImageData(W, W);
    for (let p = 0; p < n; p++) {
      const i = p << 2;
      him.data[i] = 255;
      him.data[i + 1] = 255;
      him.data[i + 2] = 255;
      him.data[i + 3] = hatchSeen[p] ? 255 : 0;
    }
    hctx.putImageData(him, 0, 0);
    hatchMask = blurred(hc, 0.6 * ss);
  }
  return {
    color: colorSoft,
    white: whiteSoft,
    union,
    shade,
    size: W,
    open: openMask,
    exterior: exteriorMask,
    hatch: hatchMask,
  };
}
/** Distance-transform "pillow" shading: treat the silhouette as a rounded
 *  heightfield (edge = low, deep interior = dome top), derive surface normals
 *  and light them. Pixels darker than the flat interior become a multiply
 *  shade layer; brighter ones become a specular sheen. */
function buildBevel(colorSoft, opts, ss) {
  if (opts.bevel <= 0.001) return null;
  const W = colorSoft.width;
  const n = W * W;
  const alpha = ctx2d(colorSoft).getImageData(0, 0, W, W).data;
  // Two-pass chamfer distance transform from the silhouette edge, measured
  // INTO the shape: background seeds at 0, solid pixels start at infinity and
  // receive their distance to the nearest edge.
  const INF = 1e9;
  const dist = new Float32Array(n);
  for (let p = 0; p < n; p++) dist[p] = alpha[(p << 2) + 3] > 128 ? INF : 0;
  const D2 = Math.SQRT2;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      let d = dist[p];
      if (x > 0) d = Math.min(d, dist[p - 1] + 1);
      if (y > 0) {
        d = Math.min(d, dist[p - W] + 1);
        if (x > 0) d = Math.min(d, dist[p - W - 1] + D2);
        if (x < W - 1) d = Math.min(d, dist[p - W + 1] + D2);
      }
      dist[p] = d;
    }
  }
  for (let y = W - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const p = y * W + x;
      let d = dist[p];
      if (x < W - 1) d = Math.min(d, dist[p + 1] + 1);
      if (y < W - 1) {
        d = Math.min(d, dist[p + W] + 1);
        if (x < W - 1) d = Math.min(d, dist[p + W + 1] + D2);
        if (x > 0) d = Math.min(d, dist[p + W - 1] + D2);
      }
      dist[p] = d;
    }
  }
  // Rounded heightfield: smoothstep dome rising over bevelSize px from the
  // edge. The steepest slope sits mid-band (not at the rim, where the border
  // stroke would cover it), so the shading lands where it's visible.
  const size = Math.max(1, opts.bevelSize * ss);
  const h = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (dist[p] === INF) continue;
    const t = Math.min(1, dist[p] / size);
    h[p] = 0.5 - 0.5 * Math.cos(Math.PI * t);
  }
  // Light the heightfield. The rim-highlight angle counts the direction the
  // light falls TOWARD (45° = top-left lit), so the vector to the light is
  // its opposite.
  const rad = (opts.highlightAngle * Math.PI) / 180;
  const Lx = -Math.cos(rad);
  const Ly = -Math.sin(rad);
  const Lz = 0.9;
  const Llen = Math.hypot(Lx, Ly, Lz);
  const lx = Lx / Llen;
  const ly = Ly / Llen;
  const lz = Lz / Llen;
  // Height-to-slope scale (independent of size). 0.7 keeps the dome slope
  // moderate: steeper tilts make the normal dominate the z-component, which
  // normalizes the lit side back down to ~the flat interior — i.e. lots of
  // shadow but no sheen. This value keeps both sides of the light visible.
  const k = size * 0.7;
  const shade = makeCanvas(W);
  const sctx = ctx2d(shade);
  const sImg = sctx.createImageData(W, W);
  const sd = sImg.data;
  const spec = makeCanvas(W);
  const xctx = ctx2d(spec);
  const xImg = xctx.createImageData(W, W);
  const xd = xImg.data;
  for (let p = 0; p < n; p++) {
    const i = p << 2;
    sd[i] = 255;
    sd[i + 1] = 255;
    sd[i + 2] = 255;
    sd[i + 3] = 255;
    xd[i] = 255;
    xd[i + 1] = 255;
    xd[i + 2] = 255;
    xd[i + 3] = 0;
  }
  for (let y = 1; y < W - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      const i = p << 2;
      const a = alpha[i + 3] / 255;
      if (a < 0.3 || dist[p] === INF) continue;
      const gx = (h[p + 1] - h[p - 1]) * k;
      const gy = (h[p + W] - h[p - W]) * k;
      const nl = Math.hypot(gx, gy, 1);
      const dot = (-gx * lx - gy * ly + lz) / nl;
      const rel = dot / lz; // 1 = flat interior
      const dark = Math.min(1, Math.max(0, 1 - rel) * opts.bevel * 1.4);
      const v = Math.round(255 * (1 - dark * 0.72));
      sd[i] = v;
      sd[i + 1] = v;
      sd[i + 2] = v;
      const sheen = Math.min(1, Math.max(0, rel - 1) * opts.bevel * 1.4);
      xd[i + 3] = Math.round(sheen * 255 * a);
    }
  }
  sctx.putImageData(sImg, 0, 0);
  xctx.putImageData(xImg, 0, 0);
  return { shade: blurred(shade, ss * 1.5), spec: blurred(spec, ss) };
}
/** Directional crescent highlights + form shadow, derived from the body mask
 *  itself: band = body minus a light-direction-shifted copy of itself. The
 *  lit side gets white swooshes, the shadow side gets a soft darkening —
 *  no AI, no cost, and it tracks any shape exactly. */
function buildLighting(colorSoft, whiteSoft, opts, ss) {
  if (opts.highlights <= 0.001) return { rim: null, shade: null };
  const W = colorSoft.width;
  const rad = (opts.highlightAngle * Math.PI) / 180;
  const reach = opts.highlightWidth * ss;
  const dirX = Math.cos(rad);
  const dirY = Math.sin(rad);
  const cd = ctx2d(colorSoft).getImageData(0, 0, W, W).data;
  const wd = ctx2d(whiteSoft).getImageData(0, 0, W, W).data;
  // Soft-threshold shrink keeps the strokes just inside the cream border.
  const ERODE = 0.6;
  const eroded = new Float32Array(W * W);
  for (let p = 0; p < eroded.length; p++) {
    const c = cd[p * 4 + 3] / 255;
    eroded[p] = Math.min(1, Math.max(0, (c - ERODE) / (1 - ERODE)));
  }
  // --- rim: shift the body away from the light; the uncovered band on the
  // lit edge becomes a crescent stroke.
  const lit = makeCanvas(W);
  ctx2d(lit).drawImage(colorSoft, dirX * reach, dirY * reach);
  const ld = ctx2d(lit).getImageData(0, 0, W, W).data;
  // --- shadow-side reference (computed first: the rim needs it). Shift the
  // body toward the light; the uncovered band on the shadow edge both drives
  // the form shading and measures local thickness for the rim.
  const dark = makeCanvas(W);
  ctx2d(dark).drawImage(colorSoft, -dirX * reach * 1.6, -dirY * reach * 1.6);
  const dd = ctx2d(dark).getImageData(0, 0, W, W).data;
  const rimRaw = makeCanvas(W);
  const rctx = ctx2d(rimRaw);
  const rimImg = rctx.createImageData(W, W);
  const rd = rimImg.data;
  for (let p = 0; p < eroded.length; p++) {
    const i = p * 4;
    const w = wd[i + 3] / 255;
    const band = Math.min(1, Math.max(0, eroded[p] - ld[i + 3] / 255)) * (1 - w);
    // Parabolic profile: the stroke peaks mid-band and dies at depth, so it
    // stays a fixed-depth crescent instead of a wash.
    const r = Math.min(1, 4 * band * (1 - band) * 1.35) * opts.highlights;
    rd[i] = 255;
    rd[i + 1] = 255;
    rd[i + 2] = 255;
    rd[i + 3] = Math.round(r * 255);
  }
  rctx.putImageData(rimImg, 0, 0);
  // Thin-shape guard: where the rim would cover most of the local shape
  // (whip cords, blades, staffs), it reads as a white flood, not a stroke —
  // line extraction owns the inner detail there, so the rim backs off.
  // Measure local coverage of shape vs rim and cap the ratio.
  const covR = Math.max(2, reach * 1.2);
  const shapeCov = ctx2d(blurred(colorSoft, covR)).getImageData(0, 0, W, W).data;
  const rimCov = ctx2d(blurred(rimRaw, covR)).getImageData(0, 0, W, W).data;
  const rim = makeCanvas(W);
  const r2ctx = ctx2d(rim);
  const rim2Img = r2ctx.createImageData(W, W);
  const rd2 = rim2Img.data;
  const rawD = rctx.getImageData(0, 0, W, W).data;
  for (let p = 0; p < eroded.length; p++) {
    const i = p * 4;
    const sc = shapeCov[i + 3] / 255;
    if (sc < 0.04) continue;
    const ratio = rimCov[i + 3] / 255 / sc;
    const guard = Math.min(1, Math.max(0, 1 - (ratio - 0.5) * 3));
    const a = Math.round((rawD[i + 3] / 255) * guard * 255);
    rd2[i] = 255;
    rd2[i + 1] = 255;
    rd2[i + 2] = 255;
    rd2[i + 3] = a;
  }
  r2ctx.putImageData(rim2Img, 0, 0);
  // --- shade: the shadow-edge band darkens the colour texture.
  const shade = makeCanvas(W);
  const sctx = ctx2d(shade);
  const shadeImg = sctx.createImageData(W, W);
  const sd2 = shadeImg.data;
  const depth = 0.42 * Math.min(1, opts.highlights * 0.7);
  for (let p = 0; p < eroded.length; p++) {
    const i = p * 4;
    const w = wd[i + 3] / 255;
    const band = Math.max(0, eroded[p] - dd[i + 3] / 255) * (1 - w);
    const v = Math.round(255 * (1 - Math.min(1, band) * depth));
    sd2[i] = v;
    sd2[i + 1] = v;
    sd2[i + 2] = v;
    sd2[i + 3] = 255;
  }
  sctx.putImageData(shadeImg, 0, 0);
  return {
    rim: blurred(rim, Math.max(0.4 * ss, reach * 0.2)),
    shade: blurred(shade, Math.max(1 * ss, reach * 0.5)),
  };
}
/** Grow the union mask outward into a smooth ring (the cream sticker border). */
function buildBorder(union, widthPx, edgePx) {
  const W = union.width;
  const out = makeCanvas(W);
  const ctx = ctx2d(out);
  const r = widthPx;
  if (r <= 0) {
    ctx.drawImage(union, 0, 0);
    return out;
  }
  const stamps = Math.min(40, Math.max(14, Math.round(r * 2.2)));
  for (let i = 0; i < stamps; i++) {
    const ang = (i / stamps) * Math.PI * 2;
    ctx.drawImage(union, Math.cos(ang) * r, Math.sin(ang) * r);
  }
  // r*0.06 hides polygonal stamping artifacts; edgePx is the user sharpness.
  return blurred(out, r * 0.06 + edgePx);
}
/** Render one texture as a continuous transformed field covering the canvas.
 *  Uses mirror-tiled drawImage calls (instead of CanvasPattern) so coverage is
 *  guaranteed at any pan/zoom/rotation, with no visible seams in the grain. */
function textureField(tex, W, opts) {
  const out = makeCanvas(W);
  const ctx = ctx2d(out);
  const fit = W / tex.width; // userScale 1 -> texture spans the icon
  const s = fit * opts.texScale;
  const m = new DOMMatrix()
    .translate(
      W / 2 + (opts.texOffsetX * tex.width * s) / 2,
      W / 2 + (opts.texOffsetY * tex.height * s) / 2,
    )
    .rotate(opts.texRotation)
    .scale(s);
  // Map the canvas corners back into texture space to find the needed tiles.
  const inv = m.inverse();
  const xs = [];
  const ys = [];
  for (const [px, py] of [
    [0, 0],
    [W, 0],
    [0, W],
    [W, W],
  ]) {
    const p = inv.transformPoint(new DOMPoint(px, py));
    xs.push(p.x);
    ys.push(p.y);
  }
  const minTX = Math.floor(Math.min(...xs) / tex.width);
  const maxTX = Math.floor(Math.max(...xs) / tex.width);
  const minTY = Math.floor(Math.min(...ys) / tex.height);
  const maxTY = Math.floor(Math.max(...ys) / tex.height);
  ctx.setTransform(m);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      ctx.save();
      ctx.translate(tx * tex.width, ty * tex.height);
      // Mirror every other tile so edges join seamlessly.
      if (((tx % 2) + 2) % 2 === 1) {
        ctx.translate(tex.width, 0);
        ctx.scale(-1, 1);
      }
      if (((ty % 2) + 2) % 2 === 1) {
        ctx.translate(0, tex.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(tex, 0, 0);
      ctx.restore();
    }
  }
  ctx.resetTransform();
  return out;
}
/** Clip a texture field to an alpha mask (keeps only where mask is opaque). */
function clipToMask(field, mask) {
  const ctx = ctx2d(field);
  ctx.setTransform(1, 0, 0, 1, 0, 0); // never inherit a leftover transform
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return field;
}
/** Progressive halving downscale — much crisper than a single big jump. */
function downscale(master, target) {
  let cur = master;
  while (cur.width / 2 >= target) {
    const half = makeCanvas(cur.width / 2, cur.height / 2);
    const ctx = ctx2d(half);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  if (cur.width !== target) {
    const out = makeCanvas(target);
    const ctx = ctx2d(out);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, target, target);
    cur = out;
  }
  return cur;
}
/** Per-pixel texture grade: saturation, brightness, vibrance (boosts dull
 *  pixels more than vivid ones) and a top-light gradient. Skipped entirely
 *  when everything is at its default. */
function adjustField(field, sat, bright, vib, grad) {
  if (sat === 1 && bright === 1 && vib === 0 && grad === 0) return field;
  const W = field.width;
  const ctx = ctx2d(field);
  const img = ctx.getImageData(0, 0, W, W);
  const d = img.data;
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < W; y++) {
    const gf = 1 - grad * (y / W) * 0.7;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) << 2;
      if (d[i + 3] === 0) continue;
      let r = d[i] * bright;
      let g = d[i + 1] * bright;
      let b = d[i + 2] * bright;
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const ps = mx > 0 ? (mx - mn) / mx : 0;
      const boost = sat + vib * (1 - ps);
      r = lum + (r - lum) * boost;
      g = lum + (g - lum) * boost;
      b = lum + (b - lum) * boost;
      d[i] = clamp(r * gf);
      d[i + 1] = clamp(g * gf);
      d[i + 2] = clamp(b * gf);
    }
  }
  ctx.putImageData(img, 0, 0);
  return field;
}
/** Classify a paint-bucket click at canvas fraction (fx, fy): does the spot
 *  land in an enclosed open region, the exterior background, or on ink? */
export function probeBucket(source, opts, fx, fy) {
  const PW = 591;
  const fitted = prepSource(source, PW, opts);
  // A dummy fill at the seed guarantees the enclosed-space maps are computed
  // even when fillHoles/innerDetails are off; the masks are discarded anyway.
  const masks = buildMasks(
    fitted,
    { ...opts, bucketFills: [{ x: fx, y: fy, fill: 'white' }] },
    1,
  );
  const W = masks.size;
  const sx = Math.min(W - 1, Math.max(0, Math.round(fx * (W - 1))));
  const sy = Math.min(W - 1, Math.max(0, Math.round(fy * (W - 1))));
  const p = sy * W + sx;
  if (!masks.open || !masks.exterior) return 'open';
  if (!masks.open[p]) return 'solid';
  return masks.exterior[p] ? 'open' : 'enclosed';
}
/** Deterministic pseudo-random from a seed (stable hatching across renders). */
function hatchRand(seed) {
  const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}
/** Hand-drawn style hatch lines: parallel dashed strokes at an angle, with
 *  per-line jitter, gaps and weight variation so it reads as ink, not a grid. */
export function buildHatch(W, angleDeg, intensity, ss) {
  const c = makeCanvas(W);
  const ctx = ctx2d(c);
  ctx.translate(W / 2, W / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  const spacing = Math.max(4, 6 * ss);
  const R = W; // generous: rotated lines must still cover every corner
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1, 2.2 * ss);
  const alpha = 0.35 + 0.55 * intensity;
  let row = 0;
  for (let y = -R; y <= R; y += spacing, row++) {
    ctx.beginPath();
    let x = -R + hatchRand(row * 2.71) * spacing * 2;
    while (x < R) {
      const seg = spacing * (2 + hatchRand(row * 3.3 + x * 0.01) * 3.5);
      const gap = spacing * (0.35 + hatchRand(row - x * 0.013) * 1.1);
      ctx.moveTo(x, y + (hatchRand(x * 1.31 + row) - 0.5) * ss);
      ctx.lineTo(x + seg, y + (hatchRand(x * 2.17 - row) - 0.5) * ss);
      x += seg + gap;
    }
    ctx.globalAlpha = alpha * (0.65 + hatchRand(row * 7.7) * 0.35);
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0); // leave no rotation/translation behind
  return c;
}
export function renderIcon(source, opts, tex, outputSize, supersample = 2) {
  // One-shot render (export path) — a throwaway cache still lets the two
  // white-texture uses share one field within this call.
  return renderCached(source, opts, tex, outputSize, supersample, newPipelineCache());
}
/* ------------------------------------------------------------------ *
 *  Progressive rendering support                                       *
 *                                                                     *
 *  The pipeline splits into stages, each cached by the exact subset of *
 *  options it reads. Slider drags that only touch composite options    *
 *  (texture tweaks, hatching, shadow, split) skip the mask rebuild     *
 *  entirely — that is the expensive part.                              *
 * ------------------------------------------------------------------ */
/** Options that affect prepSource + buildMasks (the pixel-heavy stages). */
const MASK_OPTS = [
  'trim',
  'padding',
  'removeWhiteBg',
  'chromaKey',
  'bgTolerance',
  'mode',
  'threshold',
  'invert',
  'fillHoles',
  'innerDetails',
  'colorEdges',
  'lineDetails',
  'lineMode',
  'lineRadius',
  'lineThicken',
  'edgeOuter',
  'edgeInner',
  'highlights',
  'highlightAngle',
  'highlightWidth',
  'bevel',
  'bevelSize',
];
/** Options that affect a tiled texture field (before colour adjustment). */
const TEX_OPTS = ['texScale', 'texRotation', 'texOffsetX', 'texOffsetY'];
/** Object identity -> small integer, for cache keys. */
const idMap = new WeakMap();
let nextId = 1;
function objId(o) {
  let id = idMap.get(o);
  if (id === undefined) {
    id = nextId++;
    idMap.set(o, id);
  }
  return id;
}
function newPipelineCache() {
  return {
    prep: null,
    masks: null,
    border: null,
    rawColor: null,
    rawColor2: null,
    rawWhite: null,
    colorField: null,
    whiteField: null,
    hatch: null,
  };
}
export function createIconRenderer() {
  let cache = newPipelineCache();
  return {
    render(source, opts, tex, outputSize, supersample = 2) {
      return renderCached(source, opts, tex, outputSize, supersample, cache);
    },
    clear() {
      cache = newPipelineCache();
    },
  };
}
function cloneCanvas(src) {
  const out = makeCanvas(src.width, src.height);
  ctx2d(out).drawImage(src, 0, 0);
  return out;
}
function pickOpts(opts, keys) {
  const rec = opts;
  return JSON.stringify(keys.map((k) => rec[k]));
}
function renderCached(source, opts, tex, outputSize, supersample, cache) {
  const ss = supersample;
  const W = outputSize * ss;
  // -- Stage 1: fitted source + masks (the expensive pixel work) ---------
  const prepKey = `${objId(source)}|${W}|${pickOpts(opts, ['trim', 'padding', 'removeWhiteBg', 'chromaKey'])}`;
  let fitted;
  if (cache.prep && cache.prep.key === prepKey) {
    fitted = cache.prep.canvas;
  } else {
    fitted = prepSource(source, W, opts);
    cache.prep = { key: prepKey, canvas: fitted };
  }
  const maskKey = `${prepKey}|${ss}|${pickOpts(opts, MASK_OPTS)}|${JSON.stringify(opts.bucketFills)}`;
  let masks;
  if (cache.masks && cache.masks.key === maskKey) {
    masks = cache.masks.masks;
  } else {
    masks = buildMasks(fitted, opts, ss);
    cache.masks = { key: maskKey, masks };
  }
  const borderKey = `${maskKey}|${opts.borderWidth}|${opts.borderEdge}`;
  let border;
  if (cache.border && cache.border.key === borderKey) {
    border = cache.border.canvas;
  } else {
    border = buildBorder(masks.union, opts.borderWidth * ss, opts.borderEdge * ss);
    cache.border = { key: borderKey, canvas: border };
  }
  // -- Stage 2: texture fields -------------------------------------------
  // One continuous field per texture so border, body and details all line up —
  // exactly like the official icons, which are crops of a single texture sheet.
  const texKey = `${W}|${pickOpts(opts, TEX_OPTS)}`;
  const rawColorKey = `${objId(tex.color)}|${texKey}`;
  let rawColor;
  if (cache.rawColor && cache.rawColor.key === rawColorKey) {
    rawColor = cache.rawColor.canvas;
  } else {
    rawColor = textureField(tex.color, W, opts);
    cache.rawColor = { key: rawColorKey, canvas: rawColor };
  }
  const rawWhiteKey = `${objId(tex.white)}|${texKey}`;
  let rawWhite;
  if (cache.rawWhite && cache.rawWhite.key === rawWhiteKey) {
    rawWhite = cache.rawWhite.canvas;
  } else {
    rawWhite = textureField(tex.white, W, opts);
    cache.rawWhite = { key: rawWhiteKey, canvas: rawWhite };
  }
  const splitOn = tex.color2 != null;
  const divX = Math.round((W * opts.splitPosition) / 100);
  const divHalf = Math.max(0, (opts.splitThickness * ss) / 2);
  const colorFieldKey = `${rawColorKey}|${splitOn ? `${objId(tex.color2)}|${opts.splitPosition}|${opts.splitThickness}` : ''}|${opts.colorSat}|${opts.colorBright}|${opts.colorVib}|${opts.colorGrad}`;
  let colorFieldCached;
  if (cache.colorField && cache.colorField.key === colorFieldKey) {
    colorFieldCached = cache.colorField.canvas;
  } else {
    const field = adjustField(
      cloneCanvas(rawColor),
      opts.colorSat,
      opts.colorBright,
      opts.colorVib,
      opts.colorGrad,
    );
    // Traveller split: colour texture on the left of the divider, second
    // (evil) texture on the right. The divider line itself is drawn later, on
    // top of the whole sticker.
    if (splitOn) {
      const raw2Key = `${objId(tex.color2)}|${texKey}`;
      let raw2;
      if (cache.rawColor2 && cache.rawColor2.key === raw2Key) {
        raw2 = cache.rawColor2.canvas;
      } else {
        raw2 = textureField(tex.color2, W, opts);
        cache.rawColor2 = { key: raw2Key, canvas: raw2 };
      }
      const field2 = adjustField(
        cloneCanvas(raw2),
        opts.colorSat,
        opts.colorBright,
        opts.colorVib,
        opts.colorGrad,
      );
      const fctx = ctx2d(field);
      fctx.save();
      fctx.beginPath();
      fctx.rect(divX + divHalf, 0, W - divX - divHalf, W);
      fctx.clip();
      fctx.drawImage(field2, 0, 0);
      fctx.restore();
    }
    colorFieldCached = field;
    cache.colorField = { key: colorFieldKey, canvas: field };
  }
  const whiteFieldKey = `${rawWhiteKey}|${opts.whiteSat}|${opts.whiteBright}|${opts.whiteVib}|${opts.whiteGrad}`;
  let whiteFieldCached;
  if (cache.whiteField && cache.whiteField.key === whiteFieldKey) {
    whiteFieldCached = cache.whiteField.canvas;
  } else {
    whiteFieldCached = adjustField(
      cloneCanvas(rawWhite),
      opts.whiteSat,
      opts.whiteBright,
      opts.whiteVib,
      opts.whiteGrad,
    );
    cache.whiteField = { key: whiteFieldKey, canvas: whiteFieldCached };
  }
  // -- Stage 3: composite -------------------------------------------------
  // Everything below mutates canvases, so cached stages are cloned first.
  let borderFill;
  if (opts.borderStyle === 'white') {
    // Official border: a clean pure-white stroke, no texture.
    const solid = makeCanvas(W);
    const sctx = ctx2d(solid);
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, W, W);
    borderFill = clipToMask(solid, border);
  } else {
    borderFill = clipToMask(cloneCanvas(whiteFieldCached), border);
  }
  const colorFill = clipToMask(cloneCanvas(colorFieldCached), masks.color);
  if (masks.shade) {
    // Form shading: darken the body texture on the shadow side. Multiply with
    // an opaque layer makes the whole canvas opaque, so re-clip afterwards.
    const cctx = ctx2d(colorFill);
    cctx.globalCompositeOperation = 'multiply';
    cctx.drawImage(masks.shade, 0, 0);
    cctx.globalCompositeOperation = 'destination-in';
    cctx.drawImage(masks.color, 0, 0);
    cctx.globalCompositeOperation = 'source-over';
  }
  // Hatching: dark ink lines multiplied into the colour fill — bucket-picked
  // regions when present, otherwise the whole colour body (auto mode).
  if (opts.hatchIntensity > 0.001) {
    const hatchKey = `${W}|${ss}|${opts.hatchAngle}|${opts.hatchIntensity}`;
    let hatch;
    if (cache.hatch && cache.hatch.key === hatchKey) {
      hatch = cloneCanvas(cache.hatch.canvas);
    } else {
      hatch = buildHatch(W, opts.hatchAngle, opts.hatchIntensity, ss);
      cache.hatch = { key: hatchKey, canvas: hatch };
      hatch = cloneCanvas(hatch);
    }
    const area = masks.hatch ?? masks.color;
    const clipped = clipToMask(hatch, area);
    const hctx = ctx2d(colorFill);
    hctx.globalCompositeOperation = 'multiply';
    hctx.drawImage(clipped, 0, 0);
    hctx.globalCompositeOperation = 'destination-in';
    hctx.drawImage(masks.color, 0, 0);
    hctx.globalCompositeOperation = 'source-over';
  }
  const whiteFill = clipToMask(cloneCanvas(rawWhite), masks.white);
  const master = makeCanvas(W);
  const mctx = ctx2d(master);
  // Drop shadow behind the whole sticker (silhouette = body ∪ border ring).
  if (opts.shadowOpacity > 0.001) {
    const sil = makeCanvas(W);
    const sx = ctx2d(sil);
    sx.drawImage(masks.union, 0, 0);
    sx.drawImage(border, 0, 0);
    const black = makeCanvas(W);
    const bx = ctx2d(black);
    bx.fillStyle = '#000000';
    bx.fillRect(0, 0, W, W);
    bx.globalCompositeOperation = 'destination-in';
    bx.drawImage(sil, 0, 0);
    const soft = blurred(black, opts.shadowBlur * ss);
    const rad = (opts.shadowAngle * Math.PI) / 180;
    mctx.globalAlpha = Math.min(1, opts.shadowOpacity);
    mctx.drawImage(
      soft,
      Math.cos(rad) * opts.shadowDistance * ss,
      Math.sin(rad) * opts.shadowDistance * ss,
    );
    mctx.globalAlpha = 1;
  }
  mctx.drawImage(borderFill, 0, 0);
  if (opts.whiteUnderlay) {
    // Krita stack: a solid white-texture layer under the whole silhouette.
    mctx.drawImage(clipToMask(cloneCanvas(whiteFieldCached), masks.union), 0, 0);
  }
  mctx.drawImage(colorFill, 0, 0);
  mctx.drawImage(whiteFill, 0, 0);
  // Traveller split divider: a clean white line spanning the whole sticker,
  // drawn over body and details (official Traveller style).
  if (splitOn && divHalf > 0) {
    const line = makeCanvas(W);
    const lctx = ctx2d(line);
    lctx.fillStyle = '#ffffff';
    lctx.fillRect(divX - divHalf, 0, divHalf * 2, W);
    lctx.globalCompositeOperation = 'destination-in';
    const sil2 = ctx2d(makeCanvas(W));
    sil2.drawImage(masks.union, 0, 0);
    sil2.drawImage(border, 0, 0);
    lctx.drawImage(sil2.canvas, 0, 0);
    mctx.drawImage(line, 0, 0);
  }
  const out = downscale(master, outputSize);
  // Orientation: mirror and/or rotate the finished sticker. Applied last, on
  // the downscaled output, so it stays crisp and never touches the caches.
  if (opts.flipH || Math.abs(opts.rotate) > 0.001) {
    const turned = makeCanvas(outputSize);
    const tctx = ctx2d(turned);
    tctx.translate(outputSize / 2, outputSize / 2);
    tctx.rotate((opts.rotate * Math.PI) / 180);
    // Shrink just enough that the square sticker's corners stay on-canvas
    // at any angle (no clipping at 45°).
    const rad = Math.abs(((opts.rotate % 180) * Math.PI) / 180);
    const fit = Math.min(1, 1 / (Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad))));
    tctx.scale(fit, fit);
    if (opts.flipH) tctx.scale(-1, 1);
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(out, -outputSize / 2, -outputSize / 2);
    return turned;
  }
  return out;
}
