/* assets/approved-editors.js — the "who else may edit this page" list.
 *
 * Approved editing is the third way a page can be opened up (see CLAUDE.md,
 * "Public editing"): instead of opening it to everyone with an account, the
 * creator names the accounts, and those accounts edit the page exactly as the
 * creator would. This widget is the naming half — one list, mounted by all
 * four editors (create.html, edit.html, publish-script.html,
 * publish-collection.html) so the three page types cannot drift apart.
 *
 * What it stores is what the Worker stores: an array of {id, username}. The
 * id is the authority — it is what every permission check reads and it
 * survives a change of handle — and the username is what this list shows
 * back. A handle typed into the box is resolved through /api/account-lookup
 * before it goes in the list, so the owner finds out here that they misspelled
 * somebody, rather than after a save.
 *
 * The Worker resolves the list again on save regardless. This is a courtesy,
 * never the check.
 *
 * Browser only.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var MAX = 20;   // matches PAGE_EDITORS_MAX in worker.js

  /* A stored list, however it reaches us: the {id, username} pairs the Worker
     wrote, or bare strings from a hand-edited row. Anything without a name is
     dropped — it could not be displayed or resolved. */
  function clean(list) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).forEach(function (e) {
      var name = typeof e === 'string' ? e
        : (e && typeof e === 'object' ? String(e.username || '') : '');
      name = name.trim().replace(/^@+/, '');
      if (!name) return;
      var key = name.toLowerCase();
      if (seen[key]) return;
      seen[key] = 1;
      out.push({ id: (e && typeof e === 'object' && e.id != null) ? Number(e.id) : null,
                 username: name });
    });
    return out.slice(0, MAX);
  }

  /* mount(container, opts) -> { get, set, focus }
     opts.onChange(list)  called whenever the list changes, so the page can
                          write it into whatever it saves from.
     opts.disabled        render the list read-only (a guest editing somebody
                          else's page: the Worker carries the stored list
                          forward whatever gets posted, so an editable box
                          would be a promise the save does not keep). */
  function mount(container, opts) {
    opts = opts || {};
    var list = clean(opts.value);

    container.classList.add('ae-wrap');
    container.innerHTML =
      '<div class="ae-chips" id="ae-chips"></div>' +
      (opts.disabled ? '' :
        '<div class="ae-add">' +
          '<input type="text" class="ae-input" placeholder="username" autocomplete="off" ' +
            'spellcheck="false" maxlength="60" aria-label="Username to add as an editor">' +
          '<button type="button" class="btn btn-ghost btn-sm ae-add-btn">Add editor</button>' +
        '</div>') +
      '<div class="ae-msg" hidden></div>';

    var chips = container.querySelector('.ae-chips');
    var input = container.querySelector('.ae-input');
    var addBtn = container.querySelector('.ae-add-btn');
    var msg = container.querySelector('.ae-msg');

    function say(cls, text) {
      if (!text) { msg.hidden = true; msg.textContent = ''; return; }
      msg.className = 'ae-msg' + (cls ? ' ' + cls : '');
      msg.textContent = text;
      msg.hidden = false;
    }

    function render() {
      if (!list.length) {
        chips.innerHTML = '<p class="ae-empty">Nobody yet. Only you and the wiki admins can edit this page.</p>';
      } else {
        chips.innerHTML = list.map(function (e, i) {
          return '<span class="ae-chip">' +
            '<a href="u/' + encodeURIComponent(e.username) + '" target="_blank" rel="noopener">@' +
              esc(e.username) + '</a>' +
            (opts.disabled ? '' :
              '<button type="button" class="ae-x" data-i="' + i + '" ' +
                'aria-label="Remove ' + esc(e.username) + '">&times;</button>') +
          '</span>';
        }).join('');
      }
      if (opts.onChange) opts.onChange(list.slice());
    }

    function add(name) {
      name = String(name || '').trim().replace(/^@+/, '');
      if (!name) return;
      if (list.length >= MAX) { say('err', 'That is as many editors as one page can have (' + MAX + ').'); return; }
      if (list.some(function (e) { return e.username.toLowerCase() === name.toLowerCase(); })) {
        say('err', '@' + name + ' is already on the list.');
        return;
      }
      say('', 'Looking for @' + name + '…');
      addBtn.disabled = true;
      fetch('/api/account-lookup?u=' + encodeURIComponent(name), { credentials: 'same-origin' })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (res) {
          if (!res || !res.found) {
            // Not added. A name nobody answers to would be dropped on save
            // anyway, and saying so now is the whole point of the lookup.
            say('err', 'No account called “' + name + '”. Check the spelling — it is their username, ' +
              'the one in their profile address.');
            return;
          }
          // The handle as the SITE spells it, fadas and all, not as it was
          // typed: /u/tir-far-thoinn and /u/tir-far-thóinn are one account.
          if (list.some(function (e) { return Number(e.id) === Number(res.id); })) {
            say('err', '@' + res.username + ' is already on the list.');
            return;
          }
          list.push({ id: Number(res.id), username: String(res.username) });
          input.value = '';
          say('ok', '@' + res.username + ' can now edit this page once you save.');
          render();
        })
        .catch(function () { say('err', 'Could not reach the wiki to check that name.'); })
        .then(function () { addBtn.disabled = false; });
    }

    if (!opts.disabled) {
      addBtn.addEventListener('click', function () { add(input.value); });
      input.addEventListener('keydown', function (e) {
        // Enter inside a form would submit it; this list is never the save.
        if (e.key === 'Enter') { e.preventDefault(); add(input.value); }
      });
      chips.addEventListener('click', function (e) {
        var x = e.target.closest ? e.target.closest('.ae-x') : null;
        if (!x) return;
        var i = Number(x.getAttribute('data-i'));
        if (!(i >= 0) || !list[i]) return;
        var gone = list[i].username;
        list.splice(i, 1);
        say('', '@' + gone + ' comes off the list when you save.');
        render();
      });
    }

    render();
    say('', '');

    return {
      get: function () { return list.slice(); },
      set: function (v) { list = clean(v); render(); say('', ''); },
      /* Names the Worker could not resolve on the last save. Reported rather
         than dropped in silence: the owner believed they had shared the page. */
      reportUnknown: function (names) {
        if (!names || !names.length) return;
        say('err', (names.length === 1
          ? 'No account called “' + names[0] + '”, so nobody was added for it.'
          : 'No accounts called ' + names.map(function (n) { return '“' + n + '”'; }).join(', ') +
            ', so nobody was added for them.'));
      },
      focus: function () { if (input) input.focus(); }
    };
  }

  window.ApprovedEditors = { mount: mount, MAX: MAX, clean: clean };
})();
