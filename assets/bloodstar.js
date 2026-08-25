/* bloodstar.js — turning a read Bloodstar project into this wiki's saves.
 *
 * The Worker does the reading (GET /api/bloodstar, see worker/bloodstar.js)
 * and hands back one normalized bundle. Everything here is the second half:
 * WHAT the person importing chose it should all become, and the exact objects
 * that decision posts to /api/character, /api/script, /api/collection and
 * /api/wiki-page.
 *
 * It is kept apart from bloodstar.html for the reason grimforge.js is: this is
 * the part with rules in it, and rules are worth being able to read, check
 * (`node --check`) and change without moving around a page of markup. The page
 * owns the form and the progress table; this owns the mapping.
 *
 * No DOM, no fetch: every function takes what it needs and returns a plain
 * object. Browser only in the sense that it publishes itself on `window` —
 * nothing here would mind running anywhere else.
 *
 * ── The mapping, in one place ──
 *
 *   Bloodstar                        this wiki
 *   ──────────────────────────────   ─────────────────────────────────────
 *   name / team / ability            the same
 *   flavor                           quote (the line under the title), or the
 *                                    flavour line, or nothing
 *   almanac overview, 1st paragraph  lede (the flavour line above the summary)
 *   almanac overview, the rest       summaryBullets
 *   almanac Examples                 examples[]
 *   almanac How to Run               howToRun[]
 *   almanac tips                     tips[], or the callout box
 *   attribution                      iconBy when it credits the art, else a
 *                                    "Credit" box — it is somebody's name and
 *                                    dropping it is the one unrecoverable loss
 *   image                            art/{slug}.png in R2
 *   firstNight / otherNight / …      the same
 *   jinx entries (team "jinxes")     a jinx on whichever end got a wiki page
 *   synopsis / overview / changelog  the script or collection page's synopsis
 *                                    and gameplay, and a /p/ wiki page
 *   the almanac's night order        the page's arranged nightOrder
 *
 * Nothing about that is fixed: every row of it is an option on the page, and
 * defaultOptions() below is only where the form starts.
 */
(function () {
  'use strict';

  var TEAMS = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'];

  function key(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  function slugify(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  function clean(list) {
    return (list || []).map(function (x) { return String(x || '').trim(); })
      .filter(Boolean);
  }

  /* Where the form starts. Every default is the answer that loses the least:
     art comes over, prose comes over, official characters are linked rather
     than copied (a page for the wiki's 400th Chambermaid helps nobody), and
     nothing is published until the person says so — an import is exactly the
     moment to look at forty pages before the site does. */
  function defaultOptions() {
    return {
      destination: 'script',      // script | collection | characters
      status: 'draft',            // draft | published
      creator: '',
      appearsIn: '',
      // Tags are per character, keyed by the Bloodstar id: {id: ['information']}.
      // They were once one box applied to every character in the project, which
      // is not what a tag is — "information" is true of the Ferrotypist and
      // false of the Drunk, and a set of 36 characters sharing one tag tells a
      // reader nothing. Tagging everything at once is still reachable, but as a
      // deliberate act (select all, then assign) rather than the default.
      tagsById: {},
      // There is deliberately no option for an EXACT official match. This wiki
      // is for homebrew: an official character has a page on the official wiki
      // already, its art is not ours to host, and a copy here fragments search
      // and takes the name from whoever writes a real homebrew character of
      // it. So it is never made into a page — the roster points at off-{id}
      // and the script page links the name straight to the official wiki.
      // What IS an option is the name-only match: a character wearing a
      // familiar name with a different ability is ordinary homebrew.
      reworked: 'import',         // import | link | skip
      art: true,
      logo: true,
      background: true,
      flavour: 'quote',           // quote | lede | skip
      overview: 'lede-bullets',   // lede-bullets | bullets | howto | skip
      examples: true,
      howToRun: true,
      tips: 'tips',               // tips | callout | skip
      credit: true,
      mechanics: true,
      nightReminders: true,
      synopsis: 'synopsis',       // synopsis | description | skip
      projectOverview: 'gameplay',// gameplay | synopsis | description | skip
      changelog: 'wikipage',      // wikipage | box | skip
      nightOrder: true,
      jinxes: 'characters',       // characters | script | skip
      bootlegger: true,
      almanacLink: true,
      publicEdit: '',
      skip: {}                    // character id -> true, from the table
    };
  }

  /* ── tags, per character ──
     Held as {characterId: [tag]} so a tag can be given to a handful of
     characters at once and taken off again without a second pass over the
     list. Everything here returns a NEW map rather than editing the one it was
     given: the page re-renders from whatever it is handed, and an in-place
     edit would make an undo impossible to add later. */
  function tagsFor(map, id) {
    var list = map && map[id];
    return Array.isArray(list) ? list.slice() : [];
  }

  /* What /api/character actually stores: one comma-separated string. */
  function tagString(map, id) {
    return tagsFor(map, id).join(', ');
  }

  function cleanTags(tags) {
    return (tags || []).map(function (t) { return String(t || '').trim(); })
      .filter(Boolean);
  }

  function addTags(map, ids, tags) {
    var out = {}, want = cleanTags(tags);
    Object.keys(map || {}).forEach(function (k) { out[k] = tagsFor(map, k); });
    if (!want.length) return out;
    (ids || []).forEach(function (id) {
      var have = out[id] || [];
      want.forEach(function (t) {
        // Case-insensitively, because the picker and a hand-typed tag can
        // disagree on capitals and the wiki treats them as one tag.
        var seen = have.some(function (x) { return x.toLowerCase() === t.toLowerCase(); });
        if (!seen) have.push(t);
      });
      out[id] = have;
    });
    return out;
  }

  function removeTags(map, ids, tags) {
    var out = {}, drop = cleanTags(tags).map(function (t) { return t.toLowerCase(); });
    Object.keys(map || {}).forEach(function (k) { out[k] = tagsFor(map, k); });
    (ids || []).forEach(function (id) {
      out[id] = (out[id] || []).filter(function (t) {
        return drop.indexOf(t.toLowerCase()) === -1;
      });
      if (!out[id].length) delete out[id];
    });
    return out;
  }

  function clearTags(map, ids) {
    var out = {};
    Object.keys(map || {}).forEach(function (k) { out[k] = tagsFor(map, k); });
    (ids || []).forEach(function (id) { delete out[id]; });
    return out;
  }

  /* How many of the characters being imported still have no tag. A character
     with none reads as Partial on this wiki, and an import is the one moment
     somebody has the whole cast in front of them, so it is worth saying out
     loud rather than leaving to be discovered page by page. */
  function untaggedCount(planned, map) {
    return (planned.rows || []).filter(function (r) {
      return r.action === 'create' && !tagsFor(map, r.id).length;
    }).length;
  }

  /* ── who becomes what ──
     Three answers per character, and the tool never guesses silently:
       'create'  a wiki page of its own
       'link'    no page; the roster points at the official character
       'skip'    left out entirely
     `official.match` is how sure the read was (see buildBundle): 'exact' means
     the name AND the ability are the official character's, so it IS that
     character. 'named' means the name matches and the ability does not, which
     is a reworked character wearing a familiar name and needs its own page or
     the roster would quietly say something the author did not write. */
  function decide(entry, opts) {
    if (opts.skip && opts.skip[entry.id]) return 'skip';
    if (entry.bare) return 'link';
    var match = entry.official && entry.official.match;
    if (!match) return 'create';
    // An exact match IS the official character. Not a choice: it never becomes
    // a page here, whoever is importing and whatever they would prefer.
    if (match === 'exact') return entry.official.slug ? 'link' : 'skip';
    if (opts.reworked === 'link' && entry.official.slug) return 'link';
    if (opts.reworked === 'skip') return 'skip';
    return 'create';
  }

  /* The whole run, worked out before anything is written, so the page can show
     it and the person can change their mind while it still costs nothing. */
  function plan(bundle, opts) {
    var rows = (bundle.characters || []).map(function (entry) {
      var action = decide(entry, opts);
      return {
        id: entry.id,
        name: entry.name,
        team: entry.team,
        action: action,
        official: entry.official || null,
        hasArt: !!entry.image,
        hasAlmanac: !!entry.hasAlmanac,
        entry: entry
      };
    });
    return {
      rows: rows,
      creating: rows.filter(function (r) { return r.action === 'create'; }).length,
      linking: rows.filter(function (r) { return r.action === 'link'; }).length,
      skipping: rows.filter(function (r) { return r.action === 'skip'; }).length
    };
  }

  /* ── one character ──
     `slug` is the identity the Worker's /api/slug-check handed back, and
     `artPath` is where its icon actually landed (empty when it stayed on
     Bloodstar or there was none). */
  function characterPayload(entry, opts, slug, artPath, jinxes) {
    var overview = clean(entry.overview);
    var lede = '';
    var bullets = [];
    var howExtra = [];
    if (opts.overview === 'lede-bullets') { lede = overview[0] || ''; bullets = overview.slice(1); }
    else if (opts.overview === 'bullets') { bullets = overview; }
    else if (opts.overview === 'howto') { howExtra = overview; }

    // The flavour line can be the quote under the title or the lede above the
    // summary, and when it is the lede it wins the slot over the overview's
    // first paragraph — it is the line the author wrote to be read first.
    var quote = '';
    if (opts.flavour === 'quote') quote = entry.flavour || '';
    else if (opts.flavour === 'lede' && entry.flavour) lede = entry.flavour;

    var tips = opts.tips === 'tips' ? clean(entry.tips) : [];
    var callout = opts.tips === 'callout' ? clean(entry.tips).join(' ') : '';

    var boxes = [];
    var iconBy = '';
    if (opts.credit && entry.attribution) {
      // "Base Art by Cal Winter, Made on Commission For This Script" is an art
      // credit and the wiki has a field for exactly that. "The Chambermaid was
      // created by The Pandemonium Institute" is not, and belongs where it can
      // be read as a sentence.
      if (/\bart(work)?\b|\bicon\b|\bimage\b|\bill?ustrat/i.test(entry.attribution)) {
        iconBy = entry.attribution;
      } else {
        boxes.push({ title: 'Credit', content: entry.attribution });
      }
    }

    var payload = {
      slug: slug,
      name: entry.name,
      team: TEAMS.indexOf(entry.team) === -1 ? 'townsfolk' : entry.team,
      ability: entry.ability || '',
      creator: opts.creator || '',
      appearsIn: opts.appearsIn || '',
      tags: tagString(opts.tagsById, entry.id),
      lede: lede,
      summaryBullets: bullets,
      howToRun: howExtra.concat(opts.howToRun ? clean(entry.howToRun) : []),
      callout: callout,
      examples: opts.examples ? clean(entry.examples) : [],
      tips: tips,
      quote: quote,
      iconBy: iconBy,
      edition: entry.edition || '',
      jinxes: jinxes || [],
      customBoxes: boxes,
      status: opts.status === 'published' ? 'published' : 'draft'
    };
    if (opts.publicEdit) payload.publicEdit = opts.publicEdit;

    // The mechanics half: night positions, reminder tokens, the setup flag and
    // the official schema's behaviour flags. Switched off, a page is prose and
    // art only — which is what someone importing an almanac for reference,
    // rather than a script to run, is asking for.
    if (opts.mechanics) {
      payload.firstNight = Number(entry.firstNight) || 0;
      payload.otherNight = Number(entry.otherNight) || 0;
      payload.reminders = clean(entry.reminders);
      payload.remindersGlobal = clean(entry.remindersGlobal);
      payload.setup = !!entry.setup;
      payload.special = Array.isArray(entry.special) ? entry.special : [];
      if (opts.nightReminders) {
        payload.firstNightReminder = entry.firstNightReminder || '';
        payload.otherNightReminder = entry.otherNightReminder || '';
      }
    }

    if (artPath) {
      payload.art = artPath;
      payload.image = 'https://botchomebrew.wiki/assets/' + artPath;
    } else if (entry.image) {
      // Art that could not be copied keeps its Bloodstar URL, so the page has
      // an icon and reads as finished. It is a link to somebody else's server,
      // which is why copying is the default and this is the fallback.
      payload.image = entry.image;
    }
    return payload;
  }

  /* ── the roster ──
     A created character is on the script by its wiki identity; a linked
     official is 'off-{id}', which is the slug the whole wiki uses for one. */
  function rosterSlug(row, slugById) {
    if (row.action === 'create') return slugById[row.id] || '';
    if (row.action === 'link' && row.official) {
      return row.official.slug || ('off-' + key(row.official.id));
    }
    return '';
  }

  /* A collection's membership is a list of pages on THIS wiki — an 'off-'
     slug resolves to nothing there, so an official character riding along on
     an imported script simply is not a member of the collection it becomes.
     A script roster holds both. */
  function roster(planned, slugById, opts) {
    var collection = opts && opts.destination === 'collection';
    return planned.rows.map(function (r) { return rosterSlug(r, slugById); })
      .filter(function (s) { return s && !(collection && s.indexOf('off-') === 0); });
  }

  /* ── jinxes ──
     A jinx is stored on ONE of its two characters (the wiki mirrors it onto
     the other when it draws the page), so each one needs an end that this
     import actually made a page for. A jinx between two official characters
     has no such end, and becomes one of the script's own `jinxEdits.add`
     rules instead — which is the wiki's way of saying "this rule holds on
     this script" without editing anyone's character.

     `nameOnly` is the list this tool warns about before it runs: a jinx whose
     other end is neither a page this import makes nor an official character —
     the person left it out — has nothing to name it by but its name, and a
     name is not unique on this wiki (there are four Wardens). It is still
     written: a jinx that resolves to the wrong page can be corrected, and one
     that was never stored cannot.

     Returns {byOwner: {slug: [jinx]}, scriptAdds: [], dropped: [],
     nameOnly: [{owner, other}]}. */
  function resolveJinxes(bundle, planned, slugById, opts) {
    var out = { byOwner: {}, scriptAdds: [], dropped: [], nameOnly: [] };
    if (opts.jinxes === 'skip') return out;

    // name -> what that name became in this run
    var byName = {};
    planned.rows.forEach(function (r) {
      var k = key(r.name);
      if (!k || byName[k]) return;
      byName[k] = {
        action: r.action,
        slug: slugById[r.id] || '',
        officialId: r.official ? r.official.id : ''
      };
    });

    (bundle.jinxes || []).forEach(function (j) {
      var a = byName[key(j.a)], b = byName[key(j.b)];
      if (!a || !b || !j.text) { out.dropped.push(j.title || (j.a + ' / ' + j.b)); return; }
      var aPage = a.action === 'create' && a.slug;
      var bPage = b.action === 'create' && b.slug;

      // Written onto whichever end has a page here. When both do it goes on
      // the first, exactly as an author typing it into one editor would leave
      // it — the other page shows it by mirroring, never by a second copy.
      if (opts.jinxes === 'characters' && (aPage || bPage)) {
        var ownerSlug = aPage ? a.slug : b.slug;
        var other = aPage ? b : a;
        var otherName = aPage ? j.b : j.a;
        var jinx = { name: otherName, align: '', text: j.text };
        if (other.action === 'create' && other.slug) jinx.slug = other.slug;
        else if (other.officialId) jinx.id = other.officialId;
        else out.nameOnly.push({ owner: aPage ? j.a : j.b, other: otherName });
        (out.byOwner[ownerSlug] = out.byOwner[ownerSlug] || []).push(jinx);
        return;
      }
      // Both ends are official (or the person asked for script-only jinxes):
      // the rule belongs to the script, not to characters nobody here owns.
      var aSlug = aPage ? a.slug : (a.officialId ? 'off-' + key(a.officialId) : '');
      var bSlug = bPage ? b.slug : (b.officialId ? 'off-' + key(b.officialId) : '');
      // A script's own jinx list needs a script. Importing the same project as
      // a collection, or as characters alone, leaves this rule nowhere to go,
      // and saying so beats storing it where nothing reads it.
      if (aSlug && bSlug && opts.destination === 'script') {
        out.scriptAdds.push({ a: aSlug, b: bSlug, text: j.text });
      } else {
        out.dropped.push(j.title || (j.a + ' / ' + j.b));
      }
    });
    return out;
  }

  /* What resolveJinxes() would do, before the run has asked the Worker for a
     single slug. The real identities are not known until then and none of the
     risks depend on them, so a placeholder per created page is enough — this
     way the warning comes off the same code that will do the writing, rather
     than a second copy of the rule that can drift from it. */
  function previewSlugs(planned) {
    var m = {};
    (planned.rows || []).forEach(function (r) {
      if (r.action === 'create') m[r.id] = 'pending-' + r.id;
    });
    return m;
  }

  /* ── the arranged night order ──
     The almanac prints the two lists in the order the author put them in, by
     name. Turned into roster slugs it is exactly what the wiki stores as a
     script's `nightOrder`. A name the run did not make a page for (skipped,
     or an official character not on the roster) simply drops out: the list is
     an ARRANGEMENT, and the wiki slots anything missing from it in by the
     character's own number. */
  function nightOrder(bundle, planned, slugById) {
    var byName = {};
    planned.rows.forEach(function (r) {
      var s = rosterSlug(r, slugById);
      if (s && !byName[key(r.name)]) byName[key(r.name)] = s;
    });
    var pick = function (names) {
      return (names || []).map(function (n) { return byName[key(n)]; }).filter(Boolean);
    };
    var names = bundle.nightOrderNames || {};
    var out = { first: pick(names.first), other: pick(names.other) };
    if (!out.first.length) delete out.first;
    if (!out.other.length) delete out.other;
    return (out.first || out.other) ? out : null;
  }

  /* ── the script or collection page ──
     `slug` is the page's own address, `rosterSlugs` its characters. For a
     collection the roster is `include[]` and there is no night order or jinx
     list, because a collection is a shelf rather than a script. */
  function pagePayload(bundle, opts, slug, rosterSlugs, extra) {
    extra = extra || {};
    var meta = bundle.meta || {};
    var prose = bundle.prose || {};
    var synopsisText = (prose.synopsis && prose.synopsis.plain) || '';
    var overviewText = (prose.overview && prose.overview.plain) || '';

    var page = {
      name: meta.name || slug,
      author: opts.creator || meta.author || '',
      status: opts.status === 'published' ? 'published' : 'draft',
      synopsis: '',
      gameplay: '',
      description: ''
    };
    var put = function (where, text) {
      if (!text || where === 'skip') return;
      // Two sections aimed at one field are joined rather than one silently
      // winning: an author who puts both the synopsis and the overview into
      // Synopsis meant to see both.
      page[where] = page[where] ? page[where] + '\n\n' + text : text;
    };
    put(opts.synopsis, synopsisText);
    put(opts.projectOverview, overviewText);
    if (page.description) page.description = page.description.slice(0, 2000);
    if (!page.synopsis) delete page.synopsis;
    if (!page.gameplay) delete page.gameplay;
    if (!page.description) delete page.description;

    if (opts.changelog === 'box' && prose.changelog && prose.changelog.plain) {
      page.customBoxes = [{ title: 'Changelog', content: prose.changelog.wiki || prose.changelog.plain }];
    }
    if (extra.logo) page.logo = extra.logo;
    if (extra.background) page.theme = { background: extra.background };
    if (opts.publicEdit) page.publicEdit = opts.publicEdit;

    if (opts.destination === 'collection') {
      page.id = slug;
      page.slug = slug;
      page.displayName = meta.name || slug;
      page.match = [];
      page.include = rosterSlugs;
      page.exclude = [];
      page.order = rosterSlugs;
      return page;
    }

    page.slug = slug;
    page.characters = rosterSlugs;
    if (extra.nightOrder) page.nightOrder = extra.nightOrder;
    if (extra.jinxEdits && extra.jinxEdits.add && extra.jinxEdits.add.length) {
      page.jinxEdits = extra.jinxEdits;
    }
    // What the official app reads back out of an exported script, carried
    // straight across: house rules, and the link to the almanac this all came
    // from, which is the honest thing to keep pointing at.
    if (opts.bootlegger && meta.bootlegger && meta.bootlegger.length) {
      page.bootlegger = meta.bootlegger;
    }
    if (opts.almanacLink && meta.almanac) page.almanac = meta.almanac;
    if (meta.hideTitle) page.hideTitle = true;
    return page;
  }

  /* ── the changelog as a wiki page ──
     A changelog is a long text-first document about one script, which is
     precisely what /p/ pages are for, and it would swamp a side box. */
  function changelogPayload(bundle, opts, parentType, parentSlug) {
    var prose = bundle.prose || {};
    if (opts.changelog !== 'wikipage' || !prose.changelog || !prose.changelog.wiki) return null;
    var meta = bundle.meta || {};
    return {
      title: (meta.name ? meta.name + ' — Changelog' : 'Changelog'),
      subtitle: 'Imported from the Bloodstar almanac',
      author: opts.creator || meta.author || '',
      body: prose.changelog.wiki,
      parentType: parentType,
      parentSlug: parentSlug,
      status: opts.status === 'published' ? 'published' : 'draft'
    };
  }

  /* Where a character's icon should land in R2. The identity names the slot,
     which is why the slug has to be settled before any art moves. */
  function artKey(slug) { return 'art/' + slug + '.png'; }

  var api = {
    TEAMS: TEAMS,
    key: key,
    slugify: slugify,
    defaultOptions: defaultOptions,
    decide: decide,
    plan: plan,
    tagsFor: tagsFor,
    tagString: tagString,
    addTags: addTags,
    removeTags: removeTags,
    clearTags: clearTags,
    untaggedCount: untaggedCount,
    characterPayload: characterPayload,
    rosterSlug: rosterSlug,
    roster: roster,
    resolveJinxes: resolveJinxes, previewSlugs: previewSlugs,
    nightOrder: nightOrder,
    pagePayload: pagePayload,
    changelogPayload: changelogPayload,
    artKey: artKey
  };
  if (typeof window !== 'undefined') { window.BloodstarImport = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
