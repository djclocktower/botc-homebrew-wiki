/* ══════════════════════════════════════════════════════════════════
   Site rules — SINGLE SOURCE OF TRUTH.

   Edit ONLY the RULES array below. The text flows automatically to:
     • the Rules section on the homepage (index.html)
     • the standalone /rules page (rules.html)
     • the first-time agreement pop-up on Create/Edit (assets/rules-gate.js)

   To ADD a rule: copy one of the blocks below and change the two lines.
   The "title" is the bold heading, the "body" is the smaller text under it.
   Mind the commas — every block ends with }, except the last one.

   If you change the rules in a way people need to re-read, increase
   RULES_VERSION by 1 (keep the quote marks). Everyone is then asked to
   tick the agreement box again the next time they open Create or Edit.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var RULES_VERSION = '2';

  var RULES = [
    {
      title: 'English only please!',
      body: 'This is an English language wiki. For character collections in ' +
            'different languages, consider asking the community for help ' +
            'translating to English, or hosting on Bloodstar or Klutzbanana.'
    },
    {
      title: 'All characters must have icons.',
      body: 'We recommend using Iconforge for creating character icons.'
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
