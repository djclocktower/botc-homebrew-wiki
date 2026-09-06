/* Steven Approved Order (SAO) — shared sort logic.
   Used by the Script Builder (script.html), the publish page
   (publish-script.html) and steven-approved-order.html, and safe to bundle
   into the Worker (no DOM access at top level).
   SAO_PREFIXES is the SORT order, and steven-approved-order.html renders this
   exact list, so it is written the way the order reads: "Each night" above
   "Each night*". It is NOT the order they are matched in — see SAO_SCAN. */
(function () {
  var SAO_PREFIXES = [
    'Hermit',
    'You start knowing',
    'At night',
    'Each dusk*',
    'Each night',
    'Each night*',
    'Each day',
    'Once per game, at night',
    'Once per game, at night*',
    'Once per game, during the day',
    'Once per game',
    'On your 1st night',
    'On your 1st day',
    'On',
    'You think',
    'You are',
    'You have',
    'You do not know',
    'You might',
    'You',
    'When you die',
    'When you learn that you died',
    'When',
    'If you die',
    'If you died',
    'If you are "mad"',
    'If you',
    'If the Demon dies',
    'If the Demon kills',
    'If the Demon',
    'If both',
    'If there are 5 or more players alive',
    'If',
    'All players',
    'All',
    'The 1st time',
    'The',
    'Good',
    'Evil',
    'Players',
    'Minions',
    'Atheist'
  ];
  var SAO_ANYTHING_ELSE_IDX = SAO_PREFIXES.indexOf('Atheist'); // slot just before Atheist

  /* Matching order, which is not the sort order. The scan takes the first
     prefix an ability starts with, and EVERY "Each night*, ..." ability also
     starts with "Each night" — so the asterisked ones were ranked as plain
     "Each night" and the two groups interleaved, sorted only by how long the
     ability happened to be. ("Once per game, at night*" had it too.)
     Two prefixes can both match one ability only when one is a prefix of the
     other, so testing the LONGEST first always picks the most specific — and
     it keeps working however the list above is later rewritten, which is what
     an ordering rule written in a comment could not do. Ties keep the list's
     own order; Atheist stays out of the scan, as it always has. */
  var SAO_SCAN = SAO_PREFIXES
    .map(function (p, i) { return i; })
    .filter(function (i) { return i !== SAO_ANYTHING_ELSE_IDX; })
    .sort(function (x, y) {
      return (SAO_PREFIXES[y].length - SAO_PREFIXES[x].length) || (x - y);
    });

  var TEAM_ORDER = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled', 'loric'];

  function saoRank(ability) {
    var a = (ability || '').trim();
    for (var i = 0; i < SAO_SCAN.length; i++) {
      if (a.indexOf(SAO_PREFIXES[SAO_SCAN[i]]) === 0) return SAO_SCAN[i];
    }
    // <Anything else> gets the index just before Atheist
    return SAO_ANYTHING_ELSE_IDX;
  }

  function saoCompare(a, b) {
    var ra = saoRank(a.ability), rb = saoRank(b.ability);
    if (ra !== rb) return ra - rb;
    var la = (a.ability || '').length, lb = (b.ability || '').length;
    if (la !== lb) return la - lb;
    var na = (a.name || '').length, nb = (b.name || '').length;
    if (na !== nb) return na - nb;
    return (a.name || '').localeCompare(b.name || '');
  }

  /* Sort a roster of character slugs: group by team (TEAM_ORDER), SAO-sort
     within each group, unknown teams after, then slugs with no matching
     character object last in their original order (never dropped). */
  function sortRosterSAO(slugs, bySlug) {
    var byTeam = {};
    TEAM_ORDER.forEach(function (t) { byTeam[t] = []; });
    var unknownTeam = [], unresolved = [];
    (slugs || []).forEach(function (slug) {
      var c = bySlug[slug];
      if (!c) { unresolved.push(slug); return; }
      if (byTeam[c.team]) byTeam[c.team].push(c);
      else unknownTeam.push(c);
    });
    var sorted = [];
    TEAM_ORDER.forEach(function (t) {
      byTeam[t].sort(saoCompare);
      sorted = sorted.concat(byTeam[t].map(function (c) { return c.slug; }));
    });
    unknownTeam.sort(saoCompare);
    sorted = sorted.concat(unknownTeam.map(function (c) { return c.slug; }));
    return sorted.concat(unresolved);
  }

  if (typeof window !== 'undefined') {
    window.SAO_PREFIXES = SAO_PREFIXES;
    window.saoRank = saoRank;
    window.saoCompare = saoCompare;
    window.sortRosterSAO = sortRosterSAO;
    window.SAO_TEAM_ORDER = TEAM_ORDER;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SAO_PREFIXES: SAO_PREFIXES, saoRank: saoRank, saoCompare: saoCompare,
      sortRosterSAO: sortRosterSAO, TEAM_ORDER: TEAM_ORDER
    };
  }
})();
