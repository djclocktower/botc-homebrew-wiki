/* assets/importer.js — the rules behind /mass-upload, the one importer.

   Both sources are read by the Worker into ONE shape (buildBundle in
   worker/bloodstar.js): a Bloodstar link through GET /api/bloodstar, a script
   JSON (file or paste) through POST /api/bloodstar. So there is one list of
   characters, one official-character test, and one set of rules for what each
   becomes — this file. The page (mass-upload.html) owns the form and the
   network; nothing here touches either, so the tests run it in a vm.

   The rules, in short:
   - An exact official character (name AND ability) never becomes a page: it
     stays on the roster as off-{id}. Same as /api/character's guard.
   - A character whose name matches one of YOUR pages updates that page
     (merge(): mechanics from the source, everything else the page's), unless
     the person switches the row to "New page". Shown in the table before
     anything is written, never decided silently.
   - Everything else is a new page.
   - A jinx is written onto whichever end gets a page here; two official
     ends become the script's own rule (jinxEdits.add). */
(function (root) {
  'use strict';

  var TEAMS = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric', 'other'];
  // The credits Fabled the Script Builder adds to its exports is the site
  // signing the script, not a character — never imported.
  var CREDITS_ID = 'botchomebrewwiki';
  var ART_CREDIT = /\bart(work)?\b|\bicons?\b|\bimage\b|\bill?ustrat/i;

  // What the source replaces on a page that exists, what it replaces only when
  // it carries one, and what it only fills when the page has none.
  var MECHANICS = ['name', 'team', 'ability', 'firstNight', 'firstNightReminder',
    'otherNight', 'otherNightReminder', 'reminders', 'remindersGlobal', 'setup',
    'special', 'jinxes'];
  var IF_PRESENT = ['quote', 'edition', 'customJson'];
  var FILL_EMPTY = ['lede', 'summaryBullets', 'howToRun', 'callout', 'examples',
    'tips', 'iconBy', 'customBoxes'];

  function key(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '');
  }
  function clean(list) {
    return (Array.isArray(list) ? list : []).map(function (x) { return String(x || '').trim(); })
      .filter(Boolean);
  }
  function empty(v) {
    if (Array.isArray(v)) return !v.length;
    return v == null || String(v).trim() === '';
  }
  function tagList(v) {
    return String(v || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }
  function addTagList(have, add) {
    var out = have.slice();
    add.forEach(function (t) {
      if (!out.some(function (x) { return x.toLowerCase() === t.toLowerCase(); })) out.push(t);
    });
    return out;
  }

  /* /api/account's characters -> {nameKey: [identity]}, oldest first: the
     order the first import made them in, so a re-import lands on the same
     pages in the same order. */
  function ownIndex(list) {
    var rows = (Array.isArray(list) ? list : []).filter(function (c) { return c && c.slug; });
    rows.sort(function (a, b) {
      var x = String(a.created_at || ''), y = String(b.created_at || '');
      return x < y ? -1 : x > y ? 1 : (String(a.slug) < String(b.slug) ? -1 : 1);
    });
    var out = {};
    rows.forEach(function (c) {
      var k = key(c.name);
      if (k) (out[k] = out[k] || []).push(String(c.slug));
    });
    return out;
  }

  /* One row per character in the source. `kind` is official | update | new;
     `include` is the tick in the table; `target` the page an update lands on. */
  function plan(bundle, own) {
    var used = {};
    return (bundle.characters || []).filter(function (e) {
      return key(e.id) !== CREDITS_ID;
    }).map(function (e) {
      var row = { id: e.id, name: e.name, team: e.team, entry: e, include: true, kind: 'new', target: '', note: '' };
      var match = e.official && e.official.match;
      if (e.bare || match === 'exact') { row.kind = 'official'; return row; }
      if (!String(e.ability || '').trim()) { row.include = false; row.note = 'no ability'; }
      if (match === 'named') row.note = 'shares an official name';
      var mine = (own && own[key(e.name)]) || [];
      for (var i = 0; i < mine.length; i++) {
        if (!used[mine[i]]) { row.kind = 'update'; row.target = mine[i]; used[mine[i]] = 1; break; }
      }
      return row;
    });
  }

  /* What the source says about one character, as wiki fields. The almanac's
     overview opens with the lede and the rest is the summary; an attribution
     that credits the art fills "Icon by", any other becomes a Credit box. */
  function character(e, opts, tags) {
    opts = opts || {};
    var overview = clean(e.overview);
    var iconBy = '', boxes = [];
    if (e.attribution) {
      if (ART_CREDIT.test(e.attribution)) iconBy = e.attribution;
      else boxes.push({ title: 'Credit', content: e.attribution });
    }
    var c = {
      name: String(e.name || ''),
      team: TEAMS.indexOf(e.team) === -1 ? 'townsfolk' : e.team,
      ability: String(e.ability || ''),
      quote: String(e.flavour || '').trim().replace(/^["'“]|["'”]$/g, ''),
      lede: overview[0] || '',
      summaryBullets: overview.slice(1),
      howToRun: clean(e.howToRun),
      examples: clean(e.examples),
      tips: clean(e.tips),
      iconBy: iconBy,
      customBoxes: boxes,
      edition: String(e.edition || ''),
      firstNight: Number(e.firstNight) || 0,
      firstNightReminder: String(e.firstNightReminder || ''),
      otherNight: Number(e.otherNight) || 0,
      otherNightReminder: String(e.otherNightReminder || ''),
      reminders: clean(e.reminders),
      remindersGlobal: clean(e.remindersGlobal),
      setup: !!e.setup,
      special: Array.isArray(e.special) ? e.special : [],
      jinxes: [],
      tags: (tags || []).join(', ')
    };
    if (opts.keepJson && e.raw) {
      c.customJson = JSON.stringify([opts.meta || { id: '_meta', name: '' }, e.raw], null, 2);
    }
    return c;
  }

  /* merge(page, c, opts) -> the object to POST to /api/character.
     page: the /api/page answer for the page being updated, or null for a new
     one. A page that exists keeps everything the source does not own: tags
     (the import's are added), the art slots, the token, who may edit it and
     whether it is published. */
  function merge(page, c, opts) {
    opts = opts || {};
    var data = page && page.data && typeof page.data === 'object' ? page.data : null;
    if (!data) {
      var fresh = Object.assign({}, c, {
        creator: opts.creator || '',
        appearsIn: opts.appearsIn || '',
        status: opts.status === 'draft' ? 'draft' : 'published'
      });
      if (opts.publicEdit) fresh.publicEdit = opts.publicEdit;
      return fresh;
    }
    var out = Object.assign({}, data);
    MECHANICS.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(c, k)) out[k] = c[k]; });
    IF_PRESENT.forEach(function (k) { if (c[k]) out[k] = c[k]; });
    FILL_EMPTY.forEach(function (k) { if (empty(out[k]) && !empty(c[k])) out[k] = c[k]; });
    var add = tagList(c.tags);
    if (add.length) out.tags = addTagList(tagList(out.tags), add).join(', ');
    if (opts.creator) out.creator = opts.creator;
    if (opts.appearsIn) out.appearsIn = opts.appearsIn;
    out.status = page.status === 'draft' ? 'draft' : 'published';
    if (page.updatedAt) out.baseUpdatedAt = page.updatedAt;
    delete out.appearsInFrom;   // derived on read, never stored
    return out;
  }

  /* Which art slots the source may write: all of them on a new page; on one
     that exists, only the empty ones unless "Replace the art" is ticked. */
  function artPlan(page, replace) {
    var d = page && page.data;
    var has = function (rel, abs) { return !!(d && (d[rel] || d[abs])); };
    return {
      main: !d || !!replace || !has('art', 'image'),
      alt: !d || !!replace || !has('artAlt', 'imageAlt'),
      alt2: !d || !!replace || !has('artAlt2', 'imageAlt2')
    };
  }

  // A row that gets a page here, and its identity once settled.
  function pageSlug(row) {
    return row && row.include && row.kind !== 'official' ? (row.slug || '') : '';
  }
  // What a row puts on a script roster: its page, or off-{id} for an official.
  function rosterSlug(row) {
    if (!row || !row.include) return '';
    if (row.kind === 'official') {
      var o = row.entry.official || {};
      return o.slug || (o.id ? 'off-' + key(o.id) : '');
    }
    return pageSlug(row);
  }
  function roster(rows, destination) {
    return rows.map(rosterSlug).filter(function (s) {
      return s && !(destination === 'collection' && s.indexOf('off-') === 0);
    });
  }

  /* Every jinx in the source, from either shape: Bloodstar's pair entries
     (bundle.jinxes, {a, b, text} by name) and the official schema's list on
     each character ({id, reason}). `officialNames` is {key: name} for the
     official roster, so a jinx with an official character outside the source
     is named properly.

     -> {byOwner: {identity: [jinx]}, scriptAdds: [{a, b, text}],
         dropped: [label], byName: [label]} — byName are jinxes whose other end
     is neither in the source nor official: stored by name, which more than one
     page may answer to. */
  function jinxes(bundle, rows, destination, officialNames) {
    officialNames = officialNames || {};
    var out = { byOwner: {}, scriptAdds: [], dropped: [], byName: [] };
    var index = {};
    rows.forEach(function (r) {
      [r.id, r.name].forEach(function (k) { k = key(k); if (k && !index[k]) index[k] = r; });
    });
    var pairs = [], seen = {};
    function push(a, aRef, bRef, text) {
      var b = index[key(bRef)] || null;
      var pk = [key(a ? a.name : aRef), key(b ? b.name : bRef)].sort().join('|');
      if (!text || seen[pk]) return;
      seen[pk] = 1;
      pairs.push({ a: a, aRef: aRef, b: b, bRef: bRef, text: text });
    }
    (bundle.jinxes || []).forEach(function (j) { push(index[key(j.a)] || null, j.a, j.b, String(j.text || '')); });
    rows.forEach(function (r) {
      (Array.isArray(r.entry.jinxes) ? r.entry.jinxes : []).forEach(function (j) {
        if (j) push(r, r.name, String(j.id || j.name || ''), String(j.reason || j.text || ''));
      });
    });

    pairs.forEach(function (p) {
      var label = (p.a ? p.a.name : p.aRef) + ' / ' + (p.b ? p.b.name : p.bRef);
      var aPage = pageSlug(p.a), bPage = pageSlug(p.b);
      if (aPage || bPage) {
        var other = aPage ? p.b : p.a, ref = aPage ? p.bRef : p.aRef;
        var jx = { name: other ? other.name : (officialNames[key(ref)] || ref), text: p.text };
        var oid = String(ref || '').toLowerCase();
        if (pageSlug(other)) jx.slug = pageSlug(other);
        else if (other && other.kind === 'official' && other.entry.official) jx.id = other.entry.official.id;
        else if (/^[a-z0-9_-]{1,80}$/.test(oid)) jx.id = oid;
        if (!jx.slug && !(other && other.kind === 'official') &&
            !officialNames[key(other ? other.name : ref)]) out.byName.push(label);
        var owner = aPage || bPage;
        (out.byOwner[owner] = out.byOwner[owner] || []).push(jx);
        return;
      }
      var a = rosterSlug(p.a), b = rosterSlug(p.b);
      if (a && b && destination === 'script') out.scriptAdds.push({ a: a, b: b, text: p.text });
      else out.dropped.push(label);
    });
    return out;
  }

  /* The almanac's two night lists, by name, as the script's arranged
     nightOrder. A name not on the roster drops out; the wiki slots anything
     missing in by its own number. */
  function nightOrder(bundle, rows) {
    var byName = {};
    rows.forEach(function (r) {
      var s = rosterSlug(r);
      if (s && !byName[key(r.name)]) byName[key(r.name)] = s;
    });
    var pick = function (names) {
      return (names || []).map(function (n) { return byName[key(n)]; }).filter(Boolean);
    };
    var names = bundle.nightOrderNames || {};
    var out = {};
    if (pick(names.first).length) out.first = pick(names.first);
    if (pick(names.other).length) out.other = pick(names.other);
    return out.first || out.other ? out : null;
  }

  /* The script or collection page. extra: {logo, background, nightOrder,
     jinxEdits}. A collection is a shelf: include[] and order[], no night
     order or jinx list. */
  function setPage(bundle, opts, slug, rosterSlugs, extra) {
    extra = extra || {};
    var meta = bundle.meta || {};
    var prose = bundle.prose || {};
    var page = {
      name: meta.name || slug,
      author: opts.creator || meta.author || '',
      status: opts.status === 'published' ? 'published' : 'draft'
    };
    if (prose.synopsis && prose.synopsis.plain) page.synopsis = prose.synopsis.plain;
    if (prose.overview && prose.overview.plain) page.gameplay = prose.overview.plain;
    if (extra.logo) page.logo = extra.logo;
    if (extra.background) page.theme = { background: extra.background };
    if (opts.publicEdit) page.publicEdit = opts.publicEdit;
    if (opts.destination === 'collection') {
      return Object.assign(page, { id: slug, slug: slug, displayName: meta.name || slug,
        match: [], include: rosterSlugs, exclude: [], order: rosterSlugs });
    }
    page.slug = slug;
    page.characters = rosterSlugs;
    if (extra.nightOrder) page.nightOrder = extra.nightOrder;
    if (extra.jinxEdits) page.jinxEdits = extra.jinxEdits;
    if (meta.bootlegger && meta.bootlegger.length) page.bootlegger = meta.bootlegger;
    if (meta.almanac) page.almanac = meta.almanac;
    if (meta.hideTitle) page.hideTitle = true;
    return page;
  }

  /* Re-importing over your own script or collection: the roster, night order,
     jinxes and bootlegger rules come from the source; prose, logo and
     background only fill what the page has none of; its theme, boxes, sharing
     and publish state stay. A collection ADDS the import's characters to its
     members, so ones put there by hand are kept. */
  function mergeSetPage(page, fresh) {
    var d = page && page.data && typeof page.data === 'object' ? page.data : {};
    var out = Object.assign({}, d, { slug: page.slug });
    ['characters', 'nightOrder', 'jinxEdits', 'bootlegger', 'almanac', 'hideTitle'].forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(fresh, k)) out[k] = fresh[k];
    });
    if (fresh.include) {
      out.include = addTagList(clean(d.include), fresh.include);
      out.order = addTagList(clean(d.order), fresh.include);
    }
    ['synopsis', 'gameplay', 'logo', 'author'].forEach(function (k) {
      if (empty(out[k]) && !empty(fresh[k])) out[k] = fresh[k];
    });
    if (fresh.theme && fresh.theme.background && !(out.theme && out.theme.background)) {
      out.theme = Object.assign({}, out.theme, { background: fresh.theme.background });
    }
    out.status = page.status === 'draft' ? 'draft' : 'published';
    if (page.updatedAt) out.baseUpdatedAt = page.updatedAt;
    return out;
  }

  // The changelog, as a /p/ page under the new script or collection.
  function changelogPage(bundle, opts, parentType, parentSlug) {
    var cl = bundle.prose && bundle.prose.changelog;
    if (!cl || !cl.wiki) return null;
    var meta = bundle.meta || {};
    return {
      title: meta.name ? meta.name + ' Changelog' : 'Changelog',
      author: opts.creator || meta.author || '',
      body: cl.wiki, parentType: parentType, parentSlug: parentSlug,
      status: opts.status === 'published' ? 'published' : 'draft'
    };
  }

  var api = {
    TEAMS: TEAMS, MECHANICS: MECHANICS, IF_PRESENT: IF_PRESENT, FILL_EMPTY: FILL_EMPTY,
    key: key, ownIndex: ownIndex, plan: plan, character: character, merge: merge,
    artPlan: artPlan, rosterSlug: rosterSlug, roster: roster, jinxes: jinxes,
    nightOrder: nightOrder, setPage: setPage, mergeSetPage: mergeSetPage,
    changelogPage: changelogPage
  };
  root.Importer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
