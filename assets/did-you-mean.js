/* "Did you mean…" — the 404 page's suggestions, as one matcher for the
   browser AND the Worker.

   The 404 page used to download the whole character feed (1.1 MB raw, about
   190 KB compressed) to suggest four pages for a mistyped /c/ address. The
   Worker now does the matching over its cached feeds (GET /api/did-you-mean)
   and sends back only those four rows; the page keeps the site-page branch,
   which never needed a feed. Both go through this file, so the two can never
   score an address differently.

   Edit distance, not a bigram score: the ways a wiki address actually goes
   wrong are a dropped letter, a swapped pair, a missing accent and a
   half-remembered name, and letter-pair scoring reads those as badly as it
   reads two unrelated words that both contain "er".

   The prefix rule earns its keep here specifically: half this wiki's slugs
   carry a disambiguating suffix, so /c/sculptor should find
   sculptor-fall-of-rome. No DOM at top level. */
(function () {
  'use strict';
  function lev(a, b) {
    var m = a.length, n = b.length, i, j, prev = [], cur = [];
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      for (j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
  }
  function similar(wanted, cand) {
    if (!wanted || !cand) return 0;
    if (wanted === cand) return 1;
    // Containment only counts once there is enough of a word to mean
    // something, or "/c/a" is a prefix of a third of the wiki.
    if (wanted.length >= 3) {
      if (cand.indexOf(wanted) === 0 || wanted.indexOf(cand) === 0) return 0.92;
      if (cand.indexOf(wanted) >= 0 || wanted.indexOf(cand) >= 0) return 0.8;
    }
    var score = 1 - lev(wanted, cand) / Math.max(wanted.length, cand.length);
    // A whole word in common is worth more than the letter maths says.
    var w = wanted.split('-'), c = cand.split('-');
    for (var i = 0; i < w.length; i++) {
      if (w[i].length >= 4 && c.indexOf(w[i]) >= 0) { score = Math.max(score, 0.7); break; }
    }
    return score;
  }
  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  // 0.62 is set where a real typo still lands and an unrelated name does
  // not: "sculpter" finds the Sculptor, "snake-charmer" (an official
  // character, not a homebrew one) correctly finds nothing rather than
  // offering the nearest thing with the same letters in it.
  var THRESHOLD = 0.62;
  function best(rows, wanted, keys, limit) {
    var scored = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], top = 0;
      for (var k = 0; k < keys.length; k++) {
        var sc = similar(wanted, slugify(r[keys[k]]));
        if (sc > top) top = sc;
      }
      if (top >= THRESHOLD) scored.push({ row: r, score: top });
    }
    scored.sort(function (x, y) { return y.score - x.score; });
    return scored.slice(0, limit || 4).map(function (s) { return s.row; });
  }
  /* Which feed a failed address is matched against, the part of it worth
     matching, the row fields compared, and the fields a suggestion needs.
     Null for anything that is not a content address. */
  var KINDS = {
    c: { re: /^\/c\/(?:[^/]+\/)?([^/]+)/, table: 'characters', fields: 'grid', keys: ['slug', 'name'],
      pick: ['slug', 'page', 'name', 'art', 'team', 'creator'] },
    s: { re: /^\/s\/([^/]+)/, table: 'scripts', fields: 'browse', keys: ['slug', 'name'],
      pick: ['slug', 'name', 'logo', 'header', 'author'] },
    collection: { re: /^\/collection\/([^/]+)/, table: 'collections', fields: 'browse',
      keys: ['id', 'slug', 'name', 'displayName'], pick: ['id', 'slug', 'name', 'displayName', 'logo', 'header', 'author'] }
  };
  function target(pathname) {
    var p = String(pathname || '');
    for (var kind in KINDS) {
      var m = p.match(KINDS[kind].re);
      if (!m) continue;
      var raw;
      try { raw = decodeURIComponent(m[1]); } catch (e) { raw = m[1]; }
      return { kind: kind, spec: KINDS[kind], wanted: slugify(raw) };
    }
    return null;
  }
  var API = { lev: lev, similar: similar, slugify: slugify, best: best, target: target, KINDS: KINDS, THRESHOLD: THRESHOLD };
  if (typeof window !== 'undefined') window.DidYouMean = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
