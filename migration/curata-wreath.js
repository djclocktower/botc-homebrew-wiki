/* The Curata mark: a laurel wreath, as one SVG path per branch.
   ----------------------------------------------------------------------
   This is the SOURCE for the wreath that is inlined as a data: URI in
   assets/styles.css (`--curata-svg`). The wreath is not hand-drawn: two
   mirrored branches, each a tapered circular stem arc with almond leaves
   placed along it — outer and inner rows, all tilted forward towards the
   branch tip. Kept here so the shape can be re-tuned (leaf count, size,
   tilt, gap at the top) and re-emitted rather than edited by hand as path
   data, the same way the other migration/ scripts are kept for reference.

       node migration/curata-wreath.js

   Paste the output into the url("data:image/svg+xml;utf8,...") in the
   :root { --curata-svg } rule in assets/styles.css. It must stay free of
   `"`, `#` and `%`, which would all have to be escaped inside a data: URI —
   which is why the SVG below quotes its attributes with `'` and carries no
   fill (the mark is painted by masking currentColor, so the SVG's own
   colour is never used). */

const VB = 128;              // viewBox is 0 0 128 128
const CX = 64, CY = 62;      // wreath centre
const R  = 40;               // stem radius
const PHI_START = -32;       // stem start, past bottom centre (the crossing tail)
const PHI_END   = 154;       // stem end, near the gap at the top

const rad = d => d * Math.PI / 180;
const n2  = v => Math.round(v * 10) / 10;

// A point on the left stem. phi is measured from straight down, going left.
function stemPt(phi, r = R) {
  return [CX - r * Math.sin(rad(phi)), CY + r * Math.cos(rad(phi))];
}
// Outward (away from centre) and forward (towards the branch tip) unit vectors.
function frame(phi) {
  const s = Math.sin(rad(phi)), c = Math.cos(rad(phi));
  return { out: [-s, c], fwd: [-c, -s] };
}
function norm([x, y]) { const m = Math.hypot(x, y); return [x / m, y / m]; }

/* One leaf: rounded where it meets the stem, pointed at the tip. */
function leaf(base, dir, len, halfW) {
  const [bx, by] = base;
  const [dx, dy] = dir;
  const [px, py] = [-dy, dx];                     // perpendicular
  const at = (t, w) => [n2(bx + dx * len * t + px * halfW * w),
                        n2(by + dy * len * t + py * halfW * w)];
  const tip = at(1, 0);
  return `M${at(0, 0)}C${at(0.04, 1.02)} ${at(0.58, 0.98)} ${tip}` +
         `C${at(0.58, -0.98)} ${at(0.04, -1.02)} ${at(0, 0)}Z`;
}

/* Leaves along one branch. `tilt` is how far the leaf leans towards the tip. */
function leaves(phis, side, tilt, len, halfW, sink) {
  return phis.map(phi => {
    const { out, fwd } = frame(phi);
    const base = stemPt(phi, R - sink);           // sunk slightly into the stem
    const dir = norm([
      side * out[0] * Math.cos(rad(tilt)) + fwd[0] * Math.sin(rad(tilt)),
      side * out[1] * Math.cos(rad(tilt)) + fwd[1] * Math.sin(rad(tilt))
    ]);
    return leaf(base, dir, len, halfW);
  }).join('');
}

/* The stem, drawn as a filled sliver rather than a stroke so the whole icon
   is one path (a mask needs no stroke handling and scales cleanly). */
function stem(w) {
  const steps = 26, half = w / 2;
  const outer = [], inner = [];
  for (let i = 0; i <= steps; i++) {
    const phi = PHI_START + (PHI_END - PHI_START) * (i / steps);
    // Taper both ends so the branch reads as a stalk, not a pipe.
    const t = i / steps;
    const taper = Math.min(1, Math.min(t, 1 - t) * 9 + 0.35);
    outer.push(stemPt(phi, R + half * taper));
    inner.push(stemPt(phi, R - half * taper));
  }
  const pts = outer.concat(inner.reverse());
  return 'M' + pts.map(([x, y]) => `${n2(x)},${n2(y)}`).join('L') + 'Z';
}

const OUTER = [14, 34, 54, 74, 94, 114, 134, 151];
const INNER = [25, 46, 67, 88, 109, 130];

const left =
  stem(3.4) +
  leaves(OUTER, +1, 36, 15.0, 5.5, 1.2) +
  leaves(INNER, -1, 34, 12.5, 4.7, 1.2);

/* The right branch is the left one mirrored about the vertical centre line. */
const svg =
`<svg xmlns='http://www.w3.org/2000/svg' viewBox='12.6 9.9 102.8 102.8'>` +
`<g><path d='${left}'/>` +
`<path transform='translate(${VB} 0) scale(-1 1)' d='${left}'/></g></svg>`;

process.stdout.write(svg);
