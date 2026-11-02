/* assets/char-icon-save.js: put a finished icon on one of your characters.
 * Shared by Icon Forge and the Starlit Gallery so the two cannot drift.
 *
 * CharIconSave.list() -> the signed-in account's characters, drafts included
 *   ([{slug, name, status}]), or null when nobody is signed in.
 * CharIconSave.save(slug, pngDataUrl, {iconBy, confirmReplace}) uploads the
 *   picture to art/{identity}.png (the slot the character editor writes) and
 *   saves the row back pointing at it, with its status unchanged, so a draft
 *   stays a draft. Resolves with the page's identity; rejects with a message.
 *   The Worker checks permission on both calls; this only decides what to ask.
 * Browser only.
 */
(function () {
  'use strict';

  function json(r) { return r.json().catch(function () { return {}; }); }
  function post(path, body) {
    return fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(json);
  }

  function list() {
    return fetch('/api/account', { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) return null;
      return json(r).then(function (acc) {
        if (!acc || acc.error) throw new Error((acc && acc.error) || 'Your characters could not be loaded.');
        return (acc.characters || []).map(function (c) {
          return { slug: c.slug, name: c.name || 'Untitled character', status: c.status };
        });
      });
    });
  }

  function save(slug, dataUrl, opts) {
    opts = opts || {};
    var page, key;
    return fetch('/api/page?type=character&slug=' + encodeURIComponent(slug), { credentials: 'same-origin' })
      .then(json)
      .then(function (p) {
        if (!p || p.error) throw new Error((p && p.error) || 'Could not load that character.');
        if (!p.canEdit) throw new Error('That character belongs to another account.');
        page = p;
        var d = p.data || {};
        if ((d.art || d.image) && opts.confirmReplace && !opts.confirmReplace(d.name || p.slug)) return null;
        key = 'art/' + p.slug + '.png';
        return post('/api/upload', { key: key, data: dataUrl }).then(function (up) {
          if (!up || up.error) throw new Error((up && up.error) || 'The upload failed.');
          // The card thumbnail rides along (assets/art-thumb.js); never awaited.
          if (window.ArtThumb) window.ArtThumb.upload(key, dataUrl);
          var entry = Object.assign({}, d, {
            slug: p.slug, art: key, image: 'https://botchomebrew.wiki/assets/' + key, status: p.status
          });
          // An older row may hold its alternate icons only as positions two and
          // three of an `image` ARRAY ("A character's three icons" in
          // CLAUDE.md). `image` becomes the new icon's string, so those move to
          // their own fields first, or a traveller's good and evil art is lost.
          if (Array.isArray(d.image)) {
            ['imageAlt', 'imageAlt2'].forEach(function (field, i) {
              var was = d.image[i + 1];
              if (typeof was === 'string' && was && !entry[field]) entry[field] = was;
            });
          }
          // Credit the art, unless the page already credits somebody else.
          if (opts.iconBy && (!String(d.iconBy || '').trim() || d.iconBy === opts.iconBy)) entry.iconBy = opts.iconBy;
          return post('/api/character', entry);
        }).then(function (saved) {
          if (!saved || saved.error) throw new Error((saved && saved.error) || 'The character could not be saved.');
          return page.slug;
        });
      });
  }

  window.CharIconSave = { list: list, save: save };
})();
