/* assets/import-merge.js — what a re-import keeps and what it replaces.

   mass-upload.html lands a file's characters on pages, and a page that
   already exists on this account is UPDATED rather than made again — that is
   how re-running an import works. What "updated" means is decided here, in
   one place with no DOM and no fetch (the same split as bloodstar.js and
   grimforge.js), because the first answer was the wrong one: the page was
   replaced with only what the file carried, and the file's picture was
   written over the icon in the page's art slot. A creator who had made
   icons in Icon Forge, tagged the pages, saved printable tokens and then
   re-imported the original script JSON lost all of it in one click.

   The rule: the file is the source of the character's MECHANICS — name,
   team, ability, night order, reminders, setup flags, jinxes — so those
   always come from it, the empties included (a file with no jinxes means no
   jinxes). Everything else on the page is the page's, and stays: tags,
   almanac text, sidebar boxes, the printable token, the art slots, who may
   edit it, its publish state. Prose the file may or may not carry (flavour,
   edition) is taken only when it actually does, or a file with no flavour
   line would blank one typed on the wiki. The run's Creator and Appears-in
   boxes win when they are filled in, as the form says, and leave the page's
   own alone when they are not.

   Browser + Node (the tests run it in a vm). */
(function (root) {
  'use strict';

  var MECHANICS = ['name', 'team', 'ability', 'firstNight', 'firstNightReminder',
    'otherNight', 'otherNightReminder', 'reminders', 'remindersGlobal', 'setup',
    'special', 'jinxes'];
  var IF_PRESENT = ['quote', 'edition'];

  function pageData(page) {
    return page && page.data && typeof page.data === 'object' ? page.data : null;
  }

  // merge(page, fromFile, opts) -> the object to POST to /api/character.
  //   page:     the /api/page response for the page being updated, or null
  //             for a new one
  //   fromFile: what the file says (the entry the uploader built from the
  //             JSON: identity, mechanics, flavour, edition)
  //   opts:     the run's options — creator, appearsIn, status
  function merge(page, fromFile, opts) {
    opts = opts || {};
    var data = pageData(page);
    if (!data) {
      // A new page is exactly what the file says, under the run's options.
      var fresh = Object.assign({}, fromFile);
      fresh.creator = opts.creator || '';
      fresh.appearsIn = opts.appearsIn || '';
      fresh.status = opts.status === 'draft' ? 'draft' : 'published';
      return fresh;
    }
    var out = Object.assign({}, data, { slug: fromFile.slug });
    MECHANICS.forEach(function (k) { out[k] = fromFile[k]; });
    IF_PRESENT.forEach(function (k) { if (fromFile[k]) out[k] = fromFile[k]; });
    if (opts.creator) out.creator = opts.creator;
    if (opts.appearsIn) out.appearsIn = opts.appearsIn;
    // A page that exists keeps its publish state. The form's choice is for
    // the pages this run creates; publishing a page is its own act.
    out.status = page.status === 'draft' ? 'draft' : 'published';
    // So the Worker can refuse a save built on a copy somebody else has
    // since saved over (see editConflict in worker.js).
    if (page.updatedAt) out.baseUpdatedAt = page.updatedAt;
    // Derived on read, never stored — the save handler drops it too.
    delete out.appearsInFrom;
    return out;
  }

  // Which of the three art slots the file may write. A slot the page already
  // fills is left alone unless the run asked to replace the art; an empty
  // one takes the file's picture either way, because a page with no icon
  // cannot be published and the file is offering one.
  function artPlan(page, opts) {
    var d = pageData(page);
    var replace = !!(opts && opts.replaceArt);
    var has = function (rel, abs) { return !!(d && (d[rel] || d[abs])); };
    return {
      main: !d || replace || !has('art', 'image'),
      alt: !d || replace || !has('artAlt', 'imageAlt'),
      alt2: !d || replace || !has('artAlt2', 'imageAlt2')
    };
  }

  var api = { merge: merge, artPlan: artPlan, MECHANICS: MECHANICS, IF_PRESENT: IF_PRESENT };
  root.ImportMerge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
