/* Creator marks — each creator's own symbol, drawn beside their name.

   Two sources, merged into one registry by the Worker (buildMarkRegistry):
   - ACCOUNT marks, claimed by a member on their account page and stored in
     D1 (creator_marks: one per account, the glyph unique by constraint). A
     mark is plain Unicode text and nothing else, so it works everywhere a
     name does: the wiki, the exported script JSON, the official script
     tool, Discord. (Uploaded pictures were tried and dropped for that
     reason: an image cannot leave the wiki.)
   - The LEGACY table below: symbols handed out before accounts could claim
     one, keyed by creator NAME. A name that resolves to an account counts as
     that account's mark until the account picks one of its own (which
     releases the old glyph); a name with no account keeps its glyph reserved.

   setMarks() installs the registry (the Worker before each SSR render, the
   browser through load()); until then, lookups fall back to the table below.
   markHTML() is the one way a mark is drawn, tooltip included.

   Browser + Worker safe: no DOM access at module top level. */
(function () {
  // Legacy symbols, handed out by hand before accounts could claim a mark.
  // Never add to this list: new marks are claimed on the account page.
  var CREATOR_SYMBOLS = {
    "Aba": "⁛",
    "Alex": "∞",
    "Amelia": "ψ",
    "Arbalest": "𐂂",
    "Autumn": "𐑣",
    "BakedIce": "★",
    "Barko": "⍼",
    "The Bazaar": "†",
    "Brewulation & Boilers": "β",
    "Bio": "☠",
    "Chal": "◮",
    "chloeispink": "±",
    "Coda": "⊕",
    "concavz": "凹",
    "ctlq": "¢",
    "Comrade": "☭",
    "Dark": "ξ",
    "Darrivis": "D",
    "Delta": "𝝳",
    "Drossel": "𖤓",
    "Elden Thorn": "⁂",
    "Eliderad": "灯",
    "Elluna": "§",
    "FakeTier": "π",
    "Galexy": "⟁",
    "Geebs": "🜚",
    "Gobinator": "ꙮ",
    "Harry & Co. & Bendan": "♊",
    "Haunted": "⍨",
    "Hyperswag": "◐",
    "Hystrex": "∇",
    "Imze": "Ϟ",
    "J.C.": "⦿",
    "Lady Mist": "֎",
    "Lawrence": "¥",
    "Luis": "✦",
    "Ma'ayan": "Ω",
    "Maja": "⸸",
    "Margs": "𐚁",
    "Mr Froggit": "◈",
    "Mythbusters": "∄",
    "Nerdguy": "∑",
    "Nycto": "ф",
    "Nyla": "☾",
    "ODE": "₽",
    "Panfex": "¶",
    "Parceval": "∻",
    "Pixlate": "Φ",
    "Procyon": "✸",
    "Pynstripe": "♣︎",
    "Rams": "🜲",
    "Requiem": "α",
    "Robo": "⏻",
    "Safterix": "⛧",
    "Sally": "𝄡",
    "Scape": "⛯",
    "SCP: Fragmented Veil": "█",
    "Schemer": "»",
    "Skadoosher": "Ꝥ",
    "Soothslayer": "♪",
    "Super": "¬",
    "Spear_": "Δ",
    "Squ4ll": "₳",
    "Sy": "꩜",
    "Taco": "¿",
    "Temporary": "╦",
    "Tir": "♄",
    "That_Amnesiac": "𝄞",
    "thelast19digitsofpi": "ℵ",
    "Varii": "♡",
    "VaultDemonPsycho": "¡"
  };
  // The Discord handle behind a legacy name, where the list gives one (one
  // person only; a shared mark like The Bazaar's stays the name's). The
  // Worker links the mark to the account with that Discord, or that handle.
  var LEGACY_HANDLES = {
    "Alex": "ur_l0cal_id1o4",
    "Bio": "bionicnecromancer",
    "Dark": "thedarkestartist",
    "Elden Thorn": "eldenthorn.",
    "Eliderad": "eliderad",
    "Maja": "luhkmeih",
    "Mr Froggit": "_mrfroggit",
    "ODE": "0rig0nal",
    "Procyon": "procyon8",
    "Rams": "ramsplooge",
    "Robo": "robo.tea",
    "Schemer": "secret_schemer",
    "Super": "supergdpwyl",
    "Spear_": "spearkiller",
    "Sy": "sy.py",
    "Taco": "alonelytaco1337",
    "Temporary": "temporary0533",
    "Varii": "_varii"
  };

  // Case-insensitive name -> legacy glyph, for before setMarks() has run.
  var _byLower = null;
  function legacySymbol(key) {
    if (!_byLower) {
      _byLower = Object.create(null);
      for (var k in CREATOR_SYMBOLS) {
        if (Object.prototype.hasOwnProperty.call(CREATOR_SYMBOLS, k)) {
          _byLower[k.toLowerCase()] = { g: CREATOR_SYMBOLS[k], d: k, legacy: 1 };
        }
      }
    }
    return _byLower[key] || null;
  }

  /* The registry: [{g, k, u?, d, n:[names], legacy?, hide?}].
     g the glyph, k its comparison key,
     u the owning account's username, d who it belongs to as a reader would
     say it, n the credit names it is drawn beside, hide = the owner switched
     showing it off (still theirs, still on the list, drawn nowhere). */
  var MARKS = null, IDX = null;
  function indexMarks(list) {
    var byName = Object.create(null), byUser = Object.create(null);
    (list || []).forEach(function (m) {
      if (!m || !m.g) return;
      if (m.u) byUser[String(m.u).toLowerCase()] = m;
      if (m.hide) return;
      (m.n || []).forEach(function (n) {
        var k = String(n).trim().toLowerCase();
        if (k && !byName[k]) byName[k] = m;
      });
    });
    return { byName: byName, byUser: byUser };
  }
  function setMarks(reg) {
    MARKS = reg && Array.isArray(reg.marks) ? reg.marks : null;
    IDX = MARKS ? indexMarks(MARKS) : null;
  }
  function allMarks() { return MARKS; }
  // A credit name -> the mark drawn beside it, or null.
  function creatorMark(name) {
    if (!name) return null;
    var k = String(name).trim().toLowerCase();
    return IDX ? (IDX.byName[k] || null) : legacySymbol(k);
  }
  // An account -> its mark (hidden ones only when asked for: the account page).
  function userMark(username, includeHidden) {
    if (!IDX || !username) return null;
    var m = IDX.byUser[String(username).toLowerCase()] || null;
    return m && (includeHidden || !m.hide) ? m : null;
  }
  // Case-insensitive creator display name -> symbol glyph (or '' if unknown).
  function creatorSymbol(name) {
    var m = creatorMark(name);
    return m ? m.g : '';
  }

  /* What makes two glyphs "the same mark": compatibility-normalised (so the
     ohm sign is omega and a fullwidth symbol its plain twin), variation
     selectors and joiners dropped (♣︎ and ♣ are one mark). Case is NOT
     folded: Δ and δ (𝝳) are two creators' marks. */
  function markKey(g) {
    var s = String(g == null ? '' : g);
    if (s.normalize) s = s.normalize('NFKC');
    return s.replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060]/g, '').trim();
  }
  /* Why a glyph cannot be a mark, or '' when it can. Asked by the account
     page as you type and by the Worker on save, so both say the same thing.
     Uniqueness is the Worker's question (it needs the registry). */
  function markProblem(g) {
    var s = String(g == null ? '' : g).trim();
    var k = markKey(s);
    if (!k) return 'Pick a symbol for your mark.';
    if (/\s/.test(s)) return 'A mark cannot contain spaces.';
    if (Array.from(k).length > 3) return 'A mark is one symbol (three characters at most).';
    if (/^[a-z0-9]+$/i.test(k)) return 'Plain letters and numbers read as part of the name. Pick a symbol.';
    if (/[\u0000-\u001f\u007f<>"'`&,;:\[\]{}()|\\\/*_~#]/.test(s)) return 'That character cannot be used in a mark (it means something in names or formatting).';
    return '';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // Who a mark belongs to, as the tooltip says it.
  function markOwner(m) {
    var who = m.d || m.u || 'a creator';
    if (m.u && String(m.u).toLowerCase() !== String(who).toLowerCase()) who += ' (@' + m.u + ')';
    return who;
  }
  /* A mark as markup. The tooltip is CSS (data-tip, .creator-mark in
     styles.css) so it shows at once on hover and on a tap (tabindex makes a
     tap focus it); aria-label says the same to a screen reader. */
  function markHTML(m, opts) {
    if (!m || !m.g) return '';
    opts = opts || {};
    var tip = opts.tip || ('Creator mark of ' + markOwner(m));
    var cls = 'creator-mark' + (opts.cls ? ' ' + opts.cls : '');
    var a = ' data-tip="' + esc(tip) + '" role="img" aria-label="' + esc(tip) + '"' +
      (opts.noFocus ? '' : ' tabindex="0"');
    return '<span class="' + cls + '"' + a + '>' + esc(m.g) + '</span>';
  }
  function markHTMLFor(name, opts) { return markHTML(creatorMark(name), opts); }

  /* A character name with its creators' marks after it — what the Script
     Builder's "creator marks on names" option exports. A name that already
     carries the mark (some were typed that way) is not given it twice. */
  function nameWithMarks(name, creator) {
    var credits = splitCreators(creator);
    var base = stripCreatorMark(name, credits[0] || '');
    var gs = [];
    credits.forEach(function (c) { var g = creatorSymbol(c); if (g && gs.indexOf(g) === -1) gs.push(g); });
    return gs.length ? base + ' ' + gs.join('') : base;
  }

  /* Browser: fetch the live registry once per page. Resolves with the list,
     or null if it could not be read (the legacy table keeps answering). */
  var _loading = null;
  function load() {
    if (_loading) return _loading;
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    _loading = fetch('/api/creator-marks', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && Array.isArray(d.marks)) setMarks(d);
        else _loading = null;
        return MARKS;
      }, function () { _loading = null; return null; });
    return _loading;
  }

  // Remove a trailing creator mark from a character name, for display only.
  // Some names carry the creator's symbol baked in (e.g. "Cheerleader ∇",
  // "... ♊︎"); the symbol now renders as the credit icon, so it would show
  // twice. Strip the creator's own symbol (plus any variation selector and
  // surrounding whitespace) off the end. Stored names are never modified.
  //
  // Only decorative (non-alphanumeric) symbols are stripped, so a creator
  // whose symbol is a plain letter (e.g. Darrivis = "D") can never truncate a
  // real name like "Nomad".
  function stripCreatorMark(name, creator) {
    var s = String(name == null ? '' : name);
    var sym = creatorSymbol(creator);
    if (!sym || /[0-9a-z]/i.test(sym)) return s.replace(/\s+$/, '');
    var esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('[\\s\\u200b]*' + esc + '[\\uFE00-\\uFE0F]*\\s*$');
    return s.replace(re, '').replace(/\s+$/, '');
  }

  // A page can credit several people. The stored `creator` field keeps them in
  // one string separated by COMMAS ("Taiyi (太一), Saki") — never "&" or "and",
  // which are part of single creator names like "Harry & Co & Bendan" and
  // "Bhamber and Paradox". Splitting here is the single source of truth so the
  // character page, the author pages and the browse filters all agree on who
  // gets credit for a page.
  function splitCreators(s) {
    return String(s == null ? '' : s).split(',')
      .map(function (n) { return n.trim(); })
      .filter(Boolean);
  }

  var api = {
    CREATOR_SYMBOLS: CREATOR_SYMBOLS, LEGACY_HANDLES: LEGACY_HANDLES,
    creatorSymbol: creatorSymbol,
    creatorMark: creatorMark, userMark: userMark, allMarks: allMarks,
    setMarks: setMarks, indexMarks: indexMarks, load: load,
    markKey: markKey, markProblem: markProblem, markOwner: markOwner,
    markHTML: markHTML, markHTMLFor: markHTMLFor, nameWithMarks: nameWithMarks,
    stripCreatorMark: stripCreatorMark,
    splitCreators: splitCreators
  };
  if (typeof window !== 'undefined') {
    window.CreatorSymbols = api;
    window.CREATOR_SYMBOLS = CREATOR_SYMBOLS;
    window.splitCreators = splitCreators;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
