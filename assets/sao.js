/* Steven Approved Order (SAO) — shared sort logic.
   Used by the Script Builder (script.html), the publish page
   (publish-script.html) and steven-approved-order.html, and safe to bundle
   into the Worker (no DOM access at top level).
   The prefix order is semantic: more-specific prefixes ("Each night*") must
   come before less-specific ones ("Each night"). Do not reorder casually —
   steven-approved-order.html renders this exact list. */
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

  var TEAM_ORDER = ['townsfolk', 'outsider', 'minion', 'demon', 'traveller', 'fabled'];

  function saoRank(ability) {
    var a = (ability || '').trim();
    for (var i = 0; i < SAO_PREFIXES.length; i++) {
      if (i === SAO_ANYTHING_ELSE_IDX) continue; // skip Atheist in prefix scan
      if (a.indexOf(SAO_PREFIXES[i]) === 0) return i;
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
