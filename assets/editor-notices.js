/* Post-save notices for the character editors (create.html, edit.html).

   /api/character answers every save with the page's classification and, if
   it is Partial, which pieces are still missing. This turns that into a
   modal the owner actually reads, because a Partial page is invisible in
   browsing and people would otherwise assume their page had failed to save.

   It also handles the publish bar: if the Worker downgraded a publish attempt
   to a draft because the page is missing a name, an icon, an ability or tags,
   that is what the modal leads with.

   Load after assets/classify.js (for the labels) — it degrades to plain
   text if classify.js is missing. */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Only nag once per page per editing session — saving four times in a row
  // while adding almanac text should not mean four modals.
  var shownFor = {};

  // classify.js hands back ready-made phrases ("an icon", "how to run"), so
  // there is nothing to translate here any more — just a joiner for the
  // "needs a, b and c" sentence.
  function phrase(items) {
    if (window.Classify && window.Classify.listPhrase) return window.Classify.listPhrase(items);
    return (items || []).join(', ');
  }

  function modal(title, bodyHTML, buttonLabel) {
    var overlay = document.createElement('div');
    overlay.className = 'rules-modal open';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'unfinished-title');
    overlay.innerHTML =
      '<div class="rules-modal-card">' +
        '<h2 class="rules-modal-title" id="unfinished-title">' + esc(title) + '</h2>' +
        bodyHTML +
        '<div class="rules-modal-actions">' +
          '<button type="button" class="rules-btn-go" id="unfinished-ok">' +
            esc(buttonLabel || 'Got it') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.classList.add('rules-modal-lock');
    function close() {
      overlay.remove();
      document.body.classList.remove('rules-modal-lock');
    }
    overlay.querySelector('#unfinished-ok').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#unfinished-ok').focus();
  }

  /* Call with the JSON body /api/character returned, plus the slug. */
  function showSaveNotice(result, slug) {
    if (!result) return;

    // The publish bar bit: a publish that came back as a draft.
    if (result.iconBlocked) {
      var need = result.missingForPublish || [];
      modal('Saved as a draft',
        '<p class="rules-modal-intro">Before a character can go live it needs ' +
        '<strong>' + esc(phrase(need) || 'a name, an icon, an ability and tags') +
        '</strong>, so this was saved as a <strong>draft</strong>.</p>' +
        '<ul class="rules-list"><li>Add that in the editor above.</li>' +
        '<li>Then press Publish again — it goes live straight away.</li></ul>' +
        '<p class="rules-modal-intro" style="margin-top:14px">Drafts are visible ' +
        'only to you and the wiki admins. You can find yours any time on your ' +
        '<a href="drafts">drafts page</a>.</p>',
        'Fix it');
      return;
    }

    if (result.classification !== 'partial') return;
    if (shownFor[slug]) return;
    shownFor[slug] = true;

    var missing = result.missing || [];
    var list = missing.length
      ? '<ul class="rules-list">' + missing.map(function (m) {
          return '<li>' + esc(m) + '</li>';
        }).join('') + '</ul>'
      : '';

    modal('Saved — but this page counts as Partial',
      '<p class="rules-modal-intro">It is live and its own URL works, but a ' +
      '<strong>Partial</strong> page doesn\u2019t show on the homepage or in ' +
      'the All Characters search.</p>' +
      '<p class="rules-modal-intro">Still to add:</p>' +
      list +
      '<p class="rules-modal-intro" style="margin-top:14px">Add them and save ' +
      'again — the page upgrades itself immediately.</p>',
      'Got it');
  }

  window.showSaveNotice = showSaveNotice;
})();
