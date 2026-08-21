/* official-roles.js: the official BotC roster, as wiki character objects.
 *
 * Scripts can carry official characters alongside homebrew ones (a roster
 * slug of 'off-{id}'), and three places have to turn `assets/roles.json` into
 * something the wiki's renderers understand: the Worker (SSR /s/ pages),
 * script.html (the builder) and publish-script.html (the roster summary and
 * the night-order arranger). This is that conversion, once.
 *
 * The night order is why this file exists rather than three copies of a
 * five-line map. roles.json carries abilities, art and the night REMINDERS but
 * no wake POSITIONS, so official characters came out with firstNight and
 * otherNight of 0 (the wiki's way of saying "does not wake") and a script
 * page's Night Order box left every one of them out. The positions live in
 * assets/night-order.json; this merges the two by name. All 120 official
 * characters that wake are in both files, and a name that fails to match
 * simply keeps 0, as before.
 *
 * Browser + Worker: no DOM, no fetch. Callers hand in the two parsed JSON
 * files and decide where the result goes (the builder deliberately keeps
 * officials out of its Add sidebar, for one).
 */
(function () {
  'use strict';

  function key(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /* ':reminder:' marks where a reminder token is placed in the official app's
     night sheet. There is no token to place in a night-order LIST, so it is
     dropped for display; '*YOU ARE*' and friends are left alone, because the
     asterisks are how the official text marks an info token and readers of
     the night order know them. */
  function cleanReminder(s) {
    return String(s || '').replace(/:reminder:/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  /* name/id -> {firstNight, otherNight} from assets/night-order.json. */
  function nightMap(nightOrder) {
    var rows = (nightOrder && nightOrder.characters) || [];
    var m = {};
    rows.forEach(function (r) {
      if (!r || !r.name) return;
      m[key(r.name)] = { firstNight: Number(r.firstNight) || 0, otherNight: Number(r.otherNight) || 0 };
    });
    return m;
  }

  /* roles.json (+ night-order.json, optional) -> wiki character objects.
     `page` points at the official wiki, because these characters have no page
     here and never will. */
  function buildOfficialRoles(roles, nightOrder) {
    var nights = nightMap(nightOrder);
    return (roles || []).filter(function (r) { return r && r.id; }).map(function (r) {
      var n = nights[key(r.name || r.id)] || nights[key(r.id)] || { firstNight: 0, otherNight: 0 };
      return {
        slug: 'off-' + key(r.id),
        // jsonId keeps the official id when a script has to export this
        // character as a full object rather than a bare id (which happens
        // when the script gives it a jinx of its own). The app matches
        // characters by id, so inventing one from the name would break it.
        official: true, id: r.id, jsonId: r.id,
        name: r.name || r.id, team: r.team || '',
        ability: r.ability || '', image: r.image || '',
        edition: r.edition || '',
        firstNight: n.firstNight, otherNight: n.otherNight,
        firstNightReminder: cleanReminder(r.firstNightReminder),
        otherNightReminder: cleanReminder(r.otherNightReminder),
        page: 'https://wiki.bloodontheclocktower.com/' +
          encodeURIComponent(String(r.name || r.id).replace(/ /g, '_'))
      };
    });
  }

  var api = {
    buildOfficialRoles: buildOfficialRoles,
    cleanReminder: cleanReminder,
    officialKey: key
  };
  if (typeof window !== 'undefined') { window.OfficialRoles = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
