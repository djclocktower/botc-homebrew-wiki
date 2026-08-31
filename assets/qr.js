/* qr.js — a QR code, as a grid of true/false.
 *
 * Written for the "JSON & Tokens" square on the almanac snapshot
 * (assets/char-snapshot.js): a reader points a phone at the printed poster and
 * lands on the character's page, where the JSON box and the Token Tool are.
 * There is no bundler here and no CDN allowed, so the encoder is the whole of
 * the dependency.
 *
 *   QR.matrix('https://botchomebrew.wiki/c/odyssey/witcher')
 *     -> { size: 33, modules: [[bool, …], …] }   // modules[row][col]
 *     -> null when the text is too long for the sizes below
 *
 * Deliberately narrow: **byte mode, error correction level M, versions 1–10**
 * — 213 bytes, which is far more than any address on this wiki. Numeric and
 * alphanumeric modes would pack a URL tighter; they are also two more encoders
 * to get right, and the square is drawn at whatever size it comes out. A level
 * or a version is one row of TABLE / ALIGN below, so growing this is adding
 * numbers rather than writing code.
 *
 * The output is quiet-zone free — the caller draws the 4-module margin, since
 * it is the one that knows what the square is being drawn on.
 *
 * Browser + node (module.exports), no DOM: the round-trip test in
 * migration/qr-selftest.js reads every module back out and decodes it.
 */
(function (global) {
  'use strict';

  /* ── GF(256), the field Reed–Solomon works in ──
     x^8 + x^4 + x^3 + x^2 + 1 (0x11D) is the QR standard's primitive
     polynomial. EXP is doubled in length so a log sum never needs a modulo. */
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
    LOG[0] = 0;   // never read: gfMul short-circuits on a zero operand
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /* The generator polynomial for `n` error-correction codewords:
     (x - a^0)(x - a^1)…(x - a^(n-1)), coefficients high-order first. */
  function rsGenerator(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      // multiply g(x) by (x - a^i)
      var next = g.concat([0]);
      for (var j = 0; j < g.length; j++) {
        next[j + 1] ^= gfMul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  /* The remainder of data(x)·x^n divided by the generator — the EC codewords. */
  function rsEncode(data, n) {
    var gen = rsGenerator(n);
    var rem = new Array(n);
    for (var i = 0; i < n; i++) rem[i] = 0;
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (var j = 0; j < n; j++) rem[j] ^= gfMul(gen[j + 1], factor);
    }
    return rem;
  }

  /* ── the version tables, level M only ──
     [ec codewords per block, [[block count, data codewords per block], …]]
     Indexed by version, so index 0 is a hole. */
  var TABLE = [
    null,
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]]
  ];
  // Alignment-pattern centre coordinates, per version.
  var ALIGN = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];
  var ECC_BITS = 0x00;      // level M, as it appears in the format information
  var MAX_VERSION = 10;

  function dataCodewords(version) {
    var total = 0;
    TABLE[version][1].forEach(function (b) { total += b[0] * b[1]; });
    return total;
  }

  /* UTF-8 bytes. A wiki address is ASCII in practice, but a character's name
     can carry a fada and a caller may hand over a name rather than a URL, so
     this never assumes one byte per character. */
  function utf8Bytes(str) {
    var s = String(str);
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i);
      if (c > 0xFFFF) i++;                       // surrogate pair, read as one
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63),
                    0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= MAX_VERSION; v++) {
      var countBits = v < 10 ? 8 : 16;
      var capacity = dataCodewords(v) * 8 - 4 - countBits;
      if (byteLen * 8 <= capacity) return v;
    }
    return 0;
  }

  /* ── the bit stream: mode, length, the bytes, padding ── */
  function buildData(bytes, version) {
    var bits = [];
    function push(value, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    }
    push(4, 4);                                   // mode 0100: byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach(function (b) { push(b, 8); });

    var capacity = dataCodewords(version) * 8;
    // Terminator: up to four zero bits, fewer if the stream is nearly full.
    var term = Math.min(4, capacity - bits.length);
    for (var t = 0; t < term; t++) bits.push(0);
    while (bits.length % 8) bits.push(0);         // round out the last codeword

    var words = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      words.push(byte);
    }
    // Pad bytes, alternating, until the block structure is full.
    var pad = [0xEC, 0x11];
    var p = 0;
    while (words.length < capacity / 8) words.push(pad[p++ % 2]);
    return words;
  }

  /* Blocks are interleaved: the first codeword of every block, then the second
     of every block, and so on — then the same again for the EC codewords. A
     scratch on the printed poster then damages a little of each block rather
     than all of one. */
  function interleave(words, version) {
    var ecLen = TABLE[version][0];
    var groups = TABLE[version][1];
    var blocks = [];
    var at = 0;
    groups.forEach(function (g) {
      for (var i = 0; i < g[0]; i++) {
        var data = words.slice(at, at + g[1]);
        at += g[1];
        blocks.push({ data: data, ec: rsEncode(data, ecLen) });
      }
    });
    var out = [];
    var longest = 0;
    blocks.forEach(function (b) { longest = Math.max(longest, b.data.length); });
    for (var i = 0; i < longest; i++) {
      blocks.forEach(function (b) { if (i < b.data.length) out.push(b.data[i]); });
    }
    for (var j = 0; j < ecLen; j++) {
      blocks.forEach(function (b) { out.push(b.ec[j]); });
    }
    return out;
  }

  /* ── the grid ──
     `fn` marks the function modules (finders, timing, alignment, the reserved
     format/version areas): those are never masked and never carry data. */
  function blank(size) {
    var m = [];
    for (var r = 0; r < size; r++) {
      var row = [];
      for (var c = 0; c < size; c++) row.push(false);
      m.push(row);
    }
    return m;
  }

  function drawFunctionPatterns(mod, fn, version) {
    var size = mod.length;

    function set(r, c, dark) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      mod[r][c] = dark;
      fn[r][c] = true;
    }
    // Finder + its separator: a 9x9 stamp with the finder inside it.
    function finder(r0, c0) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var d = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));   // ring index
          set(r0 + dr, c0 + dc, d !== 2 && d <= 3);
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // Timing patterns, running between the finders.
    for (var i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // Alignment patterns, everywhere two centres meet except under a finder.
    var centres = ALIGN[version];
    centres.forEach(function (r) {
      centres.forEach(function (c) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) ||
            (r === size - 7 && c === 6)) return;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      });
    });

    // Reserve the format information, and the always-dark module beside it.
    for (var k = 0; k < 9; k++) {
      if (k !== 6) { set(8, k, false); set(k, 8, false); }
    }
    for (var j = 0; j < 8; j++) { set(8, size - 1 - j, false); set(size - 1 - j, 8, false); }
    set(size - 8, 8, true);

    if (version >= 7) {
      var vbits = versionBits(version);
      for (var b = 0; b < 18; b++) {
        var bit = ((vbits >> b) & 1) === 1;
        var a = size - 11 + (b % 3);
        var d2 = Math.floor(b / 3);
        set(d2, a, bit);
        set(a, d2, bit);
      }
    }
  }

  /* BCH(18,6) over the version number, generator 0x1F25. */
  function versionBits(version) {
    var rem = version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
    return ((version << 12) | rem) >>> 0;
  }

  /* BCH(15,5) over (level, mask), generator 0x537, then the standard XOR mask
     so an all-zero format never reads as blank. */
  function formatBits(mask) {
    var data = (ECC_BITS << 3) | mask;
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    return (((data << 10) | rem) ^ 0x5412) >>> 0;
  }

  function drawFormat(mod, mask) {
    var size = mod.length;
    var bits = formatBits(mask);
    function bit(i) { return ((bits >> i) & 1) === 1; }
    for (var i = 0; i <= 5; i++) mod[i][8] = bit(i);
    mod[7][8] = bit(6);
    mod[8][8] = bit(7);
    mod[8][7] = bit(8);
    for (var j = 9; j < 15; j++) mod[8][14 - j] = bit(j);
    for (var k = 0; k < 8; k++) mod[8][size - 1 - k] = bit(k);
    for (var n = 8; n < 15; n++) mod[size - 15 + n][8] = bit(n);
  }

  /* Codewords are laid in two-module-wide columns, right to left, snaking up
     and then down. Column 6 is the vertical timing pattern and is skipped
     outright rather than stepped over. */
  function drawData(mod, fn, words) {
    var size = mod.length;
    var bitAt = 0;
    var total = words.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var c = right - j;
          var upward = ((right + 1) & 2) === 0;
          var r = upward ? size - 1 - vert : vert;
          if (fn[r][c] || bitAt >= total) continue;
          mod[r][c] = ((words[bitAt >> 3] >> (7 - (bitAt & 7))) & 1) === 1;
          bitAt++;
        }
      }
    }
    return bitAt;
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];

  function applyMask(mod, fn, mask) {
    var f = MASKS[mask];
    for (var r = 0; r < mod.length; r++) {
      for (var c = 0; c < mod.length; c++) {
        if (!fn[r][c] && f(r, c)) mod[r][c] = !mod[r][c];
      }
    }
  }

  /* The standard's four penalty rules. Any mask scans; this only picks the
     one least likely to confuse a reader (long runs, blocks of one colour,
     something that looks like a finder, or an unbalanced overall darkness). */
  function penalty(mod) {
    var size = mod.length;
    var score = 0;
    var r, c, i;

    function runScore(line) {
      var s = 0;
      var run = 1;
      for (var k = 1; k < line.length; k++) {
        if (line[k] === line[k - 1]) {
          run++;
          if (run === 5) s += 3;
          else if (run > 5) s += 1;
        } else run = 1;
      }
      // Rule 3: a finder-like 1:1:3:1:1 run with four light modules beside it.
      var str = line.map(function (v) { return v ? '1' : '0'; }).join('');
      var pat = /1011101/g;
      var m;
      while ((m = pat.exec(str)) !== null) {
        var before = str.slice(Math.max(0, m.index - 4), m.index);
        var after = str.slice(m.index + 7, m.index + 11);
        if (/^0000$/.test(before) || /^0000$/.test(after) ||
            (m.index < 4 && before.indexOf('1') === -1) ||
            (m.index + 11 > str.length && after.indexOf('1') === -1)) score += 40;
        pat.lastIndex = m.index + 1;
      }
      return s;
    }

    for (r = 0; r < size; r++) score += runScore(mod[r]);
    for (c = 0; c < size; c++) {
      var col = [];
      for (r = 0; r < size; r++) col.push(mod[r][c]);
      score += runScore(col);
    }
    // Rule 2: every 2x2 block of one colour.
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = mod[r][c];
        if (mod[r][c + 1] === v && mod[r + 1][c] === v && mod[r + 1][c + 1] === v) score += 3;
      }
    }
    // Rule 4: how far the dark proportion strays from half.
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (mod[r][c]) dark++;
    var pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  /* ── the one call ── */
  function matrix(text) {
    var bytes = utf8Bytes(text);
    if (!bytes.length) return null;
    var version = pickVersion(bytes.length);
    if (!version) return null;

    var words = interleave(buildData(bytes, version), version);
    var size = version * 4 + 17;

    var best = null;
    for (var mask = 0; mask < 8; mask++) {
      var mod = blank(size);
      var fn = blank(size);
      drawFunctionPatterns(mod, fn, version);
      drawData(mod, fn, words);
      applyMask(mod, fn, mask);
      drawFormat(mod, mask);
      var score = penalty(mod);
      if (!best || score < best.score) best = { score: score, mod: mod, mask: mask };
    }
    return { size: size, version: version, mask: best.mask, modules: best.mod };
  }

  var API = { matrix: matrix, MAX_VERSION: MAX_VERSION };
  // The internals the self-test reads back out; nothing else uses them.
  API._internals = {
    TABLE: TABLE, ALIGN: ALIGN, MASKS: MASKS, EXP: EXP, LOG: LOG,
    gfMul: gfMul, rsGenerator: rsGenerator, formatBits: formatBits,
    versionBits: versionBits, blank: blank,
    drawFunctionPatterns: drawFunctionPatterns, dataCodewords: dataCodewords
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (global) global.QR = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
