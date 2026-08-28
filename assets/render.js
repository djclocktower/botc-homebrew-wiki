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

  /* ── a character's icons ────────────────────────────────────────────
     The official script schema (ThePandemoniumInstitute/botc-release) gives
     `image` one to three entries and says what each position means:

       non-traveller   [regular, flipped]
       traveller       [unaligned, good, evil]

     so the wiki's three art slots ARE those positions. Slot one is the icon
     every surface already draws; slots two and three are a traveller's good
     and evil tokens, and the third is offered in the editors for travellers
     alone because nobody else has a third entry to fill.

       slot 1   art     / image      index 0
       slot 2   artAlt  / imageAlt   index 1
       slot 3   artAlt2 / imageAlt2  index 2

     Each slot has a relative path (an R2/repo file under /assets/) and an
     absolute URL, and either one can be the only one present: bulk imports
     write absolute URLs for art hosted elsewhere, and older rows carry the
     whole thing as an `image` array with no art* fields at all.

     artVersions() is the single answer to "what icons does this character
     have", asked by the emblem on the /c/ page, by buildSchema() and by the
     Token Tool. They used to each resolve it their own way, and disagreed in
     both directions: a row with artAlt and no imageAlt swapped on the page
     but exported one icon, and a row carrying image:[a,b] and no art* fields
     exported both while the page showed no second version at all. */
  var ART_ABS = 'https://botchomebrew.wiki/assets/';
  var ART_SLOTS = [
    { key: 'main', rel: 'art',     abs: 'image' },
    { key: 'alt',  rel: 'artAlt',  abs: 'imageAlt' },
    { key: 'alt2', rel: 'artAlt2', abs: 'imageAlt2' }
  ];
  var ART_LABELS_TRAVELLER = ['Unaligned', 'Good', 'Evil'];
  var ART_LABELS_OTHER = ['Main', 'Alternate', 'Alternate 2'];
  /* Both spellings. /api/character validates no team, the importers normalise
     'traveler' but nothing else does, and two other files already defend
     against it (jinx-graph.js, dashboard.html). */
  function isTraveller(team) { return /^travell?er$/i.test(String(team == null ? '' : team)); }

  function artVersions(d, root) {
    d = d || {};
    var arr = Array.isArray(d.image) ? d.image : [];
    var labels = isTraveller(d.team) ? ART_LABELS_TRAVELLER : ART_LABELS_OTHER;
    var prefix = (root == null ? R() : root);
    var out = [];
    for (var i = 0; i < ART_SLOTS.length; i++) {
      var slot = ART_SLOTS[i];
      var rel = typeof d[slot.rel] === 'string' ? d[slot.rel] : '';
      var abs = typeof d[slot.abs] === 'string' ? d[slot.abs] : '';
      // `image` is a plain string on slot one and the official array beyond it.
      if (!abs && typeof arr[i] === 'string') abs = arr[i];
      if (!rel && !abs) continue;
      out.push({
        key: slot.key,
        label: labels[i],
        rel: rel,
        // what an <img> on the page loads: the relative file where there is
        // one, so a page renders against its own root and R2 serves it.
        src: rel ? (prefix + 'assets/' + rel) : abs,
        // what leaves the wiki — the JSON the official app reads, and the
        // Token Tool fetching art across origins. Always absolute.
        url: abs || (rel ? ART_ABS + rel : '')
      });
    }
    /* The printable token — the Token Tool's finished token, saved to
       art/{identity}-token.png by the tool's "Save to page" (or uploaded in
       the editors' Printable token slot). An OPT-IN fourth version: only a
       page whose owner ticked `tokenArt` AND that actually has a saved image
       grows the pip, so nothing changes on the 1,600 pages that never asked.
       buildSchema() indexes versions by key (main/alt/alt2) and so never
       exports it — the official schema's `image` positions mean alignment,
       and a token is not an icon. */
    if (d.tokenArt) {
      var trel = typeof d.token === 'string' ? d.token : '';
      var tabs = typeof d.tokenImage === 'string' ? d.tokenImage : '';
      if (trel || tabs) {
        out.push({
          key: 'token',
          label: 'Printable token',
          rel: trel,
          src: trel ? (prefix + 'assets/' + trel) : tabs,
          url: tabs || (trel ? ART_ABS + trel : '')
        });
      }
    }
    return out;
  }
  /* Show one version of the icon. Browser only — the group lives beside the
     <img> inside .char-infocard, so the emblem is found from the group. */
  function emblemShow(group, btn) {
    if (!group || !btn) return;
    var img = group.parentNode && group.parentNode.querySelector('.emblem');
    if (img) img.setAttribute('src', btn.getAttribute('data-src') || img.getAttribute('src'));
    var btns = group.querySelectorAll('.emblem-ver');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i] === btn;
      btns[i].classList.toggle('is-on', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  function artVersion(d, key) {
    var v = artVersions(d, '');
    for (var i = 0; i < v.length; i++) if (v[i].key === key) return v[i];
    return null;
  }
  /* How far up the site root is from the page being rendered — '' at the top,
     '../' one level down, '../../' for a nested character address. Every link
     this file builds is relative, so an inline [[Character Name]] needs the
     same prefix the rest of the page uses.

     In the browser that is window.LINK_ROOT, but the Worker has no window:
     server-side the prefix arrives as renderCharacter's third argument, and
     without carrying it here every [[Name]] on a /c/ page rendered as a bare
     `c/{address}` — which the browser then resolved against the page's own
     directory, so a link from /c/set/archivist to the Penitent came out as
     /c/set/c/set/penitent. Set for the duration of one render and restored
     after, so nothing leaks between pages in a reused isolate. */
  var curRoot = null;
  /* The character whose page is being rendered, for the one job that needs to
     know: telling two homebrew pages of the same name apart in a jinx (see
     jinxLookupKeys). Set and restored by renderCharacter with curRoot. */
  var curHost = null;
  function R() {
    if (curRoot != null) return curRoot;
    return (typeof window !== 'undefined' && window.LINK_ROOT) || '';
  }
  /* Curata mark markup, from classify.js — injected by the Worker
     (setCurataMark) or read off the global in the browser, so render.js never
     has to import classify.js itself. Partial is deliberately NOT shown on
     the page: an unfinished page is its owner's business, and the Worker
     tells them in a banner instead (renderCharacterPage in worker.js). */
  var curataMarkFn = null;
  function setCurataMark(fn) { curataMarkFn = fn; }

  /* The wiki markup engine (assets/render-wiki.js). The Worker hands it over
     with init(); in the browser it is picked up off the global if the page
     loaded it. Resolved per call, so load order does not matter. Without it
     the text still renders — escaped and unformatted, never raw.

     Two doors into it, because a character page has two kinds of text:

     inlineText()  the whole inline mark set, for the short credit-ish lines
                   somebody writes ABOUT the character rather than as part of
                   it: the pronunciation line, a jinx rule, and the info
                   box's `translatedBy` / `iconBy` rows.

     inlineLinks() the small set — links, [[Character Name]] and the colour
                   marks {{red|…}} / {{blue|…}} — for the almanac prose
                   itself: the ability, the lede, the summary, How to Run,
                   the examples, the tips and the sidebar boxes. A writer who
                   types a link there gets a link; what they do NOT get is
                   *italics*, because the official "Each night*" convention
                   puts a lone asterisk through half the text on this wiki
                   and two of them in one paragraph would italicise
                   everything in between. Without the engine it falls back to
                   tok(), which is what these fields rendered with before. */
  var wiki = null;
  function init(w) { wiki = w || null; }
  function engine() {
    return wiki || (typeof window !== 'undefined' ? window.WikiRender : null);
  }
  function inlineText(str) {
    var W = engine();
    return (W && W.inlineFormat) ? W.inlineFormat(str, { linkRoot: R() }) : esc(str);
  }
  function inlineLinks(str) {
    var W = engine();
    return (W && W.inlineFormat)
      ? W.inlineFormat(str, { linkRoot: R(), marks: 'links' })
      : tok(str);
  }
  /* The marks taken back out, for the two places this text leaves the page as
     plain prose: the official-schema JSON box (the app renders no markup) and
     the meta description the Worker puts in the page head. */
  function plainText(str) {
    var W = engine();
    return (W && W.plainText) ? W.plainText(str) : String(str == null ? '' : str);
  }
  function curataMark(d, opts) {
    if (!d || !(d.curata || d.classification === 'curata')) return '';
    var fn = curataMarkFn ||
      (typeof window !== 'undefined' ? window.classBadgeHTML : null);
    return fn ? fn('curata', { from: d.curataFrom, sep: !!(opts && opts.sep) }) : '';
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
  /* ── the page's edit status ──
     Who may edit this page, said at the top of its EDITING page and nowhere
     else. It used to be a row in the reader's info box, which is the wrong
     audience twice over: a reader is not deciding anything, and the person who
     IS — the owner opening the page up, the guest wondering whether they are
     welcome — is already looking at the editor when the question comes up.
     One table, used by the three editors of an existing page (edit.html,
     publish-script.html, publish-collection.html) through editStatusHTML(),
     so a character, a script and a collection cannot word it differently.
     create.html is not one of them: a page being made is nobody else's yet.
     The wording addresses the OWNER, who is the only one shown this bar — a
     guest editing an opened page gets the editor's own banner instead.
     '' is a page nobody has opened, which the owner still wants to see stated:
     the bar is the page's status, not only a notice when it is unusual. */
  var EDIT_STATUS = {
    '':        ['yours alone', 'only you and the wiki admins can edit this page.'],
    all:       ['open to all', 'anyone with an account can edit this page.'],
    tags:      ['tags open to all', 'anyone with an account can change the tags.'],
    suggest:   ['suggestions welcome', 'anyone with an account can propose an edit for you to approve.'],
    /* Approved editing names accounts rather than opening the page. It is not
       an invitation the way the other three are, and WHO the editors are is
       the creator's own list — the Worker keeps it out of the public feeds for
       that reason, so nothing but the owner's own form ever names them. */
    approved:  ['shared', 'only the accounts you have named can edit this page.']
  };
  /* mode: the stored `publicEdit` ('' for a closed page).
     opts.links: [{href, label}] appended after the sentence — the history
     page, a suggestions queue, whatever the editor has to offer. */
  function editStatusHTML(mode, opts) {
    opts = opts || {};
    var key = Object.prototype.hasOwnProperty.call(EDIT_STATUS, mode) ? mode : '';
    var t = EDIT_STATUS[key];
    var links = (opts.links || []).filter(Boolean).map(function (l) {
      return '<a class="hist-page-link" href="' + esc(l.href) + '">' + esc(l.label) + '</a>';
    }).join(' ');
    return '<p class="edit-status-bar' + (key ? '' : ' is-closed') + '">' +
      '<span class="es-label">Who can edit:</span> ' +
      '<span class="oe-chip">' + esc(t[0]) + '</span> ' +
      esc(t[1]) + (links ? ' ' + links : '') + '</p>';
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
  /* Forwarded into the text engine as well, so [[Imp]] in any prose this page
     renders resolves to the official wiki. One call feeds both: every caller
     that already had a roster to hand (the Worker's /c/ route, and both
     character editors) is covered without a second line, and the two can
     never end up disagreeing about who is official. A page that loaded no
     text engine just skips it. */
  function setOfficialNames(map) {
    OFFICIAL_NAMES = map || null;
    var W = engine();
    if (W && W.setOfficialNames) W.setOfficialNames(map);
  }
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

  function resolveJinxTarget(j, root, host) {
    root = root || '';
    // The page this jinx is being rendered for. Passed in by a caller that
    // has it; on a /c/ page it is the character being rendered, which
    // renderCharacter() sets for the duration of the render so the jinx box
    // needs no argument. Only ever used to break a name tie (jinxLookupKeys).
    if (host === undefined) host = curHost;
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

    // 3. One of ours: the id as written, then the name qualified by the host
    //    page's own sets, then the bare name (see jinxLookupKeys).
    var hit = null, keys = jinxLookupKeys(j, host);
    for (var ki = 0; ki < keys.length && !hit; ki++) hit = wikiChar(keys[ki]);
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

  /* ── Related pages (the ribbon cards in the almanac) ─────────────────
     `data.related` is the owner's hand-picked list of pages this character
     is about: another character its ability names, the wiki page for a
     condition it inflicts, the Bloodstar original. One entry is
     {type, slug|id|url, name, note, team, image} — see sanitizeRelated()
     in worker.js for the caps. The block renders after the Summary bullets
     and before How to Run, and only when entries exist: an owner enables
     the feature by adding the first entry, so it can never appear empty.

     The ribbon on each card says what kind of thing it links to without a
     word of label text: team colour for a character (blue good, red evil,
     half-and-half traveller, gold Fabled, green Loric), beige for a page on
     this wiki (wiki page, script, collection), white for an external link.
     A character entry resolves through the same registries as the jinx box,
     so its icon, address and team stay live; the stored name and team are
     only the fallback for a target the registry cannot see (a draft, or a
     registry that never loaded). An official character's team IS stored,
     because the official roster registries carry no team and the roster
     never changes. */
  var REL_RIBBONS = { townsfolk: 'good', outsider: 'good', minion: 'evil',
                      demon: 'evil', traveller: 'traveller', traveler: 'traveller',
                      fabled: 'fabled', loric: 'loric' };
  function resolveRelatedTarget(r, root) {
    root = root || '';
    var nm = String(r.name || '').trim();
    var type = String(r.type || '');
    if (type === 'char') {
      var hit = wikiChar(normJinxId(r.slug || ''));
      if (hit) {
        return { name: hit.name || nm, href: charHref(hit, root),
                 iconSrc: wikiCharIcon(hit, root), external: false,
                 ribbon: REL_RIBBONS[hit.team] || 'page' };
      }
      // A draft, or a registry that never loaded: the identity still
      // reaches the page (/c/{identity} 301s to the address).
      return { name: nm || r.slug, href: root + 'c/' + (r.slug || ''),
               iconSrc: '', external: false,
               ribbon: REL_RIBBONS[r.team] || 'page' };
    }
    if (type === 'official') {
      var key = r.id || nm;
      var offNm = officialName(slugId(key)) || nm || String(r.id || '');
      return { name: offNm, href: jinxURL(offNm),
               iconSrc: officialIconUrl(slugId(key)), external: true,
               ribbon: REL_RIBBONS[r.team] || 'page' };
    }
    if (type === 'page')       return { name: nm, href: root + 'p/' + (r.slug || ''), iconSrc: '', external: false, ribbon: 'page' };
    if (type === 'script')     return { name: nm, href: root + 's/' + (r.slug || ''), iconSrc: '', external: false, ribbon: 'page' };
    if (type === 'collection') return { name: nm, href: root + 'collection/' + (r.slug || ''), iconSrc: '', external: false, ribbon: 'page' };
    if (type === 'url' && /^https?:\/\//i.test(String(r.url || ''))) {
      return { name: nm || r.url, href: String(r.url), iconSrc: '', external: true, ribbon: 'ext' };
    }
    return null;
  }

  function relatedHTML(d, root) {
    var items = Array.isArray(d.related) ? d.related : [];
    var cards = items.map(function (r) {
      if (!r) return '';
      var t = resolveRelatedTarget(r, root);
      if (!t || !t.name) return '';
      var icon = t.iconSrc ?
        '<img loading="lazy" decoding="async" class="rel-ico" src="' + esc(t.iconSrc) + '" alt=""' +
        ' onerror="this.style.display=\'none\';this.closest(\'.rel-card\').classList.add(\'noicon\')">' : '';
      // The embed: an optional preview image on a custom link, https-only
      // (enforced again by sanitizeRelated — this test is the render-side
      // seatbelt for rows written before the field existed).
      var thumb = (r.type === 'url' && /^https:\/\//i.test(String(r.image || ''))) ?
        '<img loading="lazy" decoding="async" class="rel-thumb" src="' + esc(r.image) + '" alt=""' +
        ' onerror="this.style.display=\'none\'">' : '';
      var noteTxt = String(r.note || '').trim();
      return '<div class="rel-card rel-' + t.ribbon + (icon ? '' : ' noicon') + '">' + icon +
        '<div class="rel-bd">' +
        '<a class="rel-name" href="' + esc(t.href) + '"' +
        (t.external ? ' target="_blank" rel="noopener noreferrer"' : '') +
        '>' + esc(t.name) + (t.external ? ' <span class="rel-ext-mark">↗</span>' : '') + '</a>' +
        (noteTxt ? '<span class="rel-note">' + inlineText(noteTxt) + '</span>' : '') +
        thumb + '</div></div>';
    }).join('');
    if (!cards) return '';
    return '<div class="related" id="sec-related">' +
      '<div class="gen-sech-wrap"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-related">Related</a></h2></div>' +
      '<div class="rel-list">' + cards + '</div></div>';
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
  /* The official schema is read by the app and by every script tool, neither
     of which renders markup — so the two fields that leave here and DO take
     the wiki's marks (the flavour quote, and a jinx's rule text) have them
     taken back out. `ability` is escaped on the page as well, so it goes out
     exactly as it was typed. A page nobody has typed a mark into is
     byte-for-byte what it always was. */
  function buildSchema(d) {
    var o = {
      id: d.jsonId || slugId(d.name),
      name: d.name || '',
      team: d.team || 'townsfolk',
      ability: d.ability || ''
    };
    /* image as an array (required by the official script tool), in the
       positions the schema defines — see artVersions above. For a traveller
       that is [unaligned, good, evil]; for everyone else [regular, flipped].

       The one rearrangement: a traveller carrying evil art but no good art
       would otherwise export [unaligned, evil], and the app reads position
       one as GOOD — so its evil token would render as its good one and it
       would have no evil token at all. Repeat the unaligned icon into the
       good slot instead, which is what every official traveller does anyway
       (all 18 ship a single _g image used for every state). That repeat is
       deliberate, so this is the one path that must not be de-duplicated. */
    var vers = artVersions(d, '');
    var byKey = {};
    for (var vi = 0; vi < vers.length; vi++) byKey[vers[vi].key] = vers[vi];
    var seq, repeated = false;
    if (isTraveller(d.team) && byKey.alt2 && !byKey.alt) {
      seq = [byKey.main, byKey.main, byKey.alt2];
      repeated = true;
    } else {
      seq = [byKey.main, byKey.alt, byKey.alt2];
    }
    var imgs = [];
    for (var si = 0; si < seq.length; si++) {
      var u = seq[si] && seq[si].url;
      if (!u) continue;
      if (!repeated && imgs.indexOf(u) !== -1) continue;
      imgs.push(u);
    }
    if (imgs.length) o.image = imgs;
    if (d.edition) o.edition = d.edition;
    var fl = d.flavor || d.quote;
    if (fl) o.flavor = plainText(String(fl).replace(/^["']|["']$/g, ''));
    o.firstNight = Number(d.firstNight) || 0;
    if (d.firstNightReminder) o.firstNightReminder = d.firstNightReminder;
    o.otherNight = Number(d.otherNight) || 0;
    if (d.otherNightReminder) o.otherNightReminder = d.otherNightReminder;
    if (d.reminders && d.reminders.length) o.reminders = d.reminders;
    if (d.remindersGlobal && d.remindersGlobal.length) o.remindersGlobal = d.remindersGlobal;
    if (d.setup) o.setup = true;
    if (d.jinxes && d.jinxes.length) {
      var jx = d.jinxes.map(function (j) {
        return { id: j.id || slugId(j.name), reason: plainText(j.text || j.reason || '') };
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

  /* The SET-QUALIFIED keys a character also answers to, on top of its
     identity and its name.

     A bulk import writes its jinx targets as `{name}_{set}` —
     `changeling_the_bootleggers_anthology`, `cadenza_the_academy`,
     `mystic_the_academy` — and that qualifier is the only thing telling two
     homebrew characters of the same name apart. This wiki has a Changeling in
     The Potato Patch and another in The Bootlegger's Anthology; matching the
     bare name landed whichever was registered first, so the Huli Jing's jinx
     with its OWN set's Changeling pointed at a stranger's page, art and all.

     So a character registers `name + set` for every set it is filed under —
     the set segment of its address (`c/{set}/{character}`), the `appearsIn`
     it was given, and any collection that claims it (`appearsInFrom`) — plus
     the `jsonId` an import stamped on it. All of them fold through
     normJinxId(), so punctuation and apostrophes in a set name do not have to
     match ("The Bootlegger's Anthology" and `the-bootleggers-anthology` are
     one key).

     These are strictly EXTRA keys: the bare name still resolves as it did,
     which is what every jinx typed by hand relies on. */
  function jinxQualKeys(c) {
    if (!c) return [];
    var out = [], seen = {};
    function push(k) { if (k && !seen[k]) { seen[k] = 1; out.push(k); } }

    var nm = normJinxId(c.name);
    // `changeling_the_potato_patch_part_2` and friends: the id an import gave
    // the page, which is what its own project's jinxes name it by. Only when
    // it says more than the name and the identity already do — a bulk import
    // that stamped a bare `corsair` adds nothing here, and a bare id is
    // exactly the kind that belongs to an official character.
    var jid = normJinxId(c.jsonId);
    if (jid && jid !== nm && jid !== normJinxId(c.slug)) push(jid);

    if (!nm) return out;
    charSetKeys(c).forEach(function (k) { push(nm + k); });
    return out;
  }

  /* Every set a character is filed under, normalized: the set segment of its
     address (`c/{set}/{character}`), the `appearsIn` it was given, and any
     collection claiming it (`appearsInFrom`). Punctuation and apostrophes
     fold away, so "The Bootlegger's Anthology" and `the-bootleggers-anthology`
     are one key. */
  function charSetKeys(c) {
    if (!c) return [];
    var sets = [];
    // The address is `c/{set}/{character}`; a flat one has no set to read.
    var seg = String(c.page || '').replace(/^\//, '').split('/');
    if (seg.length >= 3 && seg[0] === 'c') sets.push(seg[1]);
    var ap = c.appearsIn;
    if (Array.isArray(ap)) sets = sets.concat(ap);
    else if (ap) sets.push(ap);
    if (Array.isArray(c.appearsInFrom)) {
      c.appearsInFrom.forEach(function (a) {
        if (!a) return;
        if (a.name) sets.push(a.name);
        if (a.id) sets.push(a.id);
      });
    }
    var out = [], seen = {};
    sets.forEach(function (sname) {
      var k = normJinxId(sname);
      if (k && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out;
  }

  /* The keys a jinx entry names its target by, MOST SPECIFIC FIRST, to be
     tried against a map of this wiki's characters (WIKI_CHARS, the Worker's
     jinx index, a script's own roster — they are all keyed the same way).

       1. the id as written, which for an import carries the set
          (`changeling_the_bootleggers_anthology`)
       2. the name qualified by each set the HOST page — the character whose
          jinx this is — is filed under
       3. the bare name

     Step 2 is what settles the rest of the name clashes. An import's
     qualifier is the project's own name and does not always survive as the
     set name here (`mycologist_hblreleased` for a page filed under Homebrews
     by Luis), and plenty of older rows carry nothing but a name. A jinx names
     a character on the same script or in the same collection far more often
     than not, so the host's own sets are the best guess there is — and it is
     only ever a tie-break: a name only one page on the wiki answers to
     resolves at step 3 exactly as it always did. */
  function jinxLookupKeys(j, host) {
    if (!j) return [];
    var out = [], seen = {};
    function push(k) { if (k && !seen[k]) { seen[k] = 1; out.push(k); } }
    var nm = jinxDisplayName(j);
    var nameKey = normJinxId(nm);
    // The id goes first only when it says MORE than the name does. A bare
    // `warden` is the name written twice, and putting it first would answer
    // the question before the host's own set was ever asked — which is the
    // whole tie-break, and exactly the case with four Wardens to choose from.
    var idKey = normJinxId(j.id || slugId(nm));
    if (idKey !== nameKey) push(idKey);
    if (nameKey) {
      charSetKeys(host).forEach(function (k) { push(nameKey + k); });
      push(nameKey);
    } else {
      push(idKey);
    }
    return out;
  }
  /* This wiki's characters, keyed the way every jinx lookup expects them:
     identities and names first, then the set-qualified keys, each claimed only
     if it is still free. That two-pass order is the rule (see jinxQualKeys),
     and it lived in three hand-rolled copies — the Worker's jinx index, and
     both character editors — before this. `row(c)` lets a caller store
     something smaller than the character it was handed; it is called once per
     character. `byName` keeps EVERY page of a given name, which is what tells
     a tool that a name is ambiguous rather than just resolving it. */
  function jinxCharIndex(chars, row) {
    var byKey = {}, byName = {}, items = [];
    (chars || []).forEach(function (c) {
      if (!c || !c.slug) return;
      var v = row ? row(c) : c;
      if (!v) return;
      items.push({ c: c, v: v });
      var nk = normJinxId(c.name);
      [normJinxId(c.slug), nk].forEach(function (k) { if (k && !byKey[k]) byKey[k] = v; });
      if (nk) (byName[nk] = byName[nk] || []).push(v);
    });
    items.forEach(function (it) {
      jinxQualKeys(it.c).forEach(function (k) { if (!byKey[k]) byKey[k] = it.v; });
    });
    return { byKey: byKey, byName: byName };
  }

  /* Where a jinx entry will land — for the tools that WRITE one rather than
     draw it, which is both importers. Drawing a jinx can afford to just pick
     the best candidate; an import is the moment somebody can still fix it, and
     a jinx stored by a name three pages share is a coin toss nobody is told
     about. So this answers with its working:

       picked      the page it will resolve to, or null for none here
       candidates  EVERY page of that name, so a caller can say who else it
                   could have been
       guessed     true when the pick was made on the bare name while more
                   than one page answers to it — i.e. it came down to
                   whichever was registered first

     `guessed` is deliberately false when the id or the host's own set settled
     it (see jinxLookupKeys): those are evidence, not a coin toss. */
  function jinxTargetCheck(j, host, index) {
    var out = { name: '', picked: null, candidates: [], guessed: false, official: false };
    if (!j || !index) return out;
    out.name = jinxDisplayName(j);
    // The picker writes the target outright; there is nothing to guess.
    if (j.slug) { out.picked = index.byKey[normJinxId(j.slug)] || null; return out; }
    // An official character beats every page here (resolveJinxTarget step 2),
    // so a jinx with one is settled however many pages share the name. This
    // needs setOfficialNames() to have been called — without it every jinx
    // with an official character looks homebrew, which is a warning on almost
    // every import.
    out.official = !!(officialName(j.id || '') || officialName(out.name));
    if (out.official) return out;
    var keys = jinxLookupKeys(j, host), hit = '';
    for (var i = 0; i < keys.length && !out.picked; i++) {
      if (index.byKey[keys[i]]) { out.picked = index.byKey[keys[i]]; hit = keys[i]; }
    }
    var nameKey = normJinxId(out.name);
    out.candidates = (nameKey && index.byName[nameKey]) || [];
    out.guessed = out.candidates.length > 1 && hit === nameKey;
    return out;
  }

  function findScriptJinxes(chars) {
    var byId = {};
    chars.forEach(function (c) {
      [slugId(c.name), normJinxId(c.jsonId), (c.slug || '').replace(/-/g, '')]
        .forEach(function (id) { if (id) byId[id] = c; });
    });
    // Set-qualified keys second, and only where nothing claims them, so a
    // `{name}_{set}` jinx id finds the character from THAT set (see
    // jinxQualKeys) without ever displacing a plain name or identity.
    chars.forEach(function (c) {
      jinxQualKeys(c).forEach(function (id) { if (!byId[id]) byId[id] = c; });
    });
    var out = [], seen = {};
    chars.forEach(function (c) {
      (c.jinxes || []).forEach(function (j) {
        // An entry written by the jinx picker names its target outright; the
        // older ones have to be matched by id or by name.
        var target = j.slug && byId[normJinxId(j.slug)];
        if (!target) {
          var ks = jinxLookupKeys(j, c);
          for (var ki = 0; ki < ks.length && !target; ki++) target = byId[ks[ki]];
        }
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
    // The inline text helpers build links too (see R() above), and in the
    // Worker this argument is the only place the prefix exists.
    var prevRoot = curRoot, prevHost = curHost;
    curRoot = root;
    // The page being rendered, so its jinx box can break a name tie in favour
    // of its own script or collection (see jinxLookupKeys). Scoped and
    // restored exactly like curRoot, so nothing leaks between renders.
    curHost = d || null;
    setReminderTokens(d);
    try { return characterBody(d, artSrc, root); }
    finally { curRoot = prevRoot; curHost = prevHost; setReminderTokens(null); }
  }

  /* This character's own reminder tokens, handed to the text engine for the
     duration of the render. "Place the [[Drunk]] reminder token on them" was
     rendering a link to the official Drunk, because [[Name]] resolves an
     official character before anything else and Drunk is one — while the
     writer plainly meant the token, which this character's own `reminders`
     list names. So a name the character carries a token for wins, and only on
     that character's page. Cleared after the render, so the next page starts
     from nothing. */
  function setReminderTokens(d) {
    var W = engine();
    if (!W || !W.setReminderTokens) return;
    if (!d) return W.setReminderTokens(null);
    var list = [].concat(
      Array.isArray(d.reminders) ? d.reminders : [],
      Array.isArray(d.remindersGlobal) ? d.remindersGlobal : []
    );
    W.setReminderTokens(list);
  }

  function characterBody(d, artSrc, root) {
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
      /* The ability is the one prose field left deliberately escaped. It is
         not writing ABOUT the character, it is the character's rule: it is
         exported verbatim into official-schema JSON that the app and every
         script tool read, printed on physical tokens, linted by Grimforge and
         shown flat on eight card surfaces. A mark typed here would render on
         this page and nowhere else, which is worse than not offering it. */
      (d.ability ? '<p class="ability">' + esc(d.ability) + '</p>' : '') +
      (d.lede ? '<p class="lede">' + inlineLinks(d.lede) + '</p>' : '') +
      (bullets.length ? '<ul>' + bullets.map(function (b) { return '<li>' + inlineLinks(b) + '</li>'; }).join('') + '</ul>' : '') +
      // The Related ribbons close the summary column: after the bullets,
      // before How to Run — which is exactly that order on a phone, where
      // the two columns stack.
      relatedHTML(d, root);

    var howColBody = paras.map(function (p) { return '<p>' + inlineLinks(p) + '</p>'; }).join('') +
      (d.callout && d.callout.trim() ? '<div class="callout">' + inlineLinks(d.callout) + '</div>' : '');
    var howCol = howColBody ?
      '<div class="gen-sech-wrap" id="sec-howtorun"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-howtorun">How to Run</a></h2></div>' + howColBody : '';

    var examplesBlock = examples.length ?
      ('<div class="examples"><div class="gen-sech-wrap" id="sec-examples"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-examples">Examples</a></h2></div>' +
        examples.map(function (e) { return '<div class="ex">' + inlineLinks(e) + '</div>'; }).join('') +
        '</div>') : '';

    var tipsBlock = tips.length ?
      ('<div class="tips"><div class="gen-sech-wrap" id="sec-tips"><h2 class="gen-sech"><a class="sec-anchor" href="#sec-tips">Tips &amp; Tricks</a></h2></div>' +
        '<ul>' + tips.map(function (t) { return '<li>' + inlineLinks(t) + '</li>'; }).join('') + '</ul></div>') : '';

    var charName = esc(d.name || 'Character');
    var bluffingBlock = bluffing.length ?
      ('<div class="tips"><div class="gen-sech-wrap"><h2 class="gen-sech">Bluffing as the ' + charName + '</h2></div>' +
        '<ul>' + bluffing.map(function (t) { return '<li>' + inlineLinks(t) + '</li>'; }).join('') + '</ul></div>') : '';
    var fightingBlock = fighting.length ?
      ('<div class="tips"><div class="gen-sech-wrap"><h2 class="gen-sech">Fighting the ' + charName + '</h2></div>' +
        '<ul>' + fighting.map(function (t) { return '<li>' + inlineLinks(t) + '</li>'; }).join('') + '</ul></div>') : '';

    // Tags row. The Curata wreath hangs off the end of it behind a hairline
    // rule: it is a mark, not a tag, so it is never a link and never joins the
    // comma-separated list — nobody should be able to click it expecting a
    // "Curata" tag page. When a page is Curata but has no tags (it can
    // inherit the wreath from its collection), an em dash holds the tags side so
    // the hairline still separates two things. The rule is drawn ON the mark
    // (`sep`), so a Tags row that wraps carries the two down together.
    var tagLinks = (d.tags && d.tags.trim()) ? d.tags.split(',').map(function (t) {
      t = t.trim(); if (!t) return '';
      var display = t.toLowerCase().replace(/(^|[\s-])[a-z]/g, function (m) { return m.toUpperCase(); });
      return '<a class="tag-link" data-tag="' + esc(display) + '" href="' + root + 'tag?t=' + encodeURIComponent(display) + '">' + esc(display) + '</a>';
    }).filter(Boolean).join('<span class="tag-sep">, </span>') : '';
    var mark = curataMark(d, { sep: true });
    var tagsRow = (tagLinks || mark)
      ? '<dt>Tags:</dt><dd>' + (tagLinks || '<span class="tag-none">&mdash;</span>') +
        mark + '</dd>'
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
      /* The two credit rows take formatting — in practice a link, because
         what people write in them is somebody's name and where to find them.
         Escaped, a typed [DarkArtist](https://…/u/darkartist) printed its own
         brackets and parentheses in the middle of the info box. inlineText()
         is the wiki engine (render-wiki.js), which escapes first and
         whitelists the href, so nothing typed here can become raw HTML; with
         the engine absent it falls back to the plain escaped text. */
      (d.translatedBy && d.translatedBy.trim() ? '<dt>Translated by:</dt><dd class="info-credit">' + inlineText(d.translatedBy.trim()) + '</dd>' : '') +
      (d.iconBy && d.iconBy.trim() ? '<dt>Icon by:</dt><dd class="info-credit">' + inlineText(d.iconBy.trim()) + '</dd>' : '') +
      '</dl>';

    // Copy-link button lives in the top-right corner *inside* the info card so
    // it never crowds the title (see .card-actions in styles.css).
    var copyBtn = '<button type="button" class="copy-link-btn" title="Copy link to this character" aria-label="Copy link"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> Copy link</button>';

    var quoteClean = (d.quote || d.flavor || '').replace(/^["']|["']$/g, '');
    /* The icon, and the other versions of it. A traveller has a good and an
       evil token, so the picture is no longer a mystery click: a faint row of
       pips underneath says how many there are and which one is showing.
       Clicking the emblem walks through them, because that is what the page
       has always done, and a pip jumps straight to one.

       The version NAMES are deliberately not printed. This is a reading page
       and the pips sit right above the flavour quote, where three labelled
       buttons read as app chrome; the name rides on each pip's title and
       accessible name instead, and the icon itself is the real answer to
       "which one is this". */
    var artVers = artVersions(d, root);
    // The caller resolved slot one itself (the Worker builds it from the row
    // and its own address depth), so let it win where it has an answer.
    if (artVers.length && artSrc) artVers[0].src = artSrc;
    else if (!artVers.length && artSrc) artVers = [{ key: 'main', label: 'Main', rel: '', src: artSrc, url: '' }];
    var emblem = '';
    if (artVers.length) {
      var multi = artVers.length > 1;
      emblem = '<img class="emblem' + (multi ? ' has-alt' : '') + '" src="' + esc(artVers[0].src) +
        '" alt="' + esc(d.name) + '"' +
        (multi ? ' title="Click to see the other versions of this icon"' : '') + '>';
      if (multi) {
        emblem += '<div class="emblem-versions" role="group" aria-label="Versions of this icon">' +
          artVers.map(function (v, i) {
            // Empty on purpose — the pip is drawn by CSS. The label is the
            // button's accessible name, so a screen reader and a hover both
            // still get "Evil".
            return '<button type="button" class="emblem-ver' + (i === 0 ? ' is-on' : '') +
              '" data-src="' + esc(v.src) + '" title="' + esc(v.label) +
              '" aria-label="' + esc(v.label) +
              '" aria-pressed="' + (i === 0 ? 'true' : 'false') + '"></button>';
          }).join('') + '</div>';
      }
    }
    var infoCard = '<div class="card char-infocard">' +
      '<div class="card-actions">' + copyBtn + '</div>' +
      emblem +
      (quoteClean.trim() ? '<p class="quote">"' + inlineLinks(quoteClean) + '"</p>' : '') +
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
        return p.trim() ? '<p>' + inlineLinks(p).replace(/\n/g, '<br>') + '</p>' : '';
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
      /* The icon's other versions — a traveller's good and evil tokens.
         A pip jumps straight to one; the emblem itself walks through them in
         order, which is the gesture the page has always had. Both go through
         emblemShow so the picture and the pips cannot end up disagreeing
         about which version is on screen. */
      var vb = e.target.closest && e.target.closest('.emblem-ver');
      if (vb) { emblemShow(vb.parentNode, vb); return; }
      var em = e.target.closest && e.target.closest('.emblem.has-alt');
      if (em) {
        var bars = em.parentNode && em.parentNode.querySelector('.emblem-versions');
        if (bars) {
          var btns = bars.querySelectorAll('.emblem-ver');
          var at = 0;
          for (var bi = 0; bi < btns.length; bi++) if (btns[bi].classList.contains('is-on')) at = bi;
          emblemShow(bars, btns[(at + 1) % btns.length]);
        }
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
    window.artVersions = artVersions;
    window.artVersion = artVersion;
    window.isTraveller = isTraveller;
    window.ART_ABS = ART_ABS;
    window.findScriptJinxes = findScriptJinxes;
    window.resolveJinxTarget = resolveJinxTarget;
    window.normJinxId = normJinxId;
    window.jinxQualKeys = jinxQualKeys;
    window.jinxLookupKeys = jinxLookupKeys;
    window.jinxCharIndex = jinxCharIndex;
    window.jinxTargetCheck = jinxTargetCheck;
    window.setOfficialIconUrls = setOfficialIconUrls;
    window.setOfficialNames = setOfficialNames;
    window.setWikiChars = setWikiChars;
    window.setCreators = setCreators;
    window.setCurataMark = setCurataMark;
    window.creatorSymbol = creatorSymbol;
    window.splitCreators = splitCreators;
    window.editStatusHTML = editStatusHTML;
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
      artVersions: artVersions, artVersion: artVersion,
      isTraveller: isTraveller, ART_ABS: ART_ABS,
      findScriptJinxes: findScriptJinxes,
      resolveJinxTarget: resolveJinxTarget, normJinxId: normJinxId,
      jinxQualKeys: jinxQualKeys, jinxLookupKeys: jinxLookupKeys,
      jinxCharIndex: jinxCharIndex, jinxTargetCheck: jinxTargetCheck,
      charSetKeys: charSetKeys,
      setOfficialIconUrls: setOfficialIconUrls, setWikiChars: setWikiChars,
      setOfficialNames: setOfficialNames,
      setCreators: setCreators, setCurataMark: setCurataMark,
      creatorSymbol: creatorSymbol, stripCreatorMark: stripCreatorMark,
      splitCreators: splitCreators,
      editStatusHTML: editStatusHTML, EDIT_STATUS: EDIT_STATUS
    };
  }
})();
