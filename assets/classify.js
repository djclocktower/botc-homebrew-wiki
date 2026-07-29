/* Page classification — the single source of truth for Partial / Standard /
   Starlight.

   Used in the browser (all-characters, tag/team/author pages, the homepage,
   the create/edit editors, the dashboard) AND bundled into the Worker, which
   stamps `classification` onto every row it serves in characters.json /
   collections.json / scripts.json. Because both sides share this file, a
   badge in the editor preview always matches the badge on the live page.

   The three tiers
   ---------------
   partial   Characters only. The page has an icon and an ability but nothing
             else — no tags AND no almanac text of any kind. Partial pages are
             hidden from browse/search listings, the tag pages, Featured and
             the homepage, unless the *reader* ticks the "Partial" filter chip.
   standard  The default. Anything with an icon, plus at least one tag or at
             least one scrap of almanac text. No badge, nothing to earn.
   starlight Admin-awarded, on characters, collections or scripts. Weighted
             higher in Featured / random picks and filterable on its own.

   Nothing here is stored except `starlight` (a boolean in the page's data
   JSON, writable only through /api/admin/starlight). partial vs standard is
   derived from the content every time, so a page upgrades itself the moment
   its owner adds a tag or a line of almanac text — no migration, no cron.

   No DOM access at module top level: worker/worker.js imports this file. */
(function () {
  'use strict';

  // Almanac fields that count as "the author wrote something". Kept in step
  // with renderCharacter() in assets/render.js — if you add a prose field
  // there, add it here too or the page will read as Partial forever.
  var ALMANAC_TEXT_FIELDS = ['lede', 'callout', 'flavour', 'flavor'];
  var ALMANAC_LIST_FIELDS = [
    'summaryBullets', 'howToRun', 'examples', 'tips', 'bluffing', 'fighting'
  ];

  function nonEmpty(v) {
    return typeof v === 'string' && v.trim() !== '';
  }

  /* Does this character have an icon? `art` is a repo/R2 path
     (assets/art/x.png); `image` is a remote URL from a bulk import, and may
     be an array of team-coloured variants. Either one counts. */
  function hasIcon(d) {
    if (!d) return false;
    if (nonEmpty(d.art)) return true;
    if (Array.isArray(d.image)) return d.image.some(nonEmpty);
    return nonEmpty(d.image);
  }

  /* Any almanac prose at all — one bullet point is enough. */
  function hasAlmanac(d) {
    if (!d) return false;
    for (var i = 0; i < ALMANAC_TEXT_FIELDS.length; i++) {
      if (nonEmpty(d[ALMANAC_TEXT_FIELDS[i]])) return true;
    }
    for (var j = 0; j < ALMANAC_LIST_FIELDS.length; j++) {
      var list = d[ALMANAC_LIST_FIELDS[j]];
      if (Array.isArray(list) && list.some(nonEmpty)) return true;
    }
    return false;
  }

  function hasTags(d) {
    return !!(d && nonEmpty(d.tags) &&
      String(d.tags).split(',').some(function (t) { return t.trim(); }));
  }

  function isStarlight(d) {
    return !!(d && d.starlight);
  }

  /* Partial = finished enough to publish (it has an icon) but empty of
     everything else. Starlight always wins: an admin has looked at the page,
     so it is never also flagged unfinished. */
  function isPartial(d) {
    if (!d || isStarlight(d)) return false;
    return !hasTags(d) && !hasAlmanac(d);
  }

  /* 'starlight' | 'partial' | 'standard' for a character. */
  function classifyCharacter(d) {
    if (isStarlight(d)) return 'starlight';
    if (isPartial(d)) return 'partial';
    return 'standard';
  }

  /* Collections and scripts only have two states — they have no almanac and
     no tags of their own, so "Partial" would be meaningless for them. */
  function classifyPage(d, type) {
    if (type === 'character') return classifyCharacter(d);
    return isStarlight(d) ? 'starlight' : 'standard';
  }

  /* What still needs doing before a page counts as Standard. Drives the
     editor's "this page is unfinished" popup and the admin page list. */
  function missingBits(d) {
    var out = [];
    if (!hasIcon(d)) out.push('icon');
    if (!hasTags(d)) out.push('tags');
    if (!hasAlmanac(d)) out.push('almanac');
    return out;
  }

  var LABELS = {
    partial: 'Partial',
    standard: 'Standard',
    starlight: 'Starlight'
  };
  var DESCRIPTIONS = {
    partial: 'Unfinished — an ability and an icon, but no tags and no almanac ' +
             'text yet. Hidden from browsing unless the “Partial” filter is on.',
    standard: 'A normal, complete page.',
    starlight: 'Awarded by the wiki admins. Shown more often on the homepage ' +
               'and in Featured picks.'
  };

  /* Small badge for grids and page headers. Standard pages get nothing —
     that is the whole point of Standard. */
  function classBadgeHTML(cls) {
    if (cls !== 'partial' && cls !== 'starlight') return '';
    var label = LABELS[cls];
    return '<span class="page-class page-class-' + cls + '" title="' +
      DESCRIPTIONS[cls].replace(/"/g, '&quot;') + '">' +
      (cls === 'starlight' ? '✦ ' : '') + label + '</span>';
  }

  /* Weighted pick used by Featured / random rotations. Starlight entries get
     STARLIGHT_WEIGHT tickets in the hat instead of one; Partial entries are
     not in the hat at all. `rand` defaults to Math.random so the Worker can
     pass a seeded generator for its daily rotation. */
  var STARLIGHT_WEIGHT = 5;

  function weightedPick(list, rand) {
    var pool = eligible(list);
    if (!pool.length) return null;
    var total = 0, i;
    for (i = 0; i < pool.length; i++) total += weightOf(pool[i]);
    var roll = (rand || Math.random)() * total;
    for (i = 0; i < pool.length; i++) {
      roll -= weightOf(pool[i]);
      if (roll < 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function weightOf(d) {
    return isStarlight(d) ? STARLIGHT_WEIGHT : 1;
  }

  /* Everything a reader should see by default: drops Partial pages. */
  function eligible(list) {
    return (list || []).filter(function (d) { return !isPartial(d); });
  }

  /* Shuffle that floats Starlight entries towards the front without pinning
     them there — used for the homepage collection/script strips. */
  function weightedShuffle(list, rand) {
    var r = rand || Math.random;
    return (list || []).map(function (d) {
      // key = U^(1/w): the standard trick for weighted sampling without
      // replacement. Higher weight -> key closer to 1 -> sorts earlier.
      return [d, Math.pow(r() || 1e-9, 1 / weightOf(d))];
    }).sort(function (a, b) { return b[1] - a[1]; })
      .map(function (p) { return p[0]; });
  }

  var API = {
    hasIcon: hasIcon, hasAlmanac: hasAlmanac, hasTags: hasTags,
    isPartial: isPartial, isStarlight: isStarlight,
    classifyCharacter: classifyCharacter, classifyPage: classifyPage,
    missingBits: missingBits, classBadgeHTML: classBadgeHTML,
    weightedPick: weightedPick, weightedShuffle: weightedShuffle,
    eligible: eligible, weightOf: weightOf,
    STARLIGHT_WEIGHT: STARLIGHT_WEIGHT,
    CLASS_LABELS: LABELS, CLASS_DESCRIPTIONS: DESCRIPTIONS
  };

  if (typeof window !== 'undefined') {
    for (var k in API) if (Object.prototype.hasOwnProperty.call(API, k)) window[k] = API[k];
    window.Classify = API;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
