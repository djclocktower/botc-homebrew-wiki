/* Shared character renderer.
   Used in the browser by create.html / edit.html (live preview) and by the
   collection JSON box on all-characters.html — and bundled into the Worker
   (worker/worker.js imports this file) to server-side render /c/{slug} pages.
   Because both sides share this code, the editor preview and the published
   page are guaranteed to match. No DOM access outside the guarded blocks. */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function tok(s) {
    return esc(s).replace(/\[\[(.+?)\]\]/g, '<span class="tok">$1</span>');
  }
  var TEAM_LABEL = {
    townsfolk: 'Townsfolk', outsider: 'Outsider', minion: 'Minion',
    demon: 'Demon', traveller: 'Traveller', fabled: 'Fabled', loric: 'Loric'
  };
  function R() { return (typeof window !== 'undefined' && window.LINK_ROOT) || ''; }
  /* Curata mark markup, from classify.js — injected by the Worker
     (setCurataMark) or read off the global in the browser, so render.js never
     has to import classify.js itself. Partial is deliberately NOT shown on
     the page: an unfinished page is its owner's business, and the Worker
     tells them in a banner instead (renderCharacterPage in worker.js). */
  var curataMarkFn = null;
  function setCurataMark(fn) { curataMarkFn = fn; }

  /* The wiki markup engine (assets/render-wiki.js), used for the one field
     that takes formatting: the pronunciation line. The Worker hands it over
     with init(); in the browser it is picked up off the global if the page
     loaded it. Resolved per call, so load order does not matter. Without it
     the text still renders — escaped and unformatted, never raw. */
  var wiki = null;
  function init(w) { wiki = w || null; }
  function inlineText(str) {
    var W = wiki || (typeof window !== 'undefined' ? window.WikiRender : null);
    return (W && W.inlineFormat) ? W.inlineFormat(str, { linkRoot: R() }) : esc(str);
  }
  function curataMark(d) {
    if (!d || !(d.curata || d.classification === 'curata')) return '';
    var fn = curataMarkFn ||
      (typeof window !== 'undefined' ? window.classBadgeHTML : null);
    return fn ? fn('curata', { from: d.curataFrom }) : '';
  }
  /* "Appears in": the creator's own free-text line if there is one, else the
     collections that list this character by hand (worked out on read as
     `appearsInFrom`; see applyCollectionAppearsIn in worker.js). The typed
     line is linked in the browser by charpage.js; the derived one already
     knows its collection's id, so it arrives as a link. */
  function appearsInRow(d, root) {
    var own = (d.appearsIn || '').trim();
    if (own) {
      return '<dt>Appears in:</dt><dd class="info-appears-in" data-appears-in="' +
        esc(own) + '">' + esc(own) + '</dd>';
    }
    var from = Array.isArray(d.appearsInFrom) ? d.appearsInFrom : [];
    var links = from.map(function (c) {
      if (!c || !c.name) return '';
      if (!c.id) return esc(c.name);
      return '<a class="appears-in-link" href="' + root + 'collection/' +
        encodeURIComponent(c.id) + '">' + esc(c.name) + '</a>';
    }).filter(Boolean).join('<span class="tag-sep">, </span>');
    if (!links) return '';
    return '<dt>Appears in:</dt><dd class="info-appears-in">' + links + '</dd>';
  }
  /* "Anyone can edit this page", and the link to its history. Only an opened
     page says so, which is how anybody finds out they are welcome to help. The
     history link shares the row because it answers the same question: who has
     been here, and what did they do? A page that is not open still has a
     history, reached from its Edit view and the account page. */
  var OPEN_EDIT_TEXT = {
    all: ['open to all', 'anyone with an account can edit this page. '],
    tags: ['tags open to all', 'anyone with an account can change the tags. '],
    suggest: ['suggestions welcome', 'anyone with an account can propose an edit for the creator to approve. ']
  };
  function openEditRow(d, root) {
    var t = OPEN_EDIT_TEXT[d.publicEdit];
    if (!t) return '';
    var slug = encodeURIComponent(d.slug || '');
    var links = '<a class="hist-page-link" href="' + root + 'history?type=character&amp;slug=' + slug + '">Edit history</a>';
    if (d.publicEdit === 'suggest') {
      links = '<a class="hist-page-link" href="' + root + 'edit?c=' + slug + '">Suggest an edit</a> ' + links;
    }
    return '<dt>Editing:</dt><dd class="open-edit-row"><span class="oe-chip">' + t[0] + '</span> ' +
      t[1] + links + '</dd>';
  }

  function jinxURL(name) {
    return 'https://wiki.bloodontheclocktower.com/' +
      esc(String(name).trim().replace(/\s+/g, '_'));
  }
  // Map known slugified IDs back to proper display names for jinx links
  var JINX_ID_NAMES = {
    'alhadikhia':'Al-Hadikhia','eviltwin':'Evil Twin','lilmonsta':"Lil' Monsta",
    'organgrinder':'Organ Grinder','pithag':'Pit-Hag','plaguedoctor':'Plague Doctor',
    'poppygrower':'Poppy Grower','scarletwoman':'Scarlet Woman',
    'snakecharmer':'Snake Charmer','villageidiot':'Village Idiot',
    'banxian_festival_of_lanterns':'Ban Xian','pedant_festival_of_lanterns':'Pedant'
  };
  /* An id with no name behind it: `cadenza_the_academy` used to render as
     "Cadenza_the_academy" because the fallback only capitalised the first
     letter. Bulk imports build these as {character}_{collection}, so keep the
     leading segment and capitalise it. Official ids carry no separator
     (`plaguedoctor`), so they are unaffected. */
  function prettifyJinxId(id) {
    var parts = String(id || '').split(/[_-]+/).filter(Boolean);
    if (!parts.length) return '';
    // `mystic_the_academy`, `zuggtmoy_travelbythestarlight` \u2014 the leading
    // segment is the character, the rest is where it came from.
    var name = parts[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  function jinxDisplayName(j) {
    if (j.name && j.name.trim()) return j.name.trim();
    var id = j.id || '';
    if (JINX_ID_NAMES[id]) return JINX_ID_NAMES[id];
    return prettifyJinxId(id) || id;
  }

  function slugId(name) {
    return String(name || '').toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 50);
  }

  // Official character icon URLs (from assets/roles.json \u2014 the same source the
  // Token Tool uses for official art), keyed by slugId(id/name). When set, an
  // official character named in a jinx uses its official icon instead of the
  // committed assets/icons/*.png copy. Set by the Worker (SSR) and by the
  // create/edit editors; if unset, jinx icons fall back to the local copies.
  var OFFICIAL_ICON_URLS = null;
  function setOfficialIconUrls(map) { OFFICIAL_ICON_URLS = map || null; }
  function officialIconUrl(id) {
    if (!OFFICIAL_ICON_URLS || !id) return '';
    var u = OFFICIAL_ICON_URLS[slugId(id)];
    return (typeof u === 'string' && /^https?:\/\//.test(u)) ? u : '';
  }

  /* Official display names, keyed the same way. Jinx names are typed by hand,
     so the wiki carries "leviathan", "pithag" and "plaguedoctor" where it
     means Leviathan, Pit-Hag and Plague Doctor. When the target is an
     official character, its real name wins over whatever was typed, the same
     courtesy the icon already gets. Unset, the typed text stands. */
  var OFFICIAL_NAMES = null;
  function setOfficialNames(map) { OFFICIAL_NAMES = map || null; }
  function officialName(id) {
    if (!OFFICIAL_NAMES || !id) return '';
    var n = OFFICIAL_NAMES[slugId(id)];
    return (typeof n === 'string' && n) ? n : '';
  }

  /* This wiki's own characters, keyed by normJinxId() of slug and of name, so a
     jinx naming another homebrew page can find it. Same injection pattern as
     the official icon map: the Worker sets it for SSR, the editors set it from
     characters.json. Unset, jinx rendering is what it was before: official
     characters resolve, homebrew ones fall back to plain text. */
  var WIKI_CHARS = null;
  function setWikiChars(map) { WIKI_CHARS = map || null; }
  function wikiChar(key) {
    if (!WIKI_CHARS || !key) return null;
    var c = WIKI_CHARS[key];
    return (c && c.slug) ? c : null;
  }
  /* A wiki character's icon. Mirrors artSrc() in render-page.js: `art` is a
     path under /assets (R2-backed), `image` is an absolute URL from a bulk
     import, and a page may carry either or both. */
  function wikiCharIcon(c, root) {
    if (!c) return '';
    if (c.art) return root + 'assets/' + c.art;
    if (typeof c.image === 'string' && c.image) return c.image;
    if (Array.isArray(c.image) && c.image[0]) return c.image[0];
    return '';
  }

  /* ── Where does a jinx entry point? ──────────────────────────────────
     One answer for every consumer: the /c/ page box, the script and
     collection jinx lists, and the /jinxes index. Returns
     {name, href, iconSrc, external, slug, team}.

     Order matters, and official comes before this wiki deliberately: 291 of
     the 319 jinxes live on the site name an official character, and a
     homebrew page that happens to share a name (there is more than one
     "Sculptor") must not steal their link. An entry written by the jinx
     picker carries an explicit `slug`, which skips the guessing entirely. */
  // A wiki character's link. `slug` is the identity; `page` is the address
  // the Worker resolved (c/{set}/{character}). Falling back to the identity
  // still reaches the page — /c/{identity} 301s to the address — but the
  // address avoids the extra hop.
  function charHref(c, root) {
    var p = (c && c.page) ? String(c.page) : ('c/' + ((c && c.slug) || ''));
    return (root || '') + p.replace(/^\//, '').replace(/\.html$/, '');
  }

  function resolveJinxTarget(j, root) {
    root = root || '';
    var nm = jinxDisplayName(j);
    var rawId = j.id || slugId(j.name || '');
    var iconId = rawId.replace(/_festival_of_lanterns$/, '').replace(/-/g, '');

    // 1. An explicit slug from the picker: unambiguous, no name matching.
    if (j.slug) {
      var pick = wikiChar(normJinxId(j.slug));
      if (pick) {
        return { name: pick.name || nm, href: charHref(pick, root),
                 iconSrc: wikiCharIcon(pick, root), external: false,
                 slug: pick.slug, team: pick.team || '' };
      }
    }

    // 2. An official character keeps the official icon and the official wiki,
    //    and takes its proper name back from roles.json.
    var offIcon = officialIconUrl(iconId) || officialIconUrl(nm);
    if (offIcon) {
      var offNm = officialName(iconId) || officialName(nm) || nm;
      return { name: offNm, href: jinxURL(offNm), iconSrc: offIcon,
               external: true, slug: '', team: '' };
    }

    // 3. One of ours, matched by id or by name.
    var hit = wikiChar(normJinxId(rawId)) || wikiChar(normJinxId(nm));
    if (hit) {
      return { name: hit.name || nm, href: charHref(hit, root),
               iconSrc: wikiCharIcon(hit, root), external: false,
               slug: hit.slug, team: hit.team || '' };
    }

    // 4. Unknown: an official character whose icon map has not loaded, or a
    //    draft, or a typo. The committed icon copy still resolves most of
    //    these, and onerror hides it when it does not.
    return { name: nm, href: jinxURL(nm),
             iconSrc: iconId ? (root + 'assets/icons/' + iconId + '.png') : '',
             external: true, slug: '', team: '' };
  }

  // Creator-symbol registry ("credit icons"), shared with creators.js. The
  // Worker injects it for SSR (setCreators); in the browser we fall back to
  // the global that assets/creators.js publishes. Either way, a character page
  // shows the creator's symbol next to their name in the info box.
  var CREATORS = null;
  function setCreators(api) { CREATORS = api || null; }
  function creatorsApi() {
    if (CREATORS) return CREATORS;
    if (typeof window !== 'undefined' && window.CreatorSymbols) return window.CreatorSymbols;
    return null;
  }
  function creatorSymbol(name) {
    var c = creatorsApi();
    return (c && c.creatorSymbol) ? c.creatorSymbol(name) : '';
  }
  function stripCreatorMark(name, creator) {
    var c = creatorsApi();
    return (c && c.stripCreatorMark) ? c.stripCreatorMark(name, creator)
      : String(name == null ? '' : name);
  }
  // Co-credited pages store their creators comma-separated; each one links to
  // its own author page. creators.js owns the rule — this falls back to the
  // same split so a page that hasn't loaded it still renders every name.
  function splitCreators(s) {
    var c = creatorsApi();
    if (c && c.splitCreators) return c.splitCreators(s);
    return String(s == null ? '' : s).split(',')
      .map(function (n) { return n.trim(); }).filter(Boolean);
  }

  /* ── official-schema `special` entries ──
     The script tool's per-character behaviour flags: how a character is shown
     in the app, what the Storyteller's grimoire does with it, whether it may
     be drawn from the bag at all. The Drunk carries
     {type:"ability", name:"bag-disabled"}; the Phantom, being the same kind of
     character, needs the same entry or the app treats it as an ordinary
     townsfolk. `setup` was the only one of these the wiki understood, so
     everything else was dropped on import and missing from the export.

     Kept deliberately permissive on `name`: the official vocabulary grows, and
     an entry the wiki has never heard of still belongs to the character.
     What is enforced is the shape — a known type, a plain string name, and
     numbers/strings in the optional slots — so nothing can smuggle an object
     into somebody's exported JSON. */
  var SPECIAL_TYPES = ['selection', 'ability', 'signal', 'vote', 'reveal', 'player'];
  var SPECIAL_TIMES = ['pregame', 'day', 'night', 'firstNight', 'firstDay', 'otherNight', 'otherDay'];
  function sanitizeSpecial(list) {
    if (!Array.isArray(list)) return [];
    var out = [];
    list.forEach(function (s) {
      if (!s || typeof s !== 'object') return;
      var type = String(s.type || '').trim();
      var name = String(s.name || '').trim().slice(0, 60);
      if (!name || SPECIAL_TYPES.indexOf(type) === -1) return;
      var o = { type: type, name: name };
      if (s.value !== undefined && s.value !== null && s.value !== '') {
        var v = Number(s.value);
        if (!isNaN(v)) o.value = v;
      }
      if (s.time && SPECIAL_TIMES.indexOf(String(s.time)) !== -1) o.time = String(s.time);
      if (s.global) {
        var g = String(s.global).trim().slice(0, 20);
        if (g) o.global = g;
      }
      if (out.length < 12) out.push(o);
    });
    return out;
  }

  /* ── Build official-schema JSON object from character data ── */
  function buildSchema(d) {
    var o = {
      id: d.jsonId || slugId(d.name),
      name: d.name || '',
      team: d.team || 'townsfolk',
      ability: d.ability || ''
    };
    // image as array (required by official script tool); alternate art
    // (e.g. an evil version) rides along as the second entry
    var imgs = d.image ? (Array.isArray(d.image) ? d.image.slice() : [d.image]) : [];
    if (d.imageAlt && imgs.indexOf(d.imageAlt) === -1) imgs.push(d.imageAlt);
    if (imgs.length) o.image = imgs;
    if (d.edition) o.edition = d.edition;
    var fl = d.flavor || d.quote;
    if (fl) o.flavor = String(fl).replace(/^["']|["']$/g, '');
    o.firstNight = Number(d.firstNight) || 0;
    if (d.firstNightReminder) o.firstNightReminder = d.firstNightReminder;
    o.otherNight = Number(d.otherNight) || 0;
    if (d.otherNightReminder) o.otherNightReminder = d.otherNightReminder;
    if (d.reminders && d.reminders.length) o.reminders = d.reminders;
    if (d.remindersGlobal && d.remindersGlobal.length) o.remindersGlobal = d.remindersGlobal;
    if (d.setup) o.setup = true;
    if (d.jinxes && d.jinxes.length) {
      var jx = d.jinxes.map(function (j) {
        return { id: j.id || slugId(j.name), reason: j.text || j.reason || '' };
      }).filter(function (j) { return j.id; });
      if (jx.length) o.jinxes = jx;
    }
    var sp = sanitizeSpecial(d.special);
    if (sp.length) o.special = sp;
    return o;
  }
  function schemaJSON(d) {
    var meta = { id: '_meta', name: '' };
    return JSON.stringify([meta, buildSchema(d)], null, 2);
  }

  /* ── the botchomebrew.wiki credits Fabled ──
     Every script exported from the Script Builder (script.html) carries one
     extra Fabled entry: the wiki's pirate skull, crediting the site and the
     people whose characters are on the script. Deliberately BUILDER-ONLY —
     a published script's own JSON box (buildPageExport in render-page.js) is
     the author's script and must stay exactly what they published.

     Two forms, chosen by the reader's "Detailed credits" tick:
       plain     ... contains characters by: Hystrex, Ma'ayan, Tir.
       detailed  ... contains characters by: Hystrex (Cheerleader, Nomad);
                     Ma'ayan (Sculptor).
     Characters with no creator credited are left out of the list (official
     roles export as bare ids and never reach here); a script where nobody is
     credited still gets the Fabled, just without the "by:" half. */
  var CREDITS_FABLED_ID = 'botchomebrewwiki';
  var CREDITS_FABLED_NAME = 'botchomebrew.wiki';
  var CREDITS_FABLED_IMAGE = 'https://botchomebrew.wiki/assets/logo_skull.png';
  var CREDITS_FABLED_LEAD = 'This script was made on botchomebrew.wiki';

  /* [{ creator, characters[] }] in order of first appearance on the script.
     A page can credit several people ("Taiyi (太一), Saki") — each of them is
     credited separately, and a co-written character is listed under each. */
  function creditsByCreator(chars) {
    var order = [], byName = {};
    (chars || []).forEach(function (c) {
      if (!c || c.official) return;
      splitCreators(c.creator).forEach(function (name) {
        var key = name.toLowerCase();
        if (!byName[key]) { byName[key] = { creator: name, characters: [] }; order.push(byName[key]); }
        var nm = stripCreatorMark(c.name, name) || c.name || '';
        if (nm && byName[key].characters.indexOf(nm) === -1) byName[key].characters.push(nm);
      });
    });
    return order;
  }

  function creditsAbility(chars, detailed) {
    var groups = creditsByCreator(chars);
    if (!groups.length) return CREDITS_FABLED_LEAD + '.';
    var list = detailed
      ? groups.map(function (g) {
          return g.creator + (g.characters.length ? ' (' + g.characters.join(', ') + ')' : '');
        }).join('; ')
      : groups.map(function (g) { return g.creator; }).join(', ');
    return CREDITS_FABLED_LEAD + ' and contains characters by: ' + list + '.';
  }

  /* The official-schema object to append to an exported script.
     opts: {detailed} — one line per creator with their characters named. */
  function buildCreditsFabled(chars, opts) {
    return {
      id: CREDITS_FABLED_ID,
      name: CREDITS_FABLED_NAME,
      team: 'fabled',
      image: CREDITS_FABLED_IMAGE,
      ability: creditsAbility(chars, !!(opts && opts.detailed)),
      firstNight: 0,
      otherNight: 0
    };
  }

  /* ── Find jinxes that are active between characters on the same script ──
     Takes an array of character objects; returns [{a, b, text}] where `a`
     carries the jinx and `b` is the matching character also in the list. */
  function normJinxId(id) {
    return String(id || '').replace(/_festival_of_lanterns$/, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  function findScriptJinxes(chars) {
    var byId = {};
    chars.forEach(function (c) {
      [slugId(c.name), normJinxId(c.jsonId), (c.slug || '').replace(/-/g, '')]
        .forEach(function (id) { if (id) byId[id] = c; });
    });
    var out = [], seen = {};
    chars.forEach(function (c) {
      (c.jinxes || []).forEach(function (j) {
        // An entry written by the jinx picker names its target outright; the
        // older ones have to be matched by id or by name.
        var target = (j.slug && byId[normJinxId(j.slug)]) ||
          byId[normJinxId(j.id || slugId(j.name || ''))];
        if (!target || target === c) return;
        var text = j.text || j.reason || '';
        var key = [c.slug || c.name, target.slug || target.name].sort().join('|') + '|' + text;
        if (seen[key]) return;
        seen[key] = 1;
        out.push({ a: c, b: target, text: text });
      });
    });
    return out;
  }

  /* ── Collapsible JSON box ── */
  function renderJsonBox(d) {
    // A user-supplied custom JSON replaces the auto-generated schema.
    var json;
    if (d.customJson && String(d.customJson).trim()) {
      var raw = String(d.customJson).trim();
      try { json = JSON.stringify(JSON.parse(raw), null, 2); }
      catch (e) { json = raw; }
    } else {
      json = schemaJSON(d);
    }
    return '<div class="json-box">' +
      '<div class="json-bar">' +
      '<span class="json-bar-toggle" role="button" tabindex="0" aria-expanded="false">JSON <span class="json-arrow">&#9662;</span></span>' +
      '<button type="button" class="json-copy">Copy JSON</button>' +
      '</div>' +
      '<pre class="json-body" hidden><code>' + esc(json) + '</code></pre>' +
      '</div>';
  }

  /* The quiet "how do you say it" block under the flavour quote. Three
     optional lines, any of which may stand alone:
       pronunciation  free text, the only character field that takes the
                      wiki's inline marks (**bold** / *italic*), so an author
                      can stress a syllable in their own words
       ipa            the IPA spelling, e.g. /bʊˈgɛːn/
       respelling     a plain-English respelling, e.g. buh-GAIN
     IPA and the respelling are notation rather than prose, so they are
     escaped and printed verbatim — an asterisk in a respelling is an
     asterisk, not italics. */
  function pronounceBlock(d) {
    var free   = String((d && d.pronunciation) || '').trim();
    var ipa    = String((d && d.ipa) || '').trim();
    var respel = String((d && d.respelling) || '').trim();
    if (!free && !ipa && !respel) return '';
    return '<div class="pronounce-block">' +
      '<span class="pronounce-label">Pronunciation</span>' +
      (free ? '<p class="pronounce">' + inlineText(free) + '</p>' : '') +
      (ipa ? '<p class="pronounce pronounce-ipa">' + esc(ipa) + '</p>' : '') +
      (respel ? '<p class="pronounce pronounce-respell">' + esc(respel) + '</p>' : '') +
      '</div>';
  }

  /* ── Full character page body ── */
  function renderCharacter(d, artSrc, linkRoot) {
    var root = (linkRoot != null) ? linkRoot
      : ((typeof window !== 'undefined' && window.LINK_ROOT) || '');
    var team = d.team || 'townsfolk';
    var label = TEAM_LABEL[team] || team;
    var bullets  = (d.summaryBullets || []).filter(function (x) { return x && x.trim(); });
    var paras    = (d.howToRun || []).filter(function (x) { return x && x.trim(); });
    var examples = (d.examples || []).filter(function (x) { return x && x.trim(); });
    var tips     = (d.tips || []).filter(function (x) { return x && x.trim(); });
    var bluffing = (d.bluffing || []).filter(function (x) { return x && x.trim(); });
    var fighting = (d.fighting || []).filter(function (x) { return x && x.trim(); });
    var jinxes   = (d.jinxes || []).filter(function (j) { return j && (j.name || j.id); });

    var summaryCol =
      '<div class="gen-sech-wrap" id="sec-summary"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-summary">Summary</a></h2></div>' +
      (d.ability ? '<p class="ability">' + esc(d.ability) + '</p>' : '') +
      (d.lede ? '<p class="lede">' + esc(d.lede) + '</p>' : '') +
      (bullets.length ? '<ul>' + bullets.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' : '');

    var howColBody = paras.map(function (p) { return '<p>' + tok(p) + '</p>'; }).join('') +
      (d.callout && d.callout.trim() ? '<div class="callout">' + tok(d.callout) + '</div>' : '');
    var howCol = howColBody ?
      '<div class="gen-sech-wrap" id="sec-howtorun"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-howtorun">How to Run</a></h2></div>' + howColBody : '';

    var examplesBlock = examples.length ?
      ('<div class="examples"><div class="gen-sech-wrap" id="sec-examples"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-examples">Examples</a></h2></div>' +
        examples.map(function (e) { return '<div class="ex">' + esc(e) + '</div>'; }).join('') +
        '</div>') : '';

    var tipsBlock = tips.length ?
      ('<div class="tips"><div class="gen-sech-wrap" id="sec-tips"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-tips">Tips &amp; Tricks</a></h2></div>' +
        '<ul>' + tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>') : '';

    var charName = esc(d.name || 'Character');
    var bluffingBlock = bluffing.length ?
      ('<div class="tips"><div class="gen-sech-wrap"><h2 class="gen-sech">Bluffing as the ' + charName + '</h2></div>' +
        '<ul>' + bluffing.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>') : '';
    var fightingBlock = fighting.length ?
      ('<div class="tips"><div class="gen-sech-wrap"><h2 class="gen-sech">Fighting the ' + charName + '</h2></div>' +
        '<ul>' + fighting.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>') : '';

    // Tags row. The Curata wreath hangs off the end of it behind a hairline
    // rule: it is a mark, not a tag, so it is never a link and never joins the
    // comma-separated list — nobody should be able to click it expecting a
    // "Curata" tag page. When a page is Curata but has no tags (it can
    // inherit the wreath from its collection), an em dash holds the tags side so
    // the hairline still separates two things.
    var tagLinks = (d.tags && d.tags.trim()) ? d.tags.split(',').map(function (t) {
      t = t.trim(); if (!t) return '';
      var display = t.toLowerCase().replace(/(^|[\s-])[a-z]/g, function (m) { return m.toUpperCase(); });
      return '<a class="tag-link" data-tag="' + esc(display) + '" href="' + root + 'tag?t=' + encodeURIComponent(display) + '">' + esc(display) + '</a>';
    }).filter(Boolean).join('<span class="tag-sep">, </span>') : '';
    var mark = curataMark(d);
    var tagsRow = (tagLinks || mark)
      ? '<dt>Tags:</dt><dd>' + (tagLinks || '<span class="tag-none">&mdash;</span>') +
        (mark ? '<span class="info-mark-sep" aria-hidden="true"></span>' + mark : '') + '</dd>'
      : '';

    var info = '<dl class="info"><dt>Type:</dt><dd><a class="type-link" href="' + root + 'team?t=' + esc(team) + '">' + esc(label) + '</a></dd>' +
      (splitCreators(d.creator).length
        ? '<dt>Creator' + (splitCreators(d.creator).length > 1 ? 's' : '') + ':</dt><dd>' +
          splitCreators(d.creator).map(function (n) {
            return '<a class="author-link" href="' + root + 'author?a=' + encodeURIComponent(n) + '">' + esc(n) + '</a>' +
              (creatorSymbol(n) ? ' <span class="creator-mark" title="' + esc(n) + '’s symbol" aria-hidden="true">' + esc(creatorSymbol(n)) + '</span>' : '');
          }).join('<span class="tag-sep">, </span>') +
          '</dd>' : '') +
      appearsInRow(d, root) +
      tagsRow +
      openEditRow(d, root) +
      (d.translatedBy && d.translatedBy.trim() ? '<dt>Translated by:</dt><dd>' + esc(d.translatedBy.trim()) + '</dd>' : '') +
      (d.iconBy && d.iconBy.trim() ? '<dt>Icon by:</dt><dd>' + esc(d.iconBy.trim()) + '</dd>' : '') +
      '</dl>';

    // Copy-link button lives in the top-right corner *inside* the info card so
    // it never crowds the title (see .card-actions in styles.css).
    var copyBtn = '<button type="button" class="copy-link-btn" title="Copy link to this character" aria-label="Copy link"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Copy link</button>';

    var quoteClean = (d.quote || d.flavor || '').replace(/^["']|["']$/g, '');
    // Alternate art (e.g. an evil version): click the emblem to swap.
    var altSrc = d.artAlt ? (root + 'assets/' + d.artAlt) : (d.imageAlt || '');
    var emblem = '';
    if (artSrc) {
      emblem = altSrc
        ? '<img class="emblem has-alt" src="' + esc(artSrc) + '" data-main="' + esc(artSrc) +
          '" data-alt="' + esc(altSrc) + '" alt="' + esc(d.name) + '" title="Click to see the alternate art">'
        : '<img class="emblem" src="' + esc(artSrc) + '" alt="' + esc(d.name) + '">';
    }
    var infoCard = '<div class="card char-infocard">' +
      '<div class="card-actions">' + copyBtn + '</div>' +
      emblem +
      (quoteClean.trim() ? '<p class="quote">"' + esc(quoteClean) + '"</p>' : '') +
      pronounceBlock(d) +
      '<h2 class="info-h">Information</h2>' + info + '</div>';

    // Shared jinx item markup, used by both the sidebar box and the dropdown.
    var jinxItems = jinxes.map(function (j) {
      var al = (j.align === 'evil') ? 'evil' : 'good';
      var t = resolveJinxTarget(j, root);
      // A mirrored jinx is stored on the OTHER character's page. It reads the
      // same, but the line underneath says where to go to edit it.
      var from = (j.mirrored && j.mirroredFrom) ?
        '<span class="jfrom">declared on <a href="' + esc(charHref(j.mirroredFrom, root)) +
        '">' + esc(j.mirroredFrom.name) + '</a></span>' : '';
      return '<div class="jinx' + (t.iconSrc ? '' : ' noicon') + '">' +
        (t.iconSrc ? '<img loading="lazy" decoding="async" class="jico" src="' + esc(t.iconSrc) + '" alt=""' +
        ' onerror="this.style.display=\'none\';this.closest(\'.jinx\').classList.add(\'noicon\')">'
        : '') +
        '<div class="jbody">' +
        '<a class="jname ' + al + '" href="' + esc(t.href) + '"' +
        (t.external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        '>' + esc(t.name) + '</a>' +
        '<span class="jtext">' + inlineText(j.text || j.reason || '') + '</span>' +
        from + '</div></div>';
    }).join('');

    // Two ways to show jinxes: a floating box in the sidebar (default) or a
    // collapsible dropdown at the foot of the main column. Chosen per-character.
    var jinxMode = (d.jinxDisplay === 'dropdown') ? 'dropdown' : 'sidebar';
    // Where this character sits in the whole picture. The map is the only
    // place a reader can see a jinx from both ends at once.
    var mapLink = jinxes.length && d.slug ?
      '<a class="jinx-map-link" href="' + root + 'jinxes?c=' + encodeURIComponent(d.slug) +
      '">See this on the jinx map &rarr;</a>' : '';
    var jinxCard = jinxes.length ?
      '<div class="card" id="sec-jinxes">' +
        '<h2 class="gen-sech" style="text-align:center;margin-bottom:14px"><a class="sec-anchor" href="#sec-jinxes">Jinxes</a></h2>' +
        jinxItems + mapLink +
      '</div>' : '';
    var jinxDrop = jinxes.length ?
      '<div class="jinx-drop" id="sec-jinxes">' +
        '<div class="jinx-drop-bar" role="button" tabindex="0" aria-expanded="false">' +
          '<span class="jinx-drop-title">Jinxes</span>' +
          '<span class="jinx-drop-arrow">&#9662;</span>' +
        '</div>' +
        '<div class="jinx-drop-body" hidden>' + jinxItems + mapLink + '</div>' +
      '</div>' : '';

    // Custom user-defined sidebar boxes: any number of {title, content}.
    var customBoxesHtml = (d.customBoxes || []).map(function (b) {
      var title = String((b && b.title) || '').trim();
      var content = String((b && b.content) || '');
      if (!title && !content.trim()) return '';
      var body = content.split(/\n{2,}/).map(function (p) {
        p = p.replace(/\s+$/, '');
        return p.trim() ? '<p>' + tok(p).replace(/\n/g, '<br>') + '</p>' : '';
      }).join('');
      return '<div class="card custom-box">' +
        (title ? '<h2 class="info-h custom-box-h">' + esc(title) + '</h2>' : '') +
        '<div class="custom-box-body">' + body + '</div>' +
      '</div>';
    }).join('');

    // JSON box always lives inside the infocard, below the info dl.
    // The sidebar carries the jinx box (unless dropdown mode) + custom boxes.
    var sideItems = (jinxMode === 'sidebar' ? jinxCard : '') + customBoxesHtml;
    var sideBar = sideItems ? '<aside class="char-side">' + sideItems + '</aside>' : '';
    var infoCardFinal = infoCard.slice(0, -6) +
      '<div style="margin-top:14px">' + renderJsonBox(d) + '</div></div>';

    // Title auto-fits to its width: --nch (letter count, spaces collapsed) drives
    // a fluid font-size in .gen-title so short names grow large and long names
    // shrink to fill the same width without overlapping. See styles.css.
    // The creator's symbol now renders as a credit icon in the info box, so
    // strip any copy baked into the name (e.g. "Cheerleader ∇") from the title.
    // Only the first credited creator can have baked their symbol into the name.
    var titleName = stripCreatorMark(d.name, splitCreators(d.creator)[0] || '') || d.name || 'Unnamed';
    var nch = Math.max(String(titleName).replace(/\s+/g, ' ').trim().length, 4);

    return '<div class="title-row"><h1 class="gen-title" style="--nch:' + nch + '">' + esc(titleName) + '</h1></div>' +
      '<div class="char-layout">' +
      '<section class="char-parchment card">' +
      (summaryCol || howCol ? '<div class="cols">' + (summaryCol ? '<div>' + summaryCol + '</div>' : '') + (howCol ? '<div>' + howCol + '</div>' : '') + '</div>' : '') +
      examplesBlock + tipsBlock + bluffingBlock + fightingBlock +
      (jinxMode === 'dropdown' ? jinxDrop : '') +
      '</section>' +
      '<div class="char-col2">' + infoCardFinal + sideBar + '</div>' +
      '</div>';
  }

  /* ── Fit the character title to its width ──
     Glyph widths vary too much between names for a CSS char-count formula to be
     safe (e.g. "MOON" is ~0.76/char, "ENLIGHTENED ONE" ~0.57), so measure the
     rendered text and scale the font down until the single line fits. Never
     wraps (white-space:nowrap in CSS); short names stay at the cap. */
  /* The measuring is done on a hidden copy, never on the title itself. The
     title is white-space:nowrap, so blowing it up to the cap size to measure
     made it wider than a phone screen: the document reflowed around the
     overflow and the browser dragged the reader hundreds of pixels back up the
     page — worst at the comment section, where a fast scroll and the URL bar
     retracting (which fires resize) land together. Measuring off-layout also
     makes the answer stable, because clientWidth was being read while the page
     was overflowing: the same title fitted to 50.9px one moment and 60.2px the
     next. The probe is position:fixed + hidden, so it never touches layout. */
  var fitProbe = null;
  function textWidthAt(el, px) {
    if (!fitProbe) {
      fitProbe = document.createElement('span');
      fitProbe.setAttribute('aria-hidden', 'true');
      fitProbe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;' +
        'white-space:nowrap;pointer-events:none;';
      document.body.appendChild(fitProbe);
    }
    var cs = window.getComputedStyle(el);
    fitProbe.style.fontFamily = cs.fontFamily;
    fitProbe.style.fontWeight = cs.fontWeight;
    fitProbe.style.fontStyle = cs.fontStyle;
    fitProbe.style.letterSpacing = cs.letterSpacing;
    fitProbe.style.textTransform = cs.textTransform;
    fitProbe.style.fontSize = px + 'px';
    fitProbe.textContent = el.textContent;
    return fitProbe.getBoundingClientRect().width;
  }

  function fitCharTitle() {
    if (typeof document === 'undefined' || !document.body) return;
    var els = document.querySelectorAll('.gen-title');
    var vw = window.innerWidth || 1000;
    fitCharTitle._w = vw;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      el.style.whiteSpace = 'nowrap';
      var maxPx = vw <= 420 ? 66 : vw <= 640 ? 78 : 144;   // "large & in charge", bounded on mobile
      var avail = el.clientWidth;                            // block fills its container
      var wide = textWidthAt(el, maxPx);
      var size = (avail && wide > avail)                     // single line overflows → shrink to fit
        ? Math.max(maxPx * (avail * 0.99) / wide, 14)
        : maxPx;
      // Write only when it actually changes: an unchanged font-size is a
      // reflow the page does not need.
      var next = size.toFixed(1) + 'px';
      if (el.style.fontSize !== next) el.style.fontSize = next;
      // The probe is a copy, so trust it but verify: now that the fitted size
      // is on the real title it can be measured directly and trimmed once.
      // This only ever shrinks, so it can never blow the page out sideways.
      if (avail && el.scrollWidth > avail) {
        var exact = Math.max(size * (avail * 0.99) / el.scrollWidth, 14).toFixed(1) + 'px';
        if (el.style.fontSize !== exact) el.style.fontSize = exact;
      }
    }
    // The web font (Dumbledor2) changes glyph widths; re-fit once it loads so an
    // early measurement against the fallback font doesn't leave the title wrong.
    if (document.fonts && document.fonts.status !== 'loaded' && !fitCharTitle._waiting) {
      fitCharTitle._waiting = true;
      document.fonts.ready.then(function () { fitCharTitle._waiting = false; fitCharTitle(); });
    }
  }

  /* ── one-time delegated handlers for JSON box toggle + copy ── */
  if (typeof document !== 'undefined' && !window.__jsonBoxBound) {
    window.__jsonBoxBound = true;
    document.addEventListener('click', function (e) {
      // Copy-link button
      var cl = e.target.closest && e.target.closest('.copy-link-btn');
      if (cl) {
        var url = location.href.split('#')[0];
        if (navigator.clipboard) {
          navigator.clipboard.writeText(url).then(function () {
            cl.innerHTML = '\u2713 Copied!';
            setTimeout(function () { cl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Copy link'; }, 1500);
          });
        }
        return;
      }
      // Alternate-art emblem: click to swap between the two versions
      var em = e.target.closest && e.target.closest('.emblem.has-alt');
      if (em) {
        var showingAlt = em.getAttribute('src') === em.getAttribute('data-alt');
        em.setAttribute('src', showingAlt ? em.getAttribute('data-main') : em.getAttribute('data-alt'));
        return;
      }
      var tg = e.target.closest && e.target.closest('.json-bar-toggle');
      if (tg) {
        var box = tg.closest('.json-box');
        var open = box.classList.toggle('open');
        tg.setAttribute('aria-expanded', open ? 'true' : 'false');
        box.querySelector('.json-body').hidden = !open;
        return;
      }
      var jd = e.target.closest && e.target.closest('.jinx-drop-bar');
      if (jd) {
        var jbox = jd.closest('.jinx-drop');
        var jopen = jbox.classList.toggle('open');
        jd.setAttribute('aria-expanded', jopen ? 'true' : 'false');
        jbox.querySelector('.jinx-drop-body').hidden = !jopen;
        return;
      }
      var cp = e.target.closest && e.target.closest('.json-copy');
      if (cp) {
        var b = cp.closest('.json-box');
        var txt = b.querySelector('code').textContent;
        if (navigator.clipboard) {
          navigator.clipboard.writeText(txt).then(function () {
            cp.textContent = 'Copied!'; setTimeout(function () { cp.textContent = 'Copy JSON'; }, 1500);
          }, function () {
            cp.textContent = 'Copy failed'; setTimeout(function () { cp.textContent = 'Copy JSON'; }, 1500);
          });
        }
      }
    });
    // Keyboard toggle for the collapsible jinx dropdown (Enter / Space).
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var jd = e.target.closest && e.target.closest('.jinx-drop-bar');
      if (!jd) return;
      e.preventDefault();
      var jbox = jd.closest('.jinx-drop');
      var jopen = jbox.classList.toggle('open');
      jd.setAttribute('aria-expanded', jopen ? 'true' : 'false');
      jbox.querySelector('.jinx-drop-body').hidden = !jopen;
    });
    // Re-fit the title on viewport resize / orientation change (debounced).
    // Width is the only thing the fit depends on, and on a phone every scroll
    // that hides or shows the URL bar fires resize with the width unchanged —
    // so ignore those outright rather than re-measure on every flick.
    var fitTimer;
    window.addEventListener('resize', function () {
      if (fitCharTitle._w === (window.innerWidth || 1000)) return;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(fitCharTitle, 120);
    });
  }

  if (typeof window !== 'undefined') {
    window.renderCharacter = renderCharacter;
    window.initCharacterRender = init;
    window.fitCharTitle = fitCharTitle;
    window.renderJsonBox = renderJsonBox;
    window.buildSchema = buildSchema;
    window.schemaJSON = schemaJSON;
    window.buildCreditsFabled = buildCreditsFabled;
    window.creditsByCreator = creditsByCreator;
    window.CREDITS_FABLED_ID = CREDITS_FABLED_ID;
    window.sanitizeSpecial = sanitizeSpecial;
    window.SPECIAL_TYPES = SPECIAL_TYPES;
    window.SPECIAL_TIMES = SPECIAL_TIMES;
    window.slugId = slugId;
    window.TEAM_LABEL = TEAM_LABEL;
    window.findScriptJinxes = findScriptJinxes;
    window.resolveJinxTarget = resolveJinxTarget;
    window.normJinxId = normJinxId;
    window.setOfficialIconUrls = setOfficialIconUrls;
    window.setOfficialNames = setOfficialNames;
    window.setWikiChars = setWikiChars;
    window.setCreators = setCreators;
    window.setCurataMark = setCurataMark;
    window.creatorSymbol = creatorSymbol;
    window.splitCreators = splitCreators;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      init: init,
      renderCharacter: renderCharacter, renderJsonBox: renderJsonBox,
      buildSchema: buildSchema, schemaJSON: schemaJSON,
      buildCreditsFabled: buildCreditsFabled, creditsByCreator: creditsByCreator,
      CREDITS_FABLED_ID: CREDITS_FABLED_ID,
      sanitizeSpecial: sanitizeSpecial,
      SPECIAL_TYPES: SPECIAL_TYPES, SPECIAL_TIMES: SPECIAL_TIMES,
      slugId: slugId, TEAM_LABEL: TEAM_LABEL,
      findScriptJinxes: findScriptJinxes,
      resolveJinxTarget: resolveJinxTarget, normJinxId: normJinxId,
      setOfficialIconUrls: setOfficialIconUrls, setWikiChars: setWikiChars,
      setOfficialNames: setOfficialNames,
      setCreators: setCreators, setCurataMark: setCurataMark,
      creatorSymbol: creatorSymbol, stripCreatorMark: stripCreatorMark,
      splitCreators: splitCreators
    };
  }
})();
