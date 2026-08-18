/* The Curata mark: a laurel wreath, as one stroked SVG path per branch.
   ----------------------------------------------------------------------
   This is the SOURCE for the wreath that is inlined as a data: URI in
   assets/styles.css (`--curata-svg`). The wreath is not hand-drawn: two
   mirrored branches, each a stem arc with almond leaves placed along it —
   an outer row, an inner row and one terminal leaf — plus a tied knot with
   two ribbon tails at the foot. Kept here so the shape can be re-tuned
   (leaf count, size, tilt, stroke weight, the gap at the top) and
   re-emitted rather than edited by hand as path data, the same way the
   other migration/ scripts are kept for reference.

       node migration/curata-wreath.js

   Paste the output into the url("data:image/svg+xml;utf8,...") in the
   :root { --curata-svg } rule in assets/styles.css. It must stay free of
   `"`, `#` and `%`, which would all have to be escaped inside a data: URI —
   which is why the SVG below quotes its attributes with `'` and paints in
   the `black` keyword (the mark is drawn by masking currentColor, so the
   SVG's own colour is never seen).

   VIEWBOX is deliberately tight around the artwork, stroke included. The
   mark is sized in px by styles.css and drawn with mask-size:contain, so
   any slack in the viewBox would show up as the wreath rendering smaller
   than the size it was asked for. Re-measure it if the geometry changes:
   take the group's getBBox() and grow it by STROKE / 2 on every side, then
   square it off around the centre. */

const CX = 64, CY = 62;      // wreath centre, in the 128-unit design grid
const R = 40;                // stem radius
const PHI_START = 0;         // stem start, at bottom centre
const PHI_END = 142;         // stem end, leaving the gap at the top
const STROKE = 5;
const TILT = 40;             // how far each leaf leans towards the branch tip
const LEAF_LEN = 19.5, LEAF_HALF_W = 7.2, INNER_SCALE = 0.92;
const SINK = 1.2;            // how far a leaf's base sits inside the stem
const OUTER = [24, 60, 96];  // leaf positions, as angles from bottom centre
const INNER = [42, 78, 114];
const TERMINAL = 138;
const KNOT_DROP = 3, KNOT_R = 3.4;
const VIEWBOX = '8.7 13.8 110.6 110.6';

const rad = d => d * Math.PI / 180;
const n2 = v => Math.round(v * 10) / 10;

// A point on the left stem. phi is measured from straight down, going left.
function stemPt(phi, r = R) {
  return [CX - r * Math.sin(rad(phi)), CY + r * Math.cos(rad(phi))];
}
// Outward (away from the centre) and forward (towards the tip) unit vectors.
function frame(phi) {
  const s = Math.sin(rad(phi)), c = Math.cos(rad(phi));
  return { out: [-s, c], fwd: [-c, -s] };
}
function norm([x, y]) { const m = Math.hypot(x, y) || 1; return [x / m, y / m]; }

/* One leaf: rounded where it meets the stem, pointed at the tip. */
function leaf(base, dir, len, halfW) {
  const [bx, by] = base, [dx, dy] = dir, [px, py] = [-dy, dx];
  const at = (t, w) => [n2(bx + dx * len * t + px * halfW * w),
                        n2(by + dy * len * t + py * halfW * w)];
  return `M${at(0, 0)}C${at(0.05, 1.02)} ${at(0.56, 0.98)} ${at(1, 0)}` +
         `C${at(0.56, -0.98)} ${at(0.05, -1.02)} ${at(0, 0)}Z`;
}

/* A row of leaves. side = +1 hangs them outside the stem, -1 inside. */
function leaves(phis, side, len, halfW) {
  return phis.map(phi => {
    const { out, fwd } = frame(phi);
    const dir = norm([
      side * out[0] * Math.cos(rad(TILT)) + fwd[0] * Math.sin(rad(TILT)),
      side * out[1] * Math.cos(rad(TILT)) + fwd[1] * Math.sin(rad(TILT))
    ]);
    return leaf(stemPt(phi, R - SINK), dir, len, halfW);
  }).join('');
}

/* The stem: a plain circular arc, left open between the leaves. */
function stem() {
  const a = stemPt(PHI_START), b = stemPt(PHI_END);
  const large = (PHI_END - PHI_START) > 180 ? 1 : 0;
  return `M${n2(a[0])},${n2(a[1])}A${R},${R} 0 ${large} 1 ${n2(b[0])},${n2(b[1])}`;
}

/* One branch, drawn left of centre; the other is this one mirrored. */
function branch() {
  const { fwd } = frame(TERMINAL);
  return stem() +
    leaves(OUTER, +1, LEAF_LEN, LEAF_HALF_W) +
    leaves(INNER, -1, LEAF_LEN * INNER_SCALE, LEAF_HALF_W * INNER_SCALE) +
    leaf(stemPt(TERMINAL), fwd, LEAF_LEN, LEAF_HALF_W);
}

/* Where the two branches are tied off: a pair of blobs with a ribbon tail
   falling away either side. The blobs are filled rather than stroked, so
   they override the group's paint. */
function knot() {
  const y = CY + R + KNOT_DROP;
  return `<path d='M${CX - 7},${n2(y + 1)}c-3,6 -8,10 -13,13'/>` +
         `<path d='M${CX + 7},${n2(y + 1)}c3,6 8,10 13,13'/>` +
         `<circle cx='${CX - 3.8}' cy='${y}' r='${KNOT_R}' fill='black' stroke='none'/>` +
         `<circle cx='${CX + 3.8}' cy='${y}' r='${KNOT_R}' fill='black' stroke='none'/>`;
}

const d = branch();
process.stdout.write(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${VIEWBOX}'>` +
  `<g fill='none' stroke='black' stroke-width='${STROKE}'` +
  ` stroke-linejoin='round' stroke-linecap='round'>` +
    `<path d='${d}'/>` +
    `<path transform='translate(128 0) scale(-1 1)' d='${d}'/>` +
    knot() +
  `</g></svg>`
);
