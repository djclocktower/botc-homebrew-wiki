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

  /* ── is this character one of the official roster? ──
     The wiki is for homebrew. An official character has a page on the official
     wiki, its art belongs to The Pandemonium Institute, and a copy here is a
     duplicate that fragments search, steals the name from anyone writing a
     real homebrew character of that name, and misrepresents whose work it is.
     So nothing on this wiki may be one: the character editors, the mass
     uploader, the Bloodstar importer and the admin sweep all ask this.

     The name has to match, and then the ability decides how sure we are:
       exact  the ability is the official one too, so this IS that character
       named  the name is shared but the ability is not — a different
              character wearing a familiar name, which is ordinary homebrew
              (this wiki has a Pope and a Nightwatchman that are nothing like
              the official ones) and is never refused on this basis alone.

     Only `exact` is ever acted on automatically. `named` is reported so a
     person can look, because the line between "reworked" and "retyped from
     memory" is a judgement no comparison can make. */

  /* Abilities are compared on words alone. The official cards write "&" where
     almost everyone typing one writes "and", and dropping the punctuation
     without translating it makes the two look different when they are the same
     sentence: the official Dreamer arrived through the Bloodstar importer as
     homebrew for exactly that reason, because "1 good & 1 evil" and "1 good
     and 1 evil" folded to "1good1evil" and "1goodand1evil". Numbers are left
     alone — "choose 2 players" and "choose 3 players" are different rules. */
  function abilityKey(s) {
    return String(s || '').toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /* `roster` is what buildOfficialRoles() returned. Returns null for homebrew,
     or {role, match: 'exact'|'named'}. */
  function officialMatch(roster, ch) {
    if (!ch || !ch.name) return null;
    var want = key(ch.name);
    if (!want) return null;
    for (var i = 0; i < (roster || []).length; i++) {
      var r = roster[i];
      if (!r || key(r.name) !== want) continue;
      return { role: r, match: abilityKey(r.ability) === abilityKey(ch.ability) ? 'exact' : 'named' };
    }
    return null;
  }

  /* The one sentence every caller shows when it refuses. Kept here so the
     editor, the API and the importer word it the same way. */
  function officialRefusal(role) {
    return '"' + (role && role.name ? role.name : 'That character') +
      '" is an official Blood on the Clocktower character, so it cannot have a page on this wiki. ' +
      'Scripts can still use it — it is on the official wiki, and a script page here links straight to it. ' +
      'If yours is a different character that happens to share the name, change the ability so it is not word-for-word the official one.';
  }

  var api = {
    buildOfficialRoles: buildOfficialRoles,
    cleanReminder: cleanReminder,
    officialKey: key,
    abilityKey: abilityKey,
    officialMatch: officialMatch,
    officialRefusal: officialRefusal
  };
  if (typeof window !== 'undefined') { window.OfficialRoles = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
