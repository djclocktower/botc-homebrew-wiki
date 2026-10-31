/* assets/starlit-picker.js — "Browse the Starlit Gallery" in the character
 * editors (create.html and edit.html, which are the same form).
 *
 * Any button carrying data-starlit-into="{id of a file input}" opens the
 * gallery (/starlit?pick=1) over the page. The icon picked there comes back as
 * a PNG, is put into that file input and a change event is fired, so the
 * editor takes it exactly as if it had been picked from the device:
 * standardized, previewed, uploaded on save. It also fills the "Icon by" box,
 * when that is empty or holds an earlier pick, with the artist and a link
 * back to the icon, so the credit goes onto the character page with the art.
 *
 * Browser only.
 */
(function () {
  'use strict';

  var overlay = null, target = null;

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.documentElement.style.overflow = '';
  }
  function open(input) {
    if (input.disabled) { alert('The art on this page cannot be changed from here.'); return; }
    close();
    target = input;
    overlay = document.createElement('div');
    overlay.className = 'starlit-picker';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Starlit Gallery');
    overlay.innerHTML =
      '<div class="starlit-picker-bar"><span>Starlit Gallery</span>' +
      '<button type="button" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>' +
      '<iframe src="/starlit?pick=1" title="Starlit Gallery"></iframe>';
    overlay.querySelector('button').addEventListener('click', close);
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
  }

  function credit(d) {
    var box = document.getElementById('iconBy');
    if (!box || box.disabled || (box.value.trim() && box.value.indexOf('Starlit Gallery') < 0)) return;
    box.value = String(d.artist || '').replace(/[[\]()]/g, '').trim() +
      ' ([Starlit Gallery](/starlit?icon=' + encodeURIComponent(d.id) + '))';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  window.addEventListener('message', function (e) {
    var frame = overlay && overlay.querySelector('iframe');
    if (!frame || e.origin !== location.origin || e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.starlit !== 'pick' || !(d.blob instanceof Blob)) return;
    var name = String(d.name || 'icon').replace(/[^\p{L}\p{N}_-]+/gu, '_') + '.png';
    try {
      var dt = new DataTransfer();
      dt.items.add(new File([d.blob], name, { type: 'image/png' }));
      target.files = dt.files;
    } catch (err) {
      alert('This browser cannot take the icon straight from the gallery. Download it there, then pick the file here.');
      return;
    }
    target.dispatchEvent(new Event('change', { bubbles: true }));
    credit(d);
    close();
  });

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-starlit-into]');
    if (!b) return;
    var input = document.getElementById(b.getAttribute('data-starlit-into'));
    if (!input) return;
    e.preventDefault();
    open(input);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();
