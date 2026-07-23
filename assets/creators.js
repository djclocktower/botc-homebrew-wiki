/* Shared creator-symbol registry — the "credit icons".
   Single source of truth for each creator's unique symbol. Shown on the
   Creator Icons page (creators.html) and next to the creator's name on every
   character page. Adding or changing a creator symbol = edit ONLY this file.

   Browser + Worker safe: no DOM access at module top level. render.js pulls
   this in (via Render.setCreators) to server-side render the mark on /c/
   pages; creators.html builds its grid from it; the create/edit previews load
   it so the editor matches the published page. */
(function () {
  // Order here is the display order on the Creator Icons page.
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
    "ctlq": "¢",
    "Comrade": "☭",
    "Dark": "ξ",
    "Darrivis": "D",
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
    "Hystrex": "∇",
    "Imze": "Ϟ",
    "J.C.": "⦿",
    "Lady Mist": "֎",
    "Lawrence": "¥",
    "Luis": "✦",
    "Ma'ayan": "Ω",
    "Maja": "⸸",
    "Margs": "𐚁",
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
    "SCP: Fragmented Veil": "█",
    "Schemer": "»",
    "Skadoosher": "Ꝥ",
    "Soothslayer": "♪",
    "Super": "¬",
    "Squ4ll": "₳",
    "Sy": "꩜",
    "Taco": "¿",
    "Temporary": "╦",
    "Tir": "♄",
    "thelast19digitsofpi": "ℵ",
    "Varii": "♡",
    "Wrendle": "♠"
  };

  // Case-insensitive creator display name -> symbol glyph (or '' if unknown).
  var _byLower = null;
  function creatorSymbol(name) {
    if (!name) return '';
    if (!_byLower) {
      _byLower = {};
      for (var k in CREATOR_SYMBOLS) {
        if (Object.prototype.hasOwnProperty.call(CREATOR_SYMBOLS, k)) {
          _byLower[k.toLowerCase()] = CREATOR_SYMBOLS[k];
        }
      }
    }
    return _byLower[String(name).trim().toLowerCase()] || '';
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

  var api = {
    CREATOR_SYMBOLS: CREATOR_SYMBOLS,
    creatorSymbol: creatorSymbol,
    stripCreatorMark: stripCreatorMark
  };
  if (typeof window !== 'undefined') {
    window.CreatorSymbols = api;
    window.CREATOR_SYMBOLS = CREATOR_SYMBOLS;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
