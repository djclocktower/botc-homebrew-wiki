/* Site search: the engine behind the top-bar box AND the /search page.

   One file, so the preview under the box and the full results page can never
   rank or match differently. No DOM at top level: node --test loads it in a
   vm, and it would run in the Worker unchanged.

   How a query is matched
   ----------------------
   Everything is FOLDED before it is compared: lower-cased, NFKD with the
   combining marks dropped (ö ō ó all become o), the letters that have no
   decomposition named outright (ø -> o, æ -> ae, ß -> ss, þ -> th ...), and
   apostrophes deleted, so "Tir-Far's" is the words "tir" "fars". The same
   fold is applied to the query, so both sides always agree.

   Every item's fields are split into words, and the index keeps one list of
   distinct words with, for each, the (item, field) pairs it appears in. A
   query word is compared against that vocabulary once, not against every
   item, which is what keeps a keystroke cheap with 2,400 characters loaded:

     exact word            1.0
     start of a word       0.8 - 0.95   (as you type)
     inside a word         0.45 - 0.55  (3+ letters, or any non-Latin script)
     one or two typos      0.2 - 0.3    (4+ letters; names, sets, tags only)

   Typos are only tried for a query word that is nowhere in the vocabulary,
   whole or as the start of a word. "poison" is a real word here, so it never
   also means "prison"; "poisn" is not, so it finds the Poisoner.

   A word's score for an item is the best of those times the field's weight
   (a name counts five times an ability). Every query word has to match
   somewhere, except the small words in STOP, which only add to the score.
   Whole-phrase bonuses then lift an exact or leading name match to the top.

   Typos are only looked for in short fields (names, sets, tags, creators):
   in ability text they would match half the wiki.

   Leaving things out
   ------------------
   A word typed with a minus in front of it ("poison -drunk") removes every
   result that has that word ANYWHERE: its name, set, tags, credit, ability
   or description. It matches a whole word or the start of one, so -drunk also
   drops "Drunkenness", but never the middle of a word ("-unk" leaves the
   Drunk alone) and never a typo — leaving something out has to be exact or it
   hides things nobody asked to hide. -"two words" leaves out a phrase. Only
   a minus at the START of a word counts, so "tir-far" is still one search.
   A query of nothing but minus words lists everything else. */
(function () {
  'use strict';

  /* ── folding ── */
  var EXTRAS = {
    'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ł': 'l', 'ħ': 'h', 'ı': 'i',
    'ŧ': 't', 'ŋ': 'n', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ĸ': 'k', 'ſ': 's'
  };
  var EXTRA_RE = /[øđðþłħıŧŋæœßĸſ]/g;
  var MARK_RE = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;
  var APOS_RE = /['‘’ʼ`´]/g;
  var SPLIT_RE, WORD_CH_RE;
  try {
    SPLIT_RE = new RegExp('[^\\p{L}\\p{N}]+', 'u');
    WORD_CH_RE = new RegExp('[\\p{L}\\p{N}]', 'u');
  } catch (e) {
    // Very old engines without \p{}: treat anything outside ASCII as a letter.
    SPLIT_RE = /[^a-z0-9À-￿]+/;
    WORD_CH_RE = /[a-z0-9À-￿]/;
  }
  var HAS_NORMALIZE = typeof ''.normalize === 'function';

  var PLAIN_RE = /^[\x00-\x7f]*$/;
  function fold(s) {
    s = String(s == null ? '' : s).toLowerCase();
    // Most of the wiki is plain ASCII, which NFKD would hand back unchanged.
    if (PLAIN_RE.test(s)) return s.indexOf("'") === -1 && s.indexOf('`') === -1 ? s : s.replace(APOS_RE, '');
    if (HAS_NORMALIZE) s = s.normalize('NFKD');
    return s.replace(MARK_RE, '').replace(EXTRA_RE, function (ch) { return EXTRAS[ch]; })
      .replace(APOS_RE, '');
  }
  function words(s) {
    var out = fold(s).split(SPLIT_RE), keep = [];
    for (var i = 0; i < out.length; i++) if (out[i]) keep.push(out[i]);
    return keep;
  }
  // Latin letters and digits only: the scripts typo tolerance makes sense for.
  function asciiWord(w) { return /^[a-z0-9]+$/.test(w); }

  /* ── edit distance (optimal string alignment), bounded by k ── */
  var rowA = new Int32Array(64), rowB = new Int32Array(64), rowC = new Int32Array(64);
  function osa(a, b, k) {
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > k) return k + 1;
    if (lb + 1 > rowA.length) { rowA = new Int32Array(lb + 1); rowB = new Int32Array(lb + 1); rowC = new Int32Array(lb + 1); }
    var prev2 = rowA, prev = rowB, cur = rowC, i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var best = i, ca = a.charCodeAt(i - 1);
      for (j = 1; j <= lb; j++) {
        var cb = b.charCodeAt(j - 1);
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === cb ? 0 : 1));
        if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > k) return k + 1;
      var t = prev2; prev2 = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }

  // How well one vocabulary word answers one query word. Returns the quality
  // (0 = no match); `typo` says whether it took a typo to get there, since
  // typo matches only count in the short fields.
  function quality(w, t, tAscii) {
    if (w === t) return 1;
    var lw = w.length, lt = t.length;
    if (lw > lt && w.lastIndexOf(t, 0) === 0) return 0.8 + 0.15 * (lt / lw);
    if ((lt >= 3 || !tAscii) && lw > lt && w.indexOf(t, 1) !== -1) return 0.45 + 0.1 * (lt / lw);
    return 0;
  }
  function typoQuality(w, t) {
    var lw = w.length, lt = t.length, k = lt >= 8 ? 2 : 1, d;
    if (Math.abs(lw - lt) <= k) {
      d = osa(w, t, k);
      if (d <= k) return d === 1 ? 0.3 : 0.2;
    }
    // A typo in a word still being typed: "poisn" for "poisoner". The first
    // letter has to agree, which is how people actually misspell, and it skips
    // most of the vocabulary without running the distance at all.
    if (lw > lt && lt >= 5 && w.charCodeAt(0) === t.charCodeAt(0)) {
      d = osa(w.slice(0, lt), t, 1);
      if (d <= 1) return 0.25;
    }
    return 0;
  }

  /* ── types ── */
  var TYPES = ['character', 'script', 'collection', 'creator', 'user', 'wikipage', 'news', 'tag', 'site'];
  var TYPE_LABEL = {
    character: 'Characters', script: 'Scripts', collection: 'Collections',
    creator: 'Creators', user: 'Users', wikipage: 'Wiki pages', news: 'News',
    tag: 'Tags & teams', site: 'Site pages'
  };
  var TYPE_ONE = {
    character: 'Character', script: 'Script', collection: 'Collection',
    creator: 'Creator', user: 'User', wikipage: 'Wiki page', news: 'News',
    tag: 'Tag', site: 'Page'
  };
  // A small lift for the things people name outright: searching a set's name
  // should show the set above the characters whose "Appears in" repeats it.
  var TYPE_BOOST = {
    character: 1, script: 1.06, collection: 1.06, creator: 1.02, user: 0.97,
    wikipage: 0.97, news: 0.95, tag: 1.02, site: 1
  };
  var TEAMS = [
    ['townsfolk', 'Townsfolk'], ['outsider', 'Outsider'], ['minion', 'Minion'],
    ['demon', 'Demon'], ['traveller', 'Traveller'], ['fabled', 'Fabled'], ['loric', 'Loric']
  ];
  var TEAM_LABEL = {};
  TEAMS.forEach(function (t) { TEAM_LABEL[t[0]] = t[1]; });

  // The site's own pages: [name, path, kind, description, extra words].
  // The descriptions are the site's own (tools.html), not new copy; the extra
  // words are other things people type for the same page.
  var SITE_PAGES = [
    ['All Characters', 'all-characters', 'Browse', '', 'browse every character list'],
    ['Scripts', 'scripts', 'Browse', '', 'script list'],
    ['Collections', 'all-collections', 'Browse', '', 'collection list'],
    ['Creators', 'creators', 'Browse', '', 'authors creator icons symbols'],
    ['Tags', 'tags', 'Browse', '', 'tag list'],
    ['News', 'news', 'Browse', '', 'announcements updates articles'],
    ['Random Character', 'random', 'Browse', '', 'surprise'],
    ['Rules', 'rules', 'Browse', '', 'guidelines'],
    ['Tools', 'tools', 'Tool', '', 'toolbox'],
    ['Script Builder', 'script', 'Tool', 'Build a script from wiki characters, then export, share or publish it.', 'make create json export'],
    ['Create a Character', 'create', 'Tool', '', 'new make add homebrew'],
    ['Token Tool', 'tokens', 'Tool', 'Print character and reminder token sheets for wiki characters.', 'print pdf reminder'],
    ['Grimoire Forge', 'grimforge', 'Tool', 'Check your ability text against official card wording.', 'ability wording checker lint grimforge'],
    ['Icon Forge', 'iconforge', 'Tool', 'Turn line art, a scan or a photo into an official-style character icon.', 'icon art image maker iconforge'],
    ['Bloodstar Import', 'bloodstar', 'Tool', 'Import a whole Bloodstar project from its link.', 'import clocktica'],
    ['Mass Upload', 'mass-upload', 'Tool', '', 'import json bulk upload'],
    ['Jinxes', 'jinxes', 'Tool', 'Every jinx on the wiki, as a list and a map.', 'jinx map'],
    ['Steven Approved Order', 'steven-approved-order', 'Tool', '', 'sao sort order'],
    ['Favorites', 'favorites', 'Your account', '', 'saved hearts'],
    ['Drafts', 'drafts', 'Your account', '', 'unpublished'],
    ['My Account', 'account', 'Your account', '', 'settings profile'],
    ['Messages', 'messages', 'Your account', '', 'inbox mail dm']
  ];
  // Looked up with a word somebody typed, so it must not inherit anything:
  // on a plain object "constructor" read as a small word and was dropped.
  var STOP = Object.assign(Object.create(null),
    { the: 1, of: 1, a: 1, an: 1, and: 1, to: 1, in: 1, on: 1, for: 1, by: 1, is: 1 });

  function titleCase(s) {
    return String(s || '').trim().toLowerCase()
      .replace(/(^|[\s\-\/])[a-z]/g, function (m) { return m.toUpperCase(); });
  }
  function splitList(s) {
    return String(s || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /* ── building the index ──
     data: {characters, scripts, collections, extra: {creators, users, pages,
     news}}; any of them may be missing. root: the link prefix (BotcData.root). */
  var MAX_FIELDS = 16;
  function createIndex(data, root) {
    data = data || {};
    root = root || '';
    var extra = data.extra || {};
    var items = [];

    // When each item was created and last changed, as unix seconds (0 when
    // unknown), for the date sorts on /search. The browse feeds carry `v`,
    // the row's last save in base 36; creation dates for scripts and
    // collections come in the search index's `dates`.
    var dates = extra.dates || {};
    function seconds(ts) {
      var t = Date.parse(String(ts || '').replace(' ', 'T') + (/[zZ]$/.test(String(ts || '')) ? '' : 'Z'));
      return isFinite(t) ? Math.floor(t / 1000) : 0;
    }
    function fromV(v) { var n = v ? parseInt(v, 36) : 0; return isFinite(n) ? n : 0; }
    function stamp(item) {
      var d = item.data || {}, t = item.type, created = 0, updated = 0;
      if (t === 'script') { created = (dates.script || {})[d.slug] || 0; updated = fromV(d.v); }
      else if (t === 'collection') {
        var cd = dates.collection || {};
        created = cd[d.id] || cd[d.slug] || 0;
        updated = fromV(d.v);
      }
      else if (t === 'character') updated = fromV(d.v);
      else if (t === 'user') created = d.created || 0;
      else if (t === 'wikipage') { created = d.created || 0; updated = d.updated || 0; }
      else if (t === 'news') created = updated = seconds(d.publishedAt);
      item.created = created;
      item.updated = updated || created;
    }

    // fields: [text, weight, typo?, compact?]
    function add(item, fields) {
      item.fields = fields;
      stamp(item);
      items.push(item);
    }

    (data.characters || []).forEach(function (c) {
      if (!c || !c.name) return;
      var sets = [];
      if (c.appearsIn) sets.push(c.appearsIn);
      (c.appearsInFrom || []).forEach(function (f) { if (f && f.name) sets.push(f.name); });
      add({
        type: 'character', name: c.name, href: root + (c.page || ('c/' + encodeURIComponent(c.slug || ''))),
        data: c, curata: !!c.curata, partial: c.classification === 'partial' && !c.curata
      }, [
        [c.name, 10, true, true],
        [TEAM_LABEL[c.team] || c.team || '', 3, true],
        [String(c.tags || '').replace(/,/g, ' , '), 4, true],
        [sets.join(' , '), 4, true, true],
        [c.creator || '', 4, true, true],
        [c.ability || '', 2, false],
        // Curata is a mark, not a word on the page; this lets people search it.
        [c.curata ? 'curata' : '', 3, true]
      ]);
    });
    (data.scripts || []).forEach(function (s) {
      if (!s || !s.slug) return;
      add({
        type: 'script', name: s.name || s.slug, href: root + 's/' + encodeURIComponent(s.slug),
        data: s, curata: !!s.curata
      }, [
        [s.name || s.slug, 10, true, true],
        [s.author || '', 4, true, true],
        [s.tagline || '', 3, false],
        [s.description || '', 2, false],
        [s.curata ? 'curata' : '', 3, true]
      ]);
    });
    (data.collections || []).forEach(function (c) {
      if (!c || !(c.id || c.slug)) return;
      var name = c.displayName || c.name || c.slug;
      add({
        type: 'collection', name: name, href: root + 'collection/' + encodeURIComponent(c.id || c.slug),
        data: c, curata: !!c.curata
      }, [
        [name, 10, true, true],
        [c.author || '', 4, true, true],
        [c.tagline || '', 3, false],
        [c.description || '', 2, false],
        [c.curata ? 'curata' : '', 3, true]
      ]);
    });
    (extra.creators || []).forEach(function (c) {
      if (!c || !c.name) return;
      add({
        type: 'creator', name: c.name,
        href: c.username ? root + 'u/' + encodeURIComponent(c.username)
          : root + 'author?a=' + encodeURIComponent(c.name),
        data: c
      }, [
        [c.name, 10, true, true],
        [c.username || '', 6, true, true],
        [c.displayName && c.displayName !== c.name ? c.displayName : '', 6, true, true]
      ]);
    });
    (extra.users || []).forEach(function (u) {
      if (!u || !u.username) return;
      add({
        type: 'user', name: u.displayName || u.username,
        href: root + 'u/' + encodeURIComponent(u.username), data: u
      }, [
        [u.username, 10, true, true],
        [u.displayName || '', 10, true, true]
      ]);
    });
    (extra.pages || []).forEach(function (p) {
      if (!p || !p.slug) return;
      add({
        type: 'wikipage', name: p.title || p.slug, href: root + 'p/' + encodeURIComponent(p.slug), data: p
      }, [
        [p.title || '', 10, true, true],
        [p.subtitle || '', 4, false],
        [p.parentName || '', 4, true, true],
        [p.author || '', 4, true, true],
        [p.blurb || '', 2, false]
      ]);
    });
    (extra.news || []).forEach(function (n) {
      if (!n || !n.slug) return;
      add({
        type: 'news', name: n.title || n.slug, href: root + 'news/' + encodeURIComponent(n.slug), data: n
      }, [
        [n.title || '', 10, true, true],
        [n.summary || '', 2, false]
      ]);
    });

    // Tags come from the characters themselves, so the list is exactly the
    // tags in use and each can say how many characters carry it.
    var tagCount = Object.create(null);
    (data.characters || []).forEach(function (c) {
      splitList(c && c.tags).forEach(function (t) {
        var k = titleCase(t);
        tagCount[k] = (tagCount[k] || 0) + 1;
      });
    });
    Object.keys(tagCount).sort().forEach(function (t) {
      add({
        type: 'tag', name: t, href: root + 'tag?t=' + encodeURIComponent(t),
        data: { kind: 'tag', count: tagCount[t] }
      }, [[t, 10, true, true]]);
    });
    var teamCount = Object.create(null);
    (data.characters || []).forEach(function (c) { if (c && c.team) teamCount[c.team] = (teamCount[c.team] || 0) + 1; });
    TEAMS.forEach(function (t) {
      add({
        type: 'tag', name: t[1], href: root + 'team?t=' + t[0],
        data: { kind: 'team', team: t[0], count: teamCount[t[0]] || 0 }
      }, [[t[1], 10, true], [t[0] === 'traveller' ? 'traveler travellers' : t[0] + 's', 8, true]]);
    });
    SITE_PAGES.forEach(function (p) {
      add({
        type: 'site', name: p[0], href: p[1] === 'random' ? '/random' : root + p[1],
        data: { kind: p[2], desc: p[3] }
      }, [[p[0], 10, true, true], [p[4], 3, true], [p[3], 1, false]]);
    });

    return new Index(items);
  }

  function Index(items) {
    var n = items.length;
    this.items = items;
    this.n = n;
    this.fieldWeight = new Float32Array(n * MAX_FIELDS);
    this.memo = new Map();
    // Short fields (names, sets, tags, credits) go into the vocabulary; long
    // ones (abilities, descriptions) are kept as folded text and scanned
    // directly, which costs well under a millisecond a word and keeps
    // 50,000 ability words out of the index build.
    // lastSlot[wi] is the last field a word was posted for, so a word repeated
    // inside one field is posted once without a per-field lookup object.
    // runTogether[wi] marks a word that only exists as a run-together name
    // ("grimpeeker"): it may be matched whole or from its start, never from
    // the middle, or "imp" would find Grim Peeker.
    var vocab = new Map(), vwords = [], post = [], lastSlot = [], runTogether = [];
    for (var i = 0; i < n; i++) {
      var it = items[i], fields = it.fields;
      it.i = i;
      it.fold = words(it.name).join(' ');
      it.compact = it.fold.replace(/ /g, '');
      // "The Drunk" is the Drunk: a leading article never stops an exact match.
      it.bare = it.fold.replace(/^(the|a|an) /, '');
      it.longs = null;
      var all = [];
      for (var f = 0; f < fields.length && f < MAX_FIELDS; f++) {
        var text = fields[f][0];
        if (!text) continue;
        var slot = i * MAX_FIELDS + f;
        var ws = words(text), joined = ws.join(' ');
        all.push(joined);
        if (!fields[f][2]) {
          if (joined) (it.longs || (it.longs = [])).push(joined, fields[f][1]);
          continue;
        }
        this.fieldWeight[slot] = fields[f][1];
        // A multi-word name is also one run-together word, so "tirfar" or
        // "fallofrome" still finds it. Each comma-separated part on its own
        // (a set list, a credit list).
        var plain = ws.length;
        if (fields[f][3] && ws.length > 1) {
          var parts = String(text).split(',');
          for (var pi = 0; pi < parts.length; pi++) {
            var pw = words(parts[pi]);
            if (pw.length > 1) ws.push(pw.join(''));
          }
        }
        for (var w = 0; w < ws.length; w++) {
          var word = ws[w], wi = vocab.get(word);
          if (wi === undefined) {
            wi = vwords.length; vocab.set(word, wi); vwords.push(word); post.push([slot]); lastSlot.push(slot);
            runTogether.push(w >= plain ? 1 : 0);
            continue;
          }
          if (w < plain) runTogether[wi] = 0;
          if (lastSlot[wi] === slot) continue;
          lastSlot[wi] = slot;
          post[wi].push(slot);
        }
      }
      // Every field's words, for spotting a multi-word query as a phrase.
      it.text = all.join(' | ');
      it.fields = null;
    }
    this.words = vwords;
    this.post = post;
    this.runTogether = runTogether;
  }

  // Scores for one query word, per item (the best field wins). Memoised, so
  // the words already typed cost nothing while the last one changes.
  Index.prototype.tokenScores = function (t) {
    var hit = this.memo.get(t);
    if (hit) return hit;
    var out = new Float32Array(this.n);
    var vw = this.words, post = this.post, fw = this.fieldWeight, items = this.items;
    var tAscii = asciiWord(t), lt = t.length, found = false, wi, i;
    // One or two letters only count as the start of a word in the short
    // fields, and as a whole word in the long ones: "i" matching every
    // ability with a word starting in i is a list nobody can use.
    var tiny = tAscii && lt <= 2;
    var anywhere = lt >= 3 || !tAscii;
    function apply(list, q) {
      for (var p = 0; p < list.length; p++) {
        var slot = list[p], s = q * fw[slot], item = (slot / MAX_FIELDS) | 0;
        if (s > out[item]) out[item] = s;
      }
    }
    var runTogether = this.runTogether;
    for (wi = 0; wi < vw.length; wi++) {
      var q = quality(vw[wi], t, tAscii);
      if (!q || (runTogether[wi] && q < 0.8)) continue;
      if (q >= 0.8) found = true;
      apply(post[wi], q);
    }
    for (i = 0; i < items.length; i++) {
      var longs = items[i].longs;
      if (!longs) continue;
      for (var l = 0; l < longs.length; l += 2) {
        var txt = longs[l], at = txt.indexOf(t), best = 0;
        while (at !== -1) {
          var startOk = at === 0 || txt.charCodeAt(at - 1) === 32;
          var endOk = at + lt === txt.length || txt.charCodeAt(at + lt) === 32;
          var lq = startOk ? (endOk ? 1 : (tiny ? 0 : 0.85)) : (anywhere ? 0.5 : 0);
          if (lq > best) best = lq;
          if (best === 1) break;
          at = txt.indexOf(t, at + 1);
        }
        if (best) {
          if (best >= 0.85) found = true;
          var ls = best * longs[l + 1];
          if (ls > out[i]) out[i] = ls;
        }
      }
    }
    if (!found && tAscii && lt >= 4) {
      for (wi = 0; wi < vw.length; wi++) {
        if (runTogether[wi]) continue;
        var tq = typoQuality(vw[wi], t);
        if (tq) apply(post[wi], tq);
      }
    }
    if (this.memo.size > 200) this.memo.clear();
    this.memo.set(t, out);
    return out;
  };

  function byName(a, b) {
    var x = a.item.name.toLowerCase(), y = b.item.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  /* Splits the minus words off a query: {text, neg}. `text` is what is left
     to search for; `neg` holds each left-out word or phrase, folded the way
     the items' own text is, so the two can be compared directly. */
  var NEG_RE = /(^|\s)-(?:"([^"]*)"?|(\S+))/g;
  function parseQuery(query) {
    var neg = [];
    var text = String(query == null ? '' : query).replace(NEG_RE, function (m, lead, quoted, bare) {
      var w = words(quoted != null ? quoted : bare).join(' ');
      if (w && neg.indexOf(w) === -1) neg.push(w);
      return lead;
    });
    return { text: text, neg: neg };
  }
  // Whole word or the start of one, in any field; see "Leaving things out".
  function leftOut(it, neg) {
    if (!neg.length) return false;
    var hay = ' ' + it.text + ' ';
    for (var k = 0; k < neg.length; k++) if (hay.indexOf(' ' + neg[k]) !== -1) return true;
    return false;
  }

  /* search(query, {types}) -> {query, tokens, results, byType, counts, total}
     results: [{item, score}] best first, across every type. An empty query
     returns every item of the asked-for types, A–Z, with score 0. */
  Index.prototype.search = function (query, opts) {
    opts = opts || {};
    var only = opts.types ? {} : null;
    if (opts.types) opts.types.forEach(function (t) { only[t] = 1; });
    // seen is keyed by the typed words, so it has no prototype to collide with.
    var tokens = [], seen = Object.create(null);
    var parsed = parseQuery(query), neg = parsed.neg;
    words(parsed.text).forEach(function (w) { if (!seen[w]) { seen[w] = 1; tokens.push(w); } });
    var items = this.items, out = [], i;
    if (!tokens.length) {
      for (i = 0; i < items.length; i++) {
        if ((!only || only[items[i].type]) && !leftOut(items[i], neg)) out.push({ item: items[i], score: 0 });
      }
      out.sort(byName);
      return group(query, tokens, out);
    }
    var required = tokens.filter(function (t) { return !STOP[t]; });
    var optional = tokens.filter(function (t) { return STOP[t]; });
    if (!required.length) { required = optional; optional = []; }
    var self = this;
    var req = required.map(function (t) { return self.tokenScores(t); });
    var opt = optional.map(function (t) { return self.tokenScores(t); });
    var phrase = tokens.join(' '), compact = tokens.join('');
    var first = req[0];
    for (i = 0; i < items.length; i++) {
      if (!first[i]) continue;
      var it = items[i];
      if (only && !only[it.type]) continue;
      if (leftOut(it, neg)) continue;
      var total = 0, ok = true, r;
      for (r = 0; r < req.length; r++) {
        var s = req[r][i];
        if (!s) { ok = false; break; }
        total += s;
      }
      if (!ok) continue;
      for (r = 0; r < opt.length; r++) total += opt[r][i] * 0.5;
      // Whole-name bonuses: the thing you typed the full name of comes first,
      // then names that start with it as a whole word ("Demon Tamer" for
      // demon), then names that merely start with the letters.
      var name = it.fold, bare = it.bare;
      if (name === phrase || bare === phrase || it.compact === compact) total += 25;
      else if (name.lastIndexOf(phrase + ' ', 0) === 0 || bare.lastIndexOf(phrase + ' ', 0) === 0) total += 10;
      else if (name.lastIndexOf(phrase, 0) === 0 || it.compact.lastIndexOf(compact, 0) === 0) total += 4;
      else if (tokens.length > 1 && name.indexOf(phrase) !== -1) total += 5;
      else if (tokens.length > 1 && it.text.indexOf(phrase) !== -1) total += 4;
      total *= TYPE_BOOST[it.type] || 1;
      if (it.curata) total *= 1.04;
      if (it.partial) total *= 0.95;
      out.push({ item: it, score: total });
    }
    out.sort(function (a, b) { return b.score - a.score || byName(a, b); });
    return group(query, tokens, out);
  };

  function group(query, tokens, results) {
    var byType = {}, counts = {}, i;
    TYPES.forEach(function (t) { byType[t] = []; counts[t] = 0; });
    // A creator with an account and that account are one person with one
    // page. Both stay in their own tab; the mixed list shows the person once.
    var creatorHref = Object.create(null);
    for (i = 0; i < results.length; i++) {
      var r = results[i];
      byType[r.item.type].push(r);
      counts[r.item.type]++;
      if (r.item.type === 'creator') creatorHref[r.item.href] = 1;
    }
    var mixed = results.filter(function (r) { return !(r.item.type === 'user' && creatorHref[r.item.href]); });
    return { query: query, tokens: tokens, results: results, mixed: mixed, byType: byType, counts: counts, total: results.length };
  }

  /* ── highlighting ──
     mark(text, tokens) -> escaped HTML with the matched parts of `text`
     wrapped in <mark class="sr-hl">. Works on the folded text and maps back,
     so typing "oeuvre" lights up "Œuvre". Typo matches are not marked. */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function mark(text, tokens) {
    text = String(text == null ? '' : text);
    if (!tokens || !tokens.length || !text) return esc(text);
    var folded = '', start = [], end = [];
    for (var i = 0; i < text.length;) {
      var cp = text.codePointAt(i), len = cp > 0xffff ? 2 : 1;
      var f = fold(text.slice(i, i + len));
      for (var j = 0; j < f.length; j++) { folded += f[j]; start.push(i); end.push(i + len); }
      i += len;
    }
    var ranges = [];
    tokens.forEach(function (t) {
      if (!t) return;
      var anywhere = t.length >= 3 || !asciiWord(t), at = 0;
      while ((at = folded.indexOf(t, at)) !== -1) {
        var wordStart = at === 0 || !WORD_CH_RE.test(folded[at - 1]);
        if (wordStart || anywhere) ranges.push([start[at], end[at + t.length - 1]]);
        at += t.length;
      }
    });
    if (!ranges.length) return esc(text);
    ranges.sort(function (a, b) { return a[0] - b[0]; });
    var merged = [ranges[0]];
    for (var r = 1; r < ranges.length; r++) {
      var last = merged[merged.length - 1];
      if (ranges[r][0] <= last[1]) last[1] = Math.max(last[1], ranges[r][1]);
      else merged.push(ranges[r]);
    }
    var html = '', pos = 0;
    merged.forEach(function (m) {
      html += esc(text.slice(pos, m[0])) + '<mark class="sr-hl">' + esc(text.slice(m[0], m[1])) + '</mark>';
      pos = m[1];
    });
    return html + esc(text.slice(pos));
  }

  var API = {
    fold: fold, words: words, osa: osa, createIndex: createIndex, mark: mark, esc: esc, parseQuery: parseQuery,
    TYPES: TYPES, TYPE_LABEL: TYPE_LABEL, TYPE_ONE: TYPE_ONE, TEAMS: TEAMS, TEAM_LABEL: TEAM_LABEL,
    SITE_PAGES: SITE_PAGES, titleCase: titleCase
  };

  /* ── browser: one shared, lazily built index per page ──
     load() fetches the four feeds (the three the browse pages already use,
     so they are often in the browser's cache, plus the people/pages/news
     index) and builds once. A failed load is forgotten so the next call
     retries. Only the character feed is required: the other three may fail
     and the search still works without them, but that index is marked
     `partial` and NOT kept, so the next call fetches the missing parts again
     (the ones that loaded come back from BotcData's per-page share) instead
     of the page searching without scripts or creators until it is reloaded. */
  if (typeof window !== 'undefined') {
    var loading = null, built = null;
    API.ready = function () { return built; };
    // root: the page's link prefix, when the caller already knows it.
    API.load = function (root) {
      if (built) return Promise.resolve(built);
      if (loading) return loading;
      var B = window.BotcData, r = root != null ? root : B.root();
      function list(p) {
        return B.json(r + p).then(function (rows) {
          if (!Array.isArray(rows)) throw new Error('Invalid search data');
          return rows;
        });
      }
      var partial = false;
      function optional(p, empty) {
        return p.catch(function () { partial = true; return empty; });
      }
      loading = Promise.all([
        list('characters.json?fields=grid'),
        optional(list('scripts.json?fields=browse'), []),
        optional(list('collections.json?fields=browse'), []),
        optional(B.json(r + 'api/search-index'), {})
      ]).then(function (res) {
        var idx = createIndex({ characters: res[0], scripts: res[1], collections: res[2], extra: res[3] || {} }, r);
        idx.data = { characters: res[0], scripts: res[1], collections: res[2], extra: res[3] || {} };
        idx.partial = partial;
        if (!partial) built = idx;
        loading = null;
        return idx;
      }, function (err) { loading = null; throw err; });
      return loading;
    };
    window.BotcSearch = API;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
