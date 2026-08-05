/* Post-save notices for the character editors (create.html, edit.html).

   /api/character answers every save with the page's classification and, if
   it is Partial, which pieces are still missing. This turns that into a
   modal the owner actually reads, because a Partial page is invisible in
   browsing and people would otherwise assume their page had failed to save.

   It also handles the icon rule: if the Worker downgraded a publish attempt
   to a draft because there is no icon, that is what the modal leads with.

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

  var MISSING_LABEL = {
    icon: 'an icon',
    tags: 'at least one tag',
    almanac: 'some almanac text — a lede, a bullet point, a How to Run paragraph, an example, anything'
  };

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

    // The icon rule bit: a publish that came back as a draft.
    if (result.iconBlocked) {
      modal('Saved as a draft — no icon yet',
        '<p class="rules-modal-intro">A character page needs an icon before it can go ' +
        'live on the wiki, so this was saved as a <strong>draft</strong>.</p>' +
        '<ul class="rules-list"><li>Upload character art in the editor above.</li>' +
        '<li>Then press Publish again, it will go live straight away.</li></ul>' +
        '<p class="rules-modal-intro" style="margin-top:14px">Drafts are visible ' +
        'only to you and the wiki admins. You can find yours any time on your ' +
        '<a href="account">account page</a>.</p>',
        'Add an icon');
      return;
    }

    if (result.classification !== 'partial') return;
    if (shownFor[slug]) return;
    shownFor[slug] = true;

    var missing = (result.missing || []).filter(function (m) { return m !== 'icon'; });
    var list = missing.length
      ? '<ul class="rules-list">' + missing.map(function (m) {
          return '<li>' + MISSING_LABEL[m] + '</li>';
        }).join('') + '</ul>'
      : '';

    modal('Your page is saved — but it counts as Partial',
      '<p class="rules-modal-intro">Your page is live and its own URL works, ' +
      'but right now it only has an ability and an icon. Pages like that are ' +
      'marked <strong>Partial</strong>, and Partial pages:</p>' +
      '<ul class="rules-list">' +
        '<li>do <strong>not</strong> show up when people browse All Characters, ' +
          'unless they tick the “Show Partial” filter;</li>' +
        '<li>do <strong>not</strong> appear on the tag, team or creator pages;</li>' +
        '<li>are never picked for Featured Character or the homepage.</li>' +
      '</ul>' +
      '<p class="rules-modal-intro" style="margin-top:14px">To become a normal ' +
      '(Standard) page it just needs <strong>one</strong> of these:</p>' +
      list +
      '<p class="rules-modal-intro" style="margin-top:14px">Add either and save ' +
      'again — the page upgrades itself immediately, no waiting and nothing to ' +
      'apply for.</p>',
      'Got it');
  }

  window.showSaveNotice = showSaveNotice;
})();
