/* BotcDialog: one modal helper for the whole site.

   Makes an element that is ALREADY in the document behave as a modal
   dialog: role="dialog" + aria-modal, focus moved inside it, Tab and
   Shift+Tab kept inside it, Escape closing it (unless the dialog must be
   answered), and focus handed back to whatever opened it when it closes.

     var dlg = window.BotcDialog ? BotcDialog.open(el, {
       initialFocus: element | selector,  // default: the first focusable in el
       onClose: function (result) {},     // called once, after focus returns
       closeOnEscape: true,               // false for a must-answer dialog
       escapeResult: null                 // what onClose gets on Escape
     }) : null;
     ...
     dlg && dlg.close(result);            // idempotent

   It deliberately does NOT remove the element, and does not touch the
   page's scroll lock: every caller keeps its own removal and its own
   rules-modal-lock / body overflow handling, so adopting it changes
   nothing a reader can see. Callers test for window.BotcDialog first, so a
   page that never loaded this file behaves exactly as it did before.

   It does not mark the rest of the page `inert` either: one caller that
   forgot to close would leave the whole page dead. The Tab trap is enough.

   Adopted by rules-gate.js, editor-notices.js, comments.js (the comment
   guidelines), art-adjust.js and token-tool.js (the per-token editor).
   Not by iconforge/editor.js (Escape belongs to miniPaint's tools inside
   its iframe) or text-live.js (an admin popover, not a modal). */
(function () {
  'use strict';

  var TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // The next index in a ring of `count` items, going forward or back.
  function cycle(count, index, back) {
    if (count <= 0) return -1;
    if (back) return index <= 0 ? count - 1 : index - 1;
    return index >= count - 1 ? 0 : index + 1;
  }

  function visible(node) {
    if (node.offsetParent !== null) return true;
    try { return window.getComputedStyle(node).position === 'fixed'; } catch (e) { return false; }
  }

  function tabbables(el) {
    return Array.prototype.filter.call(el.querySelectorAll(TABBABLE), visible);
  }

  function open(el, opts) {
    opts = opts || {};
    var opener = document.activeElement;
    var closed = false;
    var closeOnEscape = opts.closeOnEscape !== false;
    var escapeResult = 'escapeResult' in opts ? opts.escapeResult : null;

    if (!el.getAttribute('role')) el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');

    function focusEl(node) {
      if (!node) return false;
      try { node.focus(); } catch (e) { return false; }
      return document.activeElement === node;
    }
    function focusFirst() {
      var want = opts.initialFocus;
      if (typeof want === 'string') want = el.querySelector(want);
      if (want && focusEl(want)) return;
      var list = tabbables(el);
      if (list.length && focusEl(list[0])) return;
      // Nothing focusable inside: focus the dialog itself so Tab still
      // starts from inside it.
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      focusEl(el);
    }

    function onKey(e) {
      if (closed) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (!closeOnEscape) return;
        e.preventDefault();
        e.stopPropagation();
        close(escapeResult);
        return;
      }
      if (e.key !== 'Tab') return;
      var list = tabbables(el);
      if (!list.length) { e.preventDefault(); focusEl(el); return; }
      var at = list.indexOf(document.activeElement);
      // Focus outside the dialog (or on the dialog itself): bring it back in.
      if (at === -1) {
        e.preventDefault();
        focusEl(list[e.shiftKey ? list.length - 1 : 0]);
        return;
      }
      // Only the two ends need help; between them the browser's own Tab
      // order is already right.
      if ((!e.shiftKey && at === list.length - 1) || (e.shiftKey && at === 0)) {
        e.preventDefault();
        focusEl(list[cycle(list.length, at, e.shiftKey)]);
      }
    }
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener.focus && document.contains(opener) && opener !== document.body) {
        try { opener.focus(); } catch (e) {}
      }
      if (typeof opts.onClose === 'function') opts.onClose(result);
    }

    document.addEventListener('keydown', onKey, true);
    focusFirst();
    return { close: close, element: el };
  }

  window.BotcDialog = { open: open, _cycle: cycle };
})();
