/* Comment section, shared by every page type that has one.

   Mounts itself into #comments (or appends its own container to <main>) on
   character, script, collection and news pages. The page tells it what it is
   looking at through window.PAGE_TYPE / window.PAGE_SLUG — the same globals
   the SSR shell already sets for pageview.js.

   Behaviour worth knowing:
   - Reading is public. Posting needs an account; logged-out readers get a
     "log in to comment" line instead of the box.
   - The first time someone comments they must tick the respectful-comments
     agreement. It is stored on the ACCOUNT (not the browser), so it follows
     them to their phone and only ever appears once — see COMMENT_TERMS_VERSION
     in worker/worker.js if the wording ever needs re-acknowledging.
   - A comment can be removed by its author, by the owner of the page it sits
     on, or by an admin. Everyone else gets a Report link instead. */
(function () {
  'use strict';

  var TYPE = window.PAGE_TYPE || (window.CHAR_SLUG ? 'character' : '');
  var SLUG = window.PAGE_SLUG || window.CHAR_SLUG || '';
  if (!TYPE || !SLUG) return;

  var ROOT = window.LINK_ROOT || '';
  var state = { comments: [], me: null, loaded: false };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* "3 minutes ago" / "12 Mar 2026" — SQLite hands back 'YYYY-MM-DD HH:MM:SS'
     in UTC, which Safari refuses to parse without the T and the Z. */
  function when(ts) {
    var d = new Date(String(ts || '').replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '';
    var secs = (Date.now() - d.getTime()) / 1000;
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + ' min ago';
    if (secs < 86400) return Math.floor(secs / 3600) + ' hr ago';
    if (secs < 7 * 86400) return Math.floor(secs / 86400) + ' days ago';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function avatarHTML(c) {
    if (c.avatarUrl) {
      return '<img class="cmt-avatar" src="' + esc(c.avatarUrl) + '" alt="" loading="lazy" decoding="async">';
    }
    var letter = (c.displayName || c.username || '?').trim().charAt(0).toUpperCase();
    return '<span class="cmt-avatar cmt-avatar-letter" aria-hidden="true">' + esc(letter) + '</span>';
  }

  /* Comment bodies are plain text: escape everything, then turn blank lines
     into paragraphs. No markdown, no links — nothing a commenter writes ever
     becomes markup. */
  function bodyHTML(text) {
    return String(text || '').split(/\n{2,}/).map(function (p) {
      return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  function canRemove(c) {
    if (!state.me) return false;
    return c.mine || state.me.canModerate;
  }

  function commentHTML(c) {
    var actions = [];
    if (canRemove(c)) {
      actions.push('<button type="button" class="cmt-action" data-remove="' + c.id + '">Remove</button>');
    } else if (state.me) {
      actions.push('<button type="button" class="cmt-action" data-report="' + c.id + '">Report</button>');
    }
    return '<li class="cmt" id="cmt-' + c.id + '">' +
      avatarHTML(c) +
      '<div class="cmt-main">' +
        '<div class="cmt-head">' +
          '<a class="cmt-who" href="' + ROOT + 'u/' + encodeURIComponent(c.username) + '">' +
            esc(c.displayName) + '</a>' +
          (c.isAdmin ? '<span class="cmt-badge">Admin</span>' : '') +
          '<span class="cmt-when">' + esc(when(c.ts)) + '</span>' +
        '</div>' +
        '<div class="cmt-body">' + bodyHTML(c.body) + '</div>' +
        (actions.length ? '<div class="cmt-actions">' + actions.join('') + '</div>' : '') +
      '</div>' +
    '</li>';
  }

  function formHTML() {
    if (!state.me) {
      return '<p class="cmt-login"><a href="' + ROOT + 'login">Log in</a> or ' +
        '<a href="' + ROOT + 'login#signup">create an account</a> to join the conversation.</p>';
    }
    if (!state.me.canComment) {
      return '<p class="cmt-login">This account is suspended and cannot post comments. ' +
        'You can contact the admins from your <a href="' + ROOT + 'account">account page</a>.</p>';
    }
    return '<form class="cmt-form" id="cmt-form">' +
      '<textarea id="cmt-box" rows="3" maxlength="2000" placeholder="Add a comment…" ' +
        'aria-label="Write a comment"></textarea>' +
      '<div class="cmt-form-row">' +
        '<span class="cmt-count" id="cmt-count">0 / 2000</span>' +
        '<button type="submit" class="cmt-submit" id="cmt-submit">Post comment</button>' +
      '</div>' +
      '<p class="cmt-error" id="cmt-error" hidden></p>' +
    '</form>';
  }

  function render() {
    var n = state.comments.length;
    root.innerHTML =
      '<div class="gen-sech-wrap" id="sec-comments">' +
        '<h2 class="gen-sech"><a class="sec-anchor" href="#sec-comments">Comments' +
        (n ? ' (' + n + ')' : '') + '</a></h2>' +
      '</div>' +
      (n
        ? '<ul class="cmt-list">' + state.comments.map(commentHTML).join('') + '</ul>'
        : '<p class="cmt-empty">No comments yet.' +
          (state.me && state.me.canComment ? ' Be the first.' : '') + '</p>') +
      formHTML();
    wire();
  }

  function wire() {
    var form = root.querySelector('#cmt-form');
    if (form) {
      var box = root.querySelector('#cmt-box');
      var count = root.querySelector('#cmt-count');
      box.addEventListener('input', function () {
        count.textContent = box.value.length + ' / 2000';
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        submit(box.value);
      });
    }
    root.querySelectorAll('[data-remove]').forEach(function (btn) {
      btn.addEventListener('click', function () { remove(btn.getAttribute('data-remove')); });
    });
    root.querySelectorAll('[data-report]').forEach(function (btn) {
      btn.addEventListener('click', function () { report(btn.getAttribute('data-report'), btn); });
    });
  }

  function showError(msg) {
    var el = root.querySelector('#cmt-error');
    if (!el) { alert(msg); return; }
    el.textContent = msg;
    el.hidden = !msg;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d._status = r.status;
        return d;
      });
    });
  }

  function submit(text) {
    var body = String(text || '').trim();
    if (!body) return;
    showError('');
    var btn = root.querySelector('#cmt-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }

    function send(agree) {
      return post('/api/comments', { type: TYPE, slug: SLUG, body: body, agree: !!agree })
        .then(function (d) {
          if (d.needsAgreement) {
            // First comment ever: show the agreement, then retry once.
            return showAgreement().then(function (ok) {
              if (!ok) throw new Error('');
              return send(true);
            });
          }
          if (d.error) throw new Error(d.error);
          return d;
        });
    }

    send(state.me && state.me.agreed)
      .then(function () {
        var box = root.querySelector('#cmt-box');
        if (box) box.value = '';
        if (state.me) state.me.agreed = true;
        return load();
      })
      .catch(function (err) { if (err && err.message) showError(err.message); })
      .then(function () {
        var b = root.querySelector('#cmt-submit');
        if (b) { b.disabled = false; b.textContent = 'Post comment'; }
      });
  }

  function remove(id) {
    if (!confirm('Remove this comment?')) return;
    post('/api/comments/delete', { id: id }).then(function (d) {
      if (d.error) { alert(d.error); return; }
      load();
    });
  }

  function report(id, btn) {
    var reason = prompt('What is wrong with this comment? (optional)');
    if (reason === null) return;
    post('/api/comments/report', { id: id, reason: reason }).then(function (d) {
      if (d.error) { alert(d.error); return; }
      btn.textContent = 'Reported';
      btn.disabled = true;
    });
  }

  /* ── first-time agreement modal ──────────────────────────────────────
     Same visual language as the create/edit rules gate, but it resolves a
     promise instead of unlocking a page, so the comment that triggered it
     can be posted straight afterwards. */
  var TERMS = [
    'Be respectful. Criticise the character, never the person who made it.',
    'Keep feedback constructive — say what works as well as what doesn’t.',
    'No harassment, slurs, spam, or self-promotion unrelated to the page.',
    'Page owners and the wiki admins can remove comments that break these rules.'
  ];

  function showAgreement() {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'rules-modal open';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'cmt-terms-title');
      overlay.innerHTML =
        '<div class="rules-modal-card">' +
          '<h2 class="rules-modal-title" id="cmt-terms-title">Before your first comment</h2>' +
          '<p class="rules-modal-intro">You only need to agree to this once.</p>' +
          '<ul class="rules-list">' +
            TERMS.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') +
          '</ul>' +
          '<label class="rules-agree"><input type="checkbox" id="cmt-agree-box">' +
            '<span>I’ll keep my comments respectful.</span></label>' +
          '<div class="rules-modal-actions">' +
            '<button type="button" class="rules-btn-cancel" id="cmt-agree-cancel">Cancel</button>' +
            '<button type="button" class="rules-btn-go" id="cmt-agree-go" disabled>Agree &amp; post</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      document.body.classList.add('rules-modal-lock');

      function close(result) {
        overlay.remove();
        document.body.classList.remove('rules-modal-lock');
        resolve(result);
      }
      var box = overlay.querySelector('#cmt-agree-box');
      var go = overlay.querySelector('#cmt-agree-go');
      box.addEventListener('change', function () { go.disabled = !box.checked; });
      go.addEventListener('click', function () { if (box.checked) close(true); });
      overlay.querySelector('#cmt-agree-cancel').addEventListener('click', function () { close(false); });
      box.focus();
    });
  }

  /* ── load + mount ─────────────────────────────────────────────────── */
  var root = document.getElementById('comments');
  if (!root) {
    root = document.createElement('section');
    root.id = 'comments';
    root.className = 'comments-section';
    var host = document.querySelector('main#content') || document.querySelector('main') || document.body;
    host.appendChild(root);
  } else {
    root.classList.add('comments-section');
  }

  function load() {
    return fetch('/api/comments?type=' + encodeURIComponent(TYPE) +
                 '&slug=' + encodeURIComponent(SLUG) + '&_=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { root.hidden = true; return; }
        state.comments = d.comments || [];
        state.me = d.me || null;
        state.loaded = true;
        render();
      })
      .catch(function () { root.hidden = true; });
  }

  load();
})();
