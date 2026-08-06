/* Page classification — the single source of truth for Partial / Standard /
   Starlight.

   Used in the browser (all-characters, tag/team/author pages, the homepage,
   the create/edit editors, the dashboard) AND bundled into the Worker, which
   stamps `classification` onto every row it serves in characters.json /
   collections.json / scripts.json. Because both sides share this file, a
   badge in the editor preview always matches the badge on the live page.

   The three tiers
   ---------------
   partial   Characters only. A page that is missing any part of a finished
             almanac entry (STANDARD_REQUIREMENTS below): name, icon, tags, a
             flavour line, a summary, how-to-run text and at least one
             example. Partial pages are hidden from browse/search listings,
             the tag pages, Featured and the homepage, unless the *reader*
             ticks the "Partial" filter chip.
             Fabled are exempt: on this wiki they are rules constructs
             (States, Conditions, Calls) that are complete at one line.
   standard  Every requirement met. No badge, nothing to earn.
   starlight Admin-awarded, on characters, collections or scripts. Weighted
             higher in Featured / random picks and filterable on its own.
             Starlight OVERRIDES Partial: an admin has looked at the page, so
             it is never also flagged unfinished.

   Two different bars
   ------------------
   PUBLISH_REQUIREMENTS  what a page needs before it can leave drafts at all:
                         name, icon, ability, tags. Enforced by the Worker on
                         /api/character and /api/publish.
   STANDARD_REQUIREMENTS what it needs on top of that to stop being Partial.
   Everything in the publish bar is also in the standard bar, so a published
   page can only ever be missing the almanac half.

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
  /* A list field counts when it holds at least one line with words in it. */
  function listHasText(v) {
    return Array.isArray(v) && v.some(nonEmpty);
  }

  /* Teams whose pages are rules constructs rather than player characters.
     On this wiki Fabled is where States, Conditions, Calls, Alignments and
     Properties live — "Muted (Condition)", "Guessing the Demon (Call)" — and
     those have no token art and no almanac by nature. They are complete as
     they are, so they are exempt from BOTH the icon requirement and the
     Partial classification. Without this, 18 of the wiki's reference pages
     would be swept into drafts and hidden from browsing. */
  var RULES_TEAMS = { fabled: 1 };

  function isRulesPage(d) {
    return !!(d && RULES_TEAMS[String(d.team || '').toLowerCase()]);
  }

  /* Must this page have an icon before it can be published? */
  function needsIcon(d) {
    return !isRulesPage(d);
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

  /* ── the two bars ──
     Each entry is [what to call it in a sentence, test]. The labels are
     written to read inside "Add ___ to fix." on the Partial banner and
     "needs ___" in the editor, so they carry their own articles. */
  var PUBLISH_REQUIREMENTS = [
    ['a name',    function (d) { return nonEmpty(d.name); }],
    ['an icon',   hasIcon],
    ['an ability', function (d) { return nonEmpty(d.ability); }],
    ['tags',      hasTags]
  ];
  var STANDARD_REQUIREMENTS = PUBLISH_REQUIREMENTS.concat([
    ['a flavour line', function (d) { return nonEmpty(d.lede); }],
    ['a summary',      function (d) { return listHasText(d.summaryBullets); }],
    ['how to run',     function (d) { return listHasText(d.howToRun); }],
    ['an example',     function (d) { return listHasText(d.examples); }]
  ]);

  function unmet(d, reqs) {
    // A rules page (Fabled) is complete as it is — see RULES_TEAMS.
    if (!d || isRulesPage(d)) return [];
    var out = [];
    for (var i = 0; i < reqs.length; i++) {
      if (!reqs[i][1](d)) out.push(reqs[i][0]);
    }
    return out;
  }

  /* What still stops this page being published. Empty = it can go live. */
  function missingForPublish(d) { return unmet(d, PUBLISH_REQUIREMENTS); }
  function canPublish(d) { return missingForPublish(d).length === 0; }

  /* Join labels the way a person would say them: "a, b and c". */
  function listPhrase(items) {
    var a = (items || []).slice();
    if (!a.length) return '';
    if (a.length === 1) return a[0];
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  }

  /* Mechanical content that is not almanac prose: night order, Storyteller
     reminder text, reminder tokens, setup effects, jinxes.

     This matters more than it looks. A large part of this wiki arrived by
     bulk import: full night-order entries and reminder tokens, but no tags
     and no almanac prose. Judged on prose alone, 193 of 456 published
     characters — 42% of the wiki — read as "unfinished" and would vanish
     from browsing. They are not unfinished; they are documented in a
     different place. Counting mechanics takes that 193 down to 10, which is
     the handful of genuinely bare pages the Partial tier is aimed at. */
  function hasMechanics(d) {
    if (!d) return false;
    if (nonEmpty(d.firstNightReminder) || nonEmpty(d.otherNightReminder)) return true;
    if (Number(d.firstNight) > 0 || Number(d.otherNight) > 0) return true;
    if (Array.isArray(d.reminders) && d.reminders.some(nonEmpty)) return true;
    if (Array.isArray(d.remindersGlobal) && d.remindersGlobal.some(nonEmpty)) return true;
    if (Array.isArray(d.jinxes) && d.jinxes.length) return true;
    if (d.setup === true) return true;
    return false;
  }

  function isStarlight(d) {
    return !!(d && d.starlight);
  }

  /* Partial = any part of a finished almanac entry is still missing.
     Starlight always wins: an admin has looked at the page, so it is never
     also flagged unfinished.

     Only characters can be Partial. The `ability` check is what enforces
     that: every character has one (the API rejects a save without it) and no
     collection or script does, so passing a collection here can never come
     back true even when the caller forgets to say what type it is. Without
     this guard every collection and script would read as unfinished, because
     none of them have tags or almanac text. */
  function isPartial(d) {
    if (!d || isStarlight(d)) return false;
    if (!nonEmpty(d.ability)) return false;
    // Rules pages (Fabled) are finished at one line of text — see RULES_TEAMS.
    if (isRulesPage(d)) return false;
    return unmet(d, STANDARD_REQUIREMENTS).length > 0;
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
     Partial banner, the editor's "this page is unfinished" popup and the
     admin page list. */
  function missingBits(d) { return unmet(d, STANDARD_REQUIREMENTS); }

  var LABELS = {
    partial: 'Partial',
    standard: 'Standard',
    starlight: 'Starlight'
  };
  var DESCRIPTIONS = {
    partial: 'Unfinished — still missing part of its almanac entry. Hidden ' +
             'from browsing unless the “Partial” filter is on.',
    standard: 'A normal, complete page.',
    starlight: 'Awarded by the wiki admins. Shown more often on the homepage ' +
               'and in Featured picks.'
  };

  /* Marks for grids and page headers. Standard pages get nothing — that is
     the whole point of Standard.

     Starlight is a bare star that inherits the surrounding text colour, so
     it reads as part of the title rather than a pill bolted onto it. Partial
     stays a word because "unfinished" is not something a glyph can say. */
  function classBadgeHTML(cls, opts) {
    if (cls === 'starlight') {
      var title = (opts && opts.from)
        ? 'Starlight — part of the ' + String(opts.from).replace(/"/g, '&quot;') + ' collection.'
        : DESCRIPTIONS.starlight;
      return '<span class="starlight-star" title="' + title.replace(/"/g, '&quot;') +
        '" aria-label="Starlight">\u2726</span>';
    }
    if (cls === 'partial') {
      return '<span class="page-class page-class-partial" title="' +
        DESCRIPTIONS.partial.replace(/"/g, '&quot;') + '">' + LABELS.partial + '</span>';
    }
    return '';
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

  /* Everything a reader should see by default: drops Partial pages. Only
     characters are ever dropped — `type` is accepted for clarity at the call
     site, but isPartial() is self-guarding either way. */
  function eligible(list, type) {
    if (type && type !== 'character') return (list || []).slice();
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
    hasMechanics: hasMechanics,
    needsIcon: needsIcon, isRulesPage: isRulesPage, RULES_TEAMS: RULES_TEAMS,
    listHasText: listHasText, listPhrase: listPhrase,
    canPublish: canPublish, missingForPublish: missingForPublish,
    PUBLISH_REQUIREMENTS: PUBLISH_REQUIREMENTS,
    STANDARD_REQUIREMENTS: STANDARD_REQUIREMENTS,
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
