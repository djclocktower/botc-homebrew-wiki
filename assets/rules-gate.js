/* First-time rules agreement gate for the Create / Edit pages.

   Shows a modal with the site rules the first time someone opens an editor,
   with a checkbox they must tick before continuing. The acknowledgement is
   stored per browser as the rules version they agreed to, so bumping
   BOTC_RULES_VERSION in assets/rules.js re-prompts everyone.

   Load AFTER assets/rules.js. */
(function () {
  'use strict';

  var ACK_KEY = 'botc_rules_ack';
  var version = window.BOTC_RULES_VERSION || '';

  function ackedVersion() {
    try { return localStorage.getItem(ACK_KEY) || ''; } catch (e) { return ''; }
  }
  function setAcked() {
    try { localStorage.setItem(ACK_KEY, version); } catch (e) {}
  }

  // Nothing to show if rules.js failed to load, or they already agreed to
  // this exact version.
  if (!version || typeof window.renderRulesHTML !== 'function') return;
  if (ackedVersion() === version) return;

  // ROOT mirrors site.js: '' on root pages, '../' on server-rendered pages.
  var ROOT = (function () {
    var s = document.querySelector('link[rel="stylesheet"]');
    if (!s) return '';
    return s.getAttribute('href').replace('assets/styles.css', '');
  })();

  function build() {
    var overlay = document.createElement('div');
    overlay.className = 'rules-modal open';
    overlay.id = 'rules-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'rules-modal-title');
    overlay.innerHTML =
      '<div class="rules-modal-card">' +
        '<h2 class="rules-modal-title" id="rules-modal-title">Before you start</h2>' +
        '<p class="rules-modal-intro">Please read the wiki rules. You only need to ' +
          'do this once — you can read them again any time on the ' +
          '<a href="' + ROOT + 'rules">rules page</a>.</p>' +
        window.renderRulesHTML() +
        '<label class="rules-agree"><input type="checkbox" id="rules-agree-box">' +
          '<span>I have read and agree to follow these rules.</span></label>' +
        '<div class="rules-modal-actions">' +
          '<a class="rules-btn-cancel" href="' + (ROOT || '/') + '">Cancel</a>' +
          '<button type="button" class="rules-btn-go" id="rules-continue" disabled>Continue</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var box = overlay.querySelector('#rules-agree-box');
    var go = overlay.querySelector('#rules-continue');
    box.addEventListener('change', function () { go.disabled = !box.checked; });
    go.addEventListener('click', function () {
      if (!box.checked) return;
      setAcked();
      overlay.remove();
      document.body.classList.remove('rules-modal-lock');
    });

    document.body.classList.add('rules-modal-lock');
    box.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
