/* ══════════════════════════════════════════════════════════════════
   Site rules — SINGLE SOURCE OF TRUTH.

   Edit ONLY the RULES array below. The text flows automatically to:
     • the Rules section on the homepage (index.html)
     • the standalone /rules page (rules.html)
     • the first-time agreement pop-up on Create/Edit (assets/rules-gate.js)

   If you change the rules in a way people need to re-read, bump
   RULES_VERSION. Everyone is then asked to tick the agreement box again
   the next time they open Create or Edit.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var RULES_VERSION = '2026-07-28';

  /* ⚠ PLACEHOLDER TEXT — replace with the real rules.
     Each entry: { title: 'Short heading', body: 'One or two sentences.' } */
  var RULES = [
    {
      title: 'Credit the artist',
      body: 'Only upload art you made or have permission to use, and name the ' +
            'original artist in the Icon by field. Do not upload AI-generated art ' +
            'as someone else’s work.'
    },
    {
      title: 'Keep it appropriate',
      body: 'No NSFW, hateful, or harassing content. This wiki is a shared space ' +
            'for a game a lot of people play with their friends and family.'
    },
    {
      title: 'Edit your own pages',
      body: 'Do not edit or delete someone else’s character, script, or ' +
            'collection without their say-so. Use the report button if a page ' +
            'needs an admin to look at it.'
    },
    {
      title: 'Write a complete character',
      body: 'Give every character an ability, a team, and enough How to Run detail ' +
            'that a Storyteller could actually run it at the table.'
    },
    {
      title: 'Do not impersonate',
      body: 'Do not publish official Pandemonium Institute characters as homebrew, ' +
            'and do not post under someone else’s creator name.'
    },
    {
      title: 'Admins have the final say',
      body: 'Pages that break these rules may be edited, unpublished, or removed, ' +
            'and repeat offenders may lose posting access.'
    }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* Returns the rules as an <ol>. Callers drop it straight into innerHTML. */
  function renderRulesHTML() {
    return '<ol class="rules-list">' + RULES.map(function (r) {
      return '<li class="rules-item">' +
        '<span class="rules-item-title">' + esc(r.title) + '</span>' +
        '<span class="rules-item-body">' + esc(r.body) + '</span>' +
        '</li>';
    }).join('') + '</ol>';
  }

  window.BOTC_RULES_VERSION = RULES_VERSION;
  window.BOTC_RULES = RULES;
  window.renderRulesHTML = renderRulesHTML;
})();
