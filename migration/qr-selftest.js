#!/usr/bin/env node
/* qr-selftest.js — read assets/qr.js's output back out and check it decodes.
 *
 *   node migration/qr-selftest.js
 *
 * There is no scanner in the sandbox and no QR library to compare against, so
 * the check is a DECODER written here from the standard rather than from the
 * encoder: it finds the function patterns for itself, reads the format
 * information, un-masks with its own copy of the eight mask formulas, walks the
 * zig-zag, de-interleaves the blocks and then verifies every block as a
 * Reed–Solomon codeword by evaluating it at a^0…a^(n-1) — which is the
 * definition of the code, not a re-run of how the encoder built it. A wrong
 * generator polynomial, a wrong block table or a misplaced module all show up
 * as a non-zero syndrome or as text that does not come back.
 *
 * Anything printed with a leading "not ok" is a failure; the exit status says
 * so too.
 */
'use strict';

var QR = require('../assets/qr.js');

/* ── GF(256), written fresh so the check does not lean on the encoder's ── */
var EXP = [], LOG = [];
(function () {
  var x = 1;
  for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
  for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
})();
function mul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

/* ── the eight mask formulas, from the standard's table ── */
var MASKS = [
  function (r, c) { return (r + c) % 2 === 0; },
  function (r) { return r % 2 === 0; },
  function (r, c) { return c % 3 === 0; },
  function (r, c) { return (r + c) % 3 === 0; },
  function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
  function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
  function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
  function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
];

var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
var BLOCKS = [null,
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]],
  [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
// Modules left over after the last codeword, by version (the standard's table).
var REMAINDER = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

var failures = 0;
function check(ok, label, detail) {
  if (!ok) failures++;
  var line = (ok ? 'ok   ' : 'not ok ') + label;
  console.log(detail ? line + ' — ' + detail : line);
}

/* Which modules are function patterns, worked out from the version alone. */
function functionMap(size, version) {
  var fn = [];
  for (var r = 0; r < size; r++) { fn.push([]); for (var c = 0; c < size; c++) fn[r].push(false); }
  function block(r0, c0, h, w) {
    for (var r = r0; r < r0 + h; r++)
      for (var c = c0; c < c0 + w; c++)
        if (r >= 0 && c >= 0 && r < size && c < size) fn[r][c] = true;
  }
  block(0, 0, 9, 9);                       // finder + separator + format
  block(0, size - 8, 9, 8);
  block(size - 8, 0, 8, 9);
  for (var i = 0; i < size; i++) { fn[6][i] = true; fn[i][6] = true; }   // timing
  var ctr = ALIGN[version];
  ctr.forEach(function (r) {
    ctr.forEach(function (c) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) return;
      block(r - 2, c - 2, 5, 5);
    });
  });
  if (version >= 7) { block(0, size - 11, 6, 3); block(size - 11, 0, 3, 6); }
  return fn;
}

function readFormat(m) {
  var size = m.length;
  var bits = 0;
  function at(r, c) { return m[r][c] ? 1 : 0; }
  // First copy, in the standard's bit order.
  var seq = [];
  for (var i = 0; i <= 5; i++) seq.push(at(i, 8));
  seq.push(at(7, 8)); seq.push(at(8, 8)); seq.push(at(8, 7));
  for (var j = 9; j < 15; j++) seq.push(at(8, 14 - j));
  for (var k = 0; k < 15; k++) bits |= seq[k] << k;
  // Second copy has to agree with it.
  var seq2 = [];
  for (var a = 0; a < 8; a++) seq2.push(at(8, size - 1 - a));
  for (var b = 8; b < 15; b++) seq2.push(at(size - 15 + b, 8));
  var same = seq.every(function (v, idx) { return v === seq2[idx]; });
  var raw = bits ^ 0x5412;
  // BCH(15,5) remainder must be zero for an undamaged format.
  var rem = raw;
  for (var s = 14; s >= 10; s--) if ((rem >> s) & 1) rem ^= 0x537 << (s - 10);
  return { level: (raw >> 13) & 3, mask: (raw >> 10) & 7, bchOk: rem === 0, copiesAgree: same };
}

function readCodewords(m, fn, count) {
  var size = m.length;
  var bits = [];
  for (var right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (var vert = 0; vert < size; vert++) {
      for (var j = 0; j < 2; j++) {
        var c = right - j;
        var upward = ((right + 1) & 2) === 0;
        var r = upward ? size - 1 - vert : vert;
        if (!fn[r][c]) bits.push(m[r][c] ? 1 : 0);
      }
    }
  }
  var words = [];
  for (var i = 0; i + 8 <= count * 8; i += 8) {
    var v = 0;
    for (var k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
    words.push(v);
  }
  return { words: words, available: bits.length };
}

function deinterleave(words, version) {
  var ecLen = BLOCKS[version][0];
  var shape = [];
  BLOCKS[version][1].forEach(function (g) {
    for (var i = 0; i < g[0]; i++) shape.push(g[1]);
  });
  var blocks = shape.map(function (len) { return { data: new Array(len), ec: new Array(ecLen) }; });
  var at = 0;
  var longest = Math.max.apply(null, shape);
  for (var i = 0; i < longest; i++)
    for (var b = 0; b < blocks.length; b++)
      if (i < shape[b]) blocks[b].data[i] = words[at++];
  for (var j = 0; j < ecLen; j++)
    for (var b2 = 0; b2 < blocks.length; b2++) blocks[b2].ec[j] = words[at++];
  return blocks;
}

/* A codeword is valid when C(a^i) = 0 for every i below the EC length. */
function syndromesZero(block) {
  var poly = block.data.concat(block.ec);
  for (var i = 0; i < block.ec.length; i++) {
    var acc = 0;
    for (var k = 0; k < poly.length; k++) acc = mul(acc, EXP[i]) ^ poly[k];
    if (acc !== 0) return false;
  }
  return true;
}

function decodeBytes(blocks, version) {
  var stream = [];
  blocks.forEach(function (b) { stream = stream.concat(b.data); });
  var bitAt = 0;
  function take(n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
      v = (v << 1) | ((stream[bitAt >> 3] >> (7 - (bitAt & 7))) & 1);
      bitAt++;
    }
    return v;
  }
  var mode = take(4);
  if (mode !== 4) return { error: 'mode ' + mode };
  var len = take(version < 10 ? 8 : 16);
  var out = [];
  for (var i = 0; i < len; i++) out.push(take(8));
  return { text: Buffer.from(out).toString('utf8') };
}

function roundTrip(text) {
  var q = QR.matrix(text);
  if (!q) { check(false, 'encode "' + text.slice(0, 40) + '"', 'returned null'); return; }
  var label = 'v' + q.version + ' mask ' + q.mask + ' (' + text.length + ' chars)';
  var size = q.size;
  var m = q.modules;

  check(size === q.version * 4 + 17, label + ' size', size + ' modules');

  var fmt = readFormat(m);
  check(fmt.bchOk, label + ' format BCH');
  check(fmt.copiesAgree, label + ' format copies agree');
  check(fmt.level === 0, label + ' level M', 'read level bits ' + fmt.level);
  check(fmt.mask === q.mask, label + ' mask matches header', 'read ' + fmt.mask);

  // Finder patterns, read straight off the grid.
  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(function (p) {
    var ok = true;
    for (var dr = 0; dr < 7; dr++) for (var dc = 0; dc < 7; dc++) {
      var d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      if (m[p[0] + dr][p[1] + dc] !== (d !== 2 && d <= 3)) ok = false;
    }
    check(ok, label + ' finder at ' + p.join(','));
  });
  var timing = true;
  for (var i = 8; i < size - 8; i++) {
    if (m[6][i] !== (i % 2 === 0) || m[i][6] !== (i % 2 === 0)) timing = false;
  }
  check(timing, label + ' timing patterns');
  check(m[size - 8][8] === true, label + ' dark module');

  // Version information (v7 and up): both copies, BCH-checked, naming this version.
  if (q.version >= 7) {
    var vA = 0, vB = 0;
    for (var b = 0; b < 18; b++) {
      var col = size - 11 + (b % 3), row = Math.floor(b / 3);
      vA |= (m[row][col] ? 1 : 0) << b;
      vB |= (m[col][row] ? 1 : 0) << b;
    }
    var vrem = vA;
    for (var s2 = 17; s2 >= 12; s2--) if ((vrem >> s2) & 1) vrem ^= 0x1F25 << (s2 - 12);
    check(vA === vB, label + ' version copies agree');
    check(vrem === 0, label + ' version BCH');
    check((vA >> 12) === q.version, label + ' version bits name v' + q.version, String(vA >> 12));
  }

  var fn = functionMap(size, q.version);
  var total = 0;
  BLOCKS[q.version][1].forEach(function (g) { total += g[0] * (g[1] + BLOCKS[q.version][0]); });
  var read = readCodewords(m, fn, total);
  check(read.available === total * 8 + REMAINDER[q.version],
    label + ' data module count',
    read.available + ' vs ' + (total * 8 + REMAINDER[q.version]));

  // Un-mask what was read: the data modules are the ones the mask touched.
  var maskFn = MASKS[fmt.mask];
  var unmasked = m.map(function (row, r) {
    return row.map(function (v, c) { return fn[r][c] ? v : (maskFn(r, c) ? !v : v); });
  });
  var words = readCodewords(unmasked, fn, total).words;
  var blocks = deinterleave(words, q.version);
  var allOk = blocks.every(syndromesZero);
  check(allOk, label + ' Reed-Solomon syndromes', blocks.length + ' block(s)');

  var got = decodeBytes(blocks, q.version);
  check(got.text === text, label + ' text round-trips',
    got.text === text ? '' : JSON.stringify(got));
}

[
  'https://botchomebrew.wiki/c/cloak',
  'https://botchomebrew.wiki/c/imppreposterous-syncretastrophy/cloak',
  'https://botchomebrew.wiki/c/odyssey/witcher-odyssey',
  'https://botchomebrew.wiki/c/tales-from-tir-far-thóinn/scr%C3%ADbhneoir',
  'A',
  'https://botchomebrew.wiki/c/' + 'x'.repeat(120)
].forEach(roundTrip);

// Longer than version 10 at level M holds: it must decline rather than truncate.
check(QR.matrix('x'.repeat(400)) === null, 'over-long text returns null');

// The published generator polynomial for 10 EC codewords, as alpha exponents.
var gen10 = QR.matrix ? require('../assets/qr.js')._internals.rsGenerator(10) : [];
var expectExp = [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45];
var gotExp = gen10.map(function (v) { return LOG[v]; });
check(JSON.stringify(gotExp) === JSON.stringify(expectExp),
  'generator polynomial for 10 EC codewords', gotExp.join(','));

console.log(failures ? '\n' + failures + ' FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
