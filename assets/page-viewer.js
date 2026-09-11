/* Private controls are fetched separately from the shared published HTML. */
(function () {
  if (!window.botcMePromise || !window.PAGE_TYPE || !window.PAGE_SLUG) return;
  window.botcMePromise.then(function (me) {
    if (!me || !me.loggedIn) return;
    return fetch('/api/page-viewer?type=' + encodeURIComponent(window.PAGE_TYPE) +
      '&slug=' + encodeURIComponent(window.PAGE_SLUG), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('Viewer controls unavailable'); return r.json(); })
      .then(function (data) {
        if (data.notice && !document.querySelector('.page-notice-partial')) {
          var holder = document.createElement('div'); holder.innerHTML = data.notice;
          var note = holder.firstElementChild;
          var slug = note.getAttribute('data-partial-slug'), sig = note.getAttribute('data-partial-sig');
          var dismissed = {};
          try { dismissed = JSON.parse(localStorage.getItem('botc_partial_dismissed')) || {}; } catch (e) {}
          if (dismissed[slug] !== sig) {
            document.body.insertBefore(note, document.body.firstChild);
            note.querySelector('.page-notice-close').addEventListener('click', function () {
              dismissed[slug] = sig;
              var keys = Object.keys(dismissed); keys.slice(0, Math.max(0, keys.length - 200)).forEach(function(k){ delete dismissed[k]; });
              try { localStorage.setItem('botc_partial_dismissed', JSON.stringify(dismissed)); } catch (e) {}
              note.remove();
            });
          }
        }
        var controls = document.getElementById('page-owner-controls');
        if (controls && data.editHref) {
          controls.className = 'page-owner-bar';
          var edit = document.createElement('a'); edit.className = 'cta-secondary page-owner-edit';
          edit.href = data.editHref; edit.textContent = '✎ Edit this ' + window.PAGE_TYPE;
          controls.replaceChildren(edit);
        }
        var pages = document.getElementById('page-wiki-links');
        if (pages && data.pages !== null && data.pages !== undefined) {
          pages.innerHTML = data.pages;
        }
      });
  }).catch(function () { /* the content remains readable; editing is still reachable from the topbar */ });
})();
