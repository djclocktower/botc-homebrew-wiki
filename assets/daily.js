/* daily.js: the Daily Puzzle (/daily) — "Who Am I?"
 *
 * One homebrew character a day, the same for everybody. You are shown its
 * ability with its own name blacked out, and you guess who it is. Every wrong
 * guess tells you how close you came, on four things you can see on a card:
 *
 *   Team     green = same team, yellow = same alignment, red = neither
 *   Creator  green = the same person made it
 *   Set      green = it appears in the same set
 *   Tags     green = the same tags, yellow = some shared, red = none
 *
 * and the puzzle itself gives more away as it goes: the icon's silhouette
 * after two wrong guesses, the name's length and first letter after four.
 * Six guesses. Finish and you get the full page, a spoiler-free result to
 * paste into Discord, and your streak.
 *
 * NOTHING IS STORED ON THE SERVER. The day's character is worked out in the
 * browser from the UTC day number and the published grid feed (the one every
 * browse page already downloads), exactly the way the homepage's Featured
 * Character is worked out from the day number: everyone asking on the same
 * day gets the same answer, and no table or cron is needed. Progress and
 * streaks live in this browser's localStorage (botc_daily).
 *
 * The pick is "the eligible character whose hash with today's number is
 * lowest", not "index day % N". An index into the list would hand the day to
 * a different character every time a page was published; with the hash, a
 * new page takes over the day only if it happens to hash lower, one chance
 * in N. And a game already under way keeps its answer regardless — see
 * resume() on the page.
 *
 * The pure half (pick, redact, compare, share text) is exported for the
 * tests; daily.html owns the DOM.
 */
(function () {
  'use strict';

  var DAY_MS = 86400000;
  // Puzzle #1 is the day this page went live (2026-09-26, UTC).
  var EPOCH_DAY = Math.floor(Date.UTC(2026, 8, 26) / DAY_MS);
  var MAX_GUESSES = 6;
  var SILHOUETTE_AT = 2;   // wrong guesses before the icon's shape shows
  var LETTERS_AT = 4;      // ... before the name's length and first letter
  var TEAMS = { townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion', demon: 'Demon', traveller: 'Traveller' };
  var ALIGN = { townsfolk: 'good', outsider: 'good', minion: 'evil', demon: 'evil', traveller: 'either' };

  function dayNumber(now) { return Math.floor((now == null ? Date.now() : Number(now)) / DAY_MS); }
  function puzzleNumber(day) { return day - EPOCH_DAY + 1; }

  // FNV-1a, 32 bit: small, fast and the same in every browser.
  function hash(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function hasArt(c) {
    var img = Array.isArray(c.image) ? c.image[0] : c.image;
    return !!(c.art || img);
  }
  /* Worth a day: finished (not Partial), with an icon to reveal and an
     ability long enough to be a clue, on a team a player would recognise. */
  function eligible(c) {
    if (!c || !c.slug || !c.name || c.status === 'draft') return false;
    if (c.classification === 'partial') return false;
    if (!TEAMS[String(c.team || '').toLowerCase()]) return false;
    if (!hasArt(c)) return false;
    return String(c.ability || '').replace(/\[[^\]]*\]/g, '').trim().length >= 25;
  }

  function pick(chars, day) {
    var best = null, bestH = Infinity;
    (chars || []).forEach(function (c) {
      if (!eligible(c)) return;
      var h = hash(day + '|' + c.slug);
      if (h < bestH || (h === bestH && String(c.slug) < String(best.slug))) { best = c; bestH = h; }
    });
    return best;
  }

  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  /* The ability with the character's own name blacked out — the whole name,
     then any word of it long enough to give it away ("the Rat King" loses
     "Rat King", then "King"). A bar the length of the word, so the sentence
     still scans. */
  function redact(ability, name) {
    var text = String(ability || '');
    var clean = String(name || '').replace(/[^\p{L}\p{N}' -]+/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return text;
    var parts = [clean].concat(clean.split(' ').filter(function (w) { return w.length >= 4; }));
    parts.forEach(function (p) {
      var re = new RegExp('(^|[^\\p{L}\\p{N}])(' + escRe(p) + ')(?=$|[^\\p{L}\\p{N}])', 'giu');
      text = text.replace(re, function (all, pre, word) { return pre + new Array(Math.min(word.length, 12) + 1).join('█'); });
    });
    return text;
  }

  function creditNames(s) {
    return String(s || '').split(',').map(function (x) { return x.replace(/\s+/g, ' ').trim().toLowerCase(); }).filter(Boolean);
  }
  function sets(c) {
    var out = [];
    if (c.appearsIn) String(c.appearsIn).split(',').forEach(function (x) { if (x.trim()) out.push(x.trim()); });
    (Array.isArray(c.appearsInFrom) ? c.appearsInFrom : []).forEach(function (x) { if (x && x.name) out.push(String(x.name)); });
    return out;
  }
  function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function tags(c) {
    var raw = Array.isArray(c.tags) ? c.tags : String(c.tags || '').split(',');
    return raw.map(function (t) { return String(t || '').trim(); }).filter(Boolean);
  }

  /* One guess against the answer: four verdicts, each 'hit' | 'near' | 'miss'
     | 'none' (nothing to compare), plus the guessed character's own value to
     print in the chip. */
  function compare(guess, answer) {
    var gt = String(guess.team || '').toLowerCase(), at = String(answer.team || '').toLowerCase();
    var team = gt === at ? 'hit'
      : (ALIGN[gt] && ALIGN[gt] === ALIGN[at] && ALIGN[gt] !== 'either') ? 'near' : 'miss';

    var gc = creditNames(guess.creator), ac = creditNames(answer.creator);
    var creator = !ac.length ? 'none'
      : gc.some(function (n) { return ac.indexOf(n) !== -1; }) ? 'hit' : 'miss';

    var gs = sets(guess), as = sets(answer).map(norm);
    var set = !as.length ? (gs.length ? 'miss' : 'none')
      : gs.some(function (s) { return as.indexOf(norm(s)) !== -1; }) ? 'hit' : 'miss';

    var gtags = tags(guess), atags = tags(answer).map(function (t) { return t.toLowerCase(); });
    var shared = gtags.filter(function (t) { return atags.indexOf(t.toLowerCase()) !== -1; }).length;
    var tagv = !atags.length && !gtags.length ? 'none'
      : shared && shared === atags.length && shared === gtags.length ? 'hit'
        : shared ? 'near' : 'miss';

    return {
      correct: norm(guess.name) === norm(answer.name),
      team: { v: team, text: TEAMS[gt] || guess.team || '?' },
      creator: { v: creator, text: gc.length ? String(guess.creator).split(',')[0].trim() : 'Uncredited' },
      set: { v: set, text: gs.length ? gs[0] : 'No set' },
      tags: { v: tagv, text: shared ? shared + ' shared' : (gtags.length ? 'None shared' : 'No tags'), shared: shared }
    };
  }

  var EMOJI = { hit: '🟩', near: '🟨', miss: '⬛', none: '⬜' };
  /* The spoiler-free result: one row of squares per guess. */
  function shareText(puzzle, results, won, url) {
    var rows = results.map(function (r) {
      return [r.team, r.creator, r.set, r.tags].map(function (x) { return EMOJI[x.v] || EMOJI.none; }).join('') + (r.correct ? ' ✅' : '');
    });
    return 'BOTC Homebrew Daily #' + puzzle + ' — ' + (won ? results.length : 'X') + '/' + MAX_GUESSES + '\n' +
      rows.join('\n') + (url ? '\n' + url : '');
  }

  /* "M _ _ _ _ _ _" — spaces and punctuation shown as they are. */
  function letterHint(name) {
    // Credit marks (∇, ♊︎) are part of some names on this wiki, but they are
    // a creator's signature, not a letter anybody would type.
    var s = String(name || '').replace(/[\p{S}\uFE00-\uFE0F]/gu, '').trim();
    var seenFirst = false;
    return s.split('').map(function (ch) {
      if (/[\p{L}\p{N}]/u.test(ch)) {
        if (!seenFirst) { seenFirst = true; return ch.toUpperCase(); }
        return '_';
      }
      return ch === ' ' ? '  ' : ch;
    }).join(' ');
  }

  var api = {
    DAY_MS: DAY_MS, EPOCH_DAY: EPOCH_DAY, MAX_GUESSES: MAX_GUESSES,
    SILHOUETTE_AT: SILHOUETTE_AT, LETTERS_AT: LETTERS_AT, TEAMS: TEAMS,
    dayNumber: dayNumber, puzzleNumber: puzzleNumber, hash: hash,
    eligible: eligible, pick: pick, redact: redact, compare: compare,
    shareText: shareText, letterHint: letterHint
  };
  if (typeof window !== 'undefined') window.Daily = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
