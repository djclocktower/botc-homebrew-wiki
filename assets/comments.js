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

  /* ── "new since you last looked" marker ──
     Per reader, per page, in this browser: the highest comment id they had
     already seen here. Anything newer than that gets a dot; opening the page
     and letting the comments sit on screen for a moment marks them seen, so
     the dots are gone next visit. On a first visit nothing is marked new —
     lighting up a three-year-old thread helps nobody. */
  var SEEN_KEY = 'botc_cmt_seen';
  var SEEN_ID = TYPE + ':' + SLUG;
  var SEEN_KEEP = 200;          // pages remembered before the oldest drop off

  function readSeen() {
    try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function lastSeenId() {
    var v = readSeen()[SEEN_ID];
    return typeof v === 'number' ? v : null;
  }
  function markSeen(id) {
    if (!id) return;
    try {
      var all = readSeen();
      if (all[SEEN_ID] === id) return;
      all[SEEN_ID] = id;
      // Newest entries win when the map is trimmed; insertion order is enough.
      var keys = Object.keys(all);
      if (keys.length > SEEN_KEEP) {
        var trimmed = {};
        keys.slice(keys.length - SEEN_KEEP).forEach(function (k) { trimmed[k] = all[k]; });
        all = trimmed;
      }
      localStorage.setItem(SEEN_KEY, JSON.stringify(all));
    } catch (e) { /* private mode: the dots just never persist */ }
  }
  function newestId() {
    var max = 0;
    state.comments.forEach(function (c) { if (c.id > max) max = c.id; });
    return max;
  }
  // Your own comment is never "new" to you.
  function isUnseen(c) {
    var seen = lastSeenId();
    return seen !== null && !c.mine && c.id > seen;
  }

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
  // Pinning is a moderator act, not an author one: the page owner and the
  // admins decide what sits at the top, never the person who wrote it.
  function canPin() {
    return !!(state.me && state.me.canModerate);
  }

  function commentHTML(c, replies) {
    var actions = [];
    if (state.me && state.me.canComment) {
      actions.push('<button type="button" class="cmt-action" data-reply="' + c.id + '">Reply</button>');
    }
    if (canPin() && !c.parentId) {
      actions.push('<button type="button" class="cmt-action" data-pin="' + c.id + '" ' +
        'data-pinned="' + (c.pinned ? '1' : '') + '">' + (c.pinned ? 'Unpin' : 'Pin') + '</button>');
    }
    if (canRemove(c)) {
      actions.push('<button type="button" class="cmt-action" data-remove="' + c.id + '">Remove</button>');
    } else if (state.me) {
      actions.push('<button type="button" class="cmt-action" data-report="' + c.id + '">Report</button>');
    }
    return '<li class="cmt' + (c.pinned ? ' cmt-is-pinned' : '') +
      (isUnseen(c) ? ' cmt-unseen' : '') + '" id="cmt-' + c.id + '"' +
      (isUnseen(c) ? ' title="New since you last looked at this page"' : '') + '>' +
      avatarHTML(c) +
      '<div class="cmt-main">' +
        '<div class="cmt-head">' +
          '<a class="cmt-who" href="' + ROOT + 'u/' + encodeURIComponent(c.username) + '">' +
            esc(c.displayName) + '</a>' +
          // "Creator" marks the account that owns this page, so a reader can
          // tell the person who made the thing from everyone else talking
          // about it. Shown alongside Admin rather than instead of it: on a
          // wiki where the admin writes pages too, both are true and both are
          // worth knowing.
          (c.isOwner ? '<span class="cmt-badge cmt-badge-creator" title="Made this page">Creator</span>' : '') +
          (c.isAdmin ? '<span class="cmt-badge">Admin</span>' : '') +
          (c.pinned ? '<span class="cmt-badge cmt-badge-pin" title="Pinned by the page owner or an admin">📌 Pinned</span>' : '') +
          '<span class="cmt-when">' + esc(when(c.ts)) + '</span>' +
        '</div>' +
        '<div class="cmt-body">' + bodyHTML(c.body) + '</div>' +
        (actions.length ? '<div class="cmt-actions">' + actions.join('') + '</div>' : '') +
        '<div class="cmt-reply-slot" id="cmt-reply-slot-' + c.id + '"></div>' +
        (replies && replies.length
          ? '<ul class="cmt-replies">' + replies.map(function (r) { return commentHTML(r, null); }).join('') + '</ul>'
          : '') +
      '</div>' +
    '</li>';
  }

  /* Group the flat list the API returns into threads. The server already
     sorted it (pinned first, then oldest-first), so nothing is re-sorted
     here — replies just move under their parent in the order they arrived. */
  function threads() {
    // A reply can outlive its parent — an admin can restore one reply while
    // leaving the comment it answered removed. Those orphans are promoted to
    // top level rather than dropped, so nothing is counted but unrenderable.
    var visible = {};
    state.comments.forEach(function (c) { if (!c.parentId) visible[c.id] = true; });

    var tops = [], byParent = {};
    state.comments.forEach(function (c) {
      if (c.parentId && visible[c.parentId]) {
        (byParent[c.parentId] = byParent[c.parentId] || []).push(c);
      } else {
        tops.push(c);
      }
    });
    return tops.map(function (t) { return { comment: t, replies: byParent[t.id] || [] }; });
  }

  function formHTML() {
    if (!state.me) {
      // Come back to this page after logging in, not to the account page.
      var back = encodeURIComponent(location.pathname.replace(/^\//, '') + location.search);
      var login = ROOT + 'login?next=' + back;
      return '<p class="cmt-login"><a href="' + login + '">Log in</a> or ' +
        '<a href="' + login + '#signup">create an account</a> to join the conversation.</p>';
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
        ? '<ul class="cmt-list">' + threads().map(function (t) {
            return commentHTML(t.comment, t.replies);
          }).join('') + '</ul>'
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
    root.querySelectorAll('[data-pin]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pin(btn.getAttribute('data-pin'), !btn.getAttribute('data-pinned'), btn);
      });
    });
    root.querySelectorAll('[data-reply]').forEach(function (btn) {
      btn.addEventListener('click', function () { openReply(btn.getAttribute('data-reply'), btn); });
    });
  }

  /* Inline reply box, opened under the comment being answered. Only one is
     ever open at a time — a page full of half-written reply boxes is a mess
     on a phone. */
  function openReply(id, btn) {
    root.querySelectorAll('.cmt-reply-slot').forEach(function (slot) {
      if (slot.id !== 'cmt-reply-slot-' + id) slot.innerHTML = '';
    });
    var slot = root.querySelector('#cmt-reply-slot-' + id);
    if (!slot) return;
    if (slot.firstChild) { slot.innerHTML = ''; return; }   // second click closes it

    // Replying to a reply answers the same thread, so prefill the name to
    // keep it clear who is being addressed.
    var target = null;
    for (var i = 0; i < state.comments.length; i++) {
      if (String(state.comments[i].id) === String(id)) { target = state.comments[i]; break; }
    }
    var prefill = (target && target.parentId) ? '@' + target.displayName + ' ' : '';

    slot.innerHTML =
      '<form class="cmt-form cmt-form-reply">' +
        '<textarea rows="2" maxlength="2000" placeholder="Reply…" aria-label="Write a reply">' +
          esc(prefill) + '</textarea>' +
        '<div class="cmt-form-row">' +
          '<button type="button" class="cmt-action cmt-reply-cancel">Cancel</button>' +
          '<button type="submit" class="cmt-submit">Post reply</button>' +
        '</div>' +
        '<p class="cmt-error" hidden></p>' +
      '</form>';

    var form = slot.querySelector('form');
    var box = slot.querySelector('textarea');
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    slot.querySelector('.cmt-reply-cancel').addEventListener('click', function () {
      slot.innerHTML = '';
      if (btn) btn.focus();
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      submit(box.value, id, form);
    });
  }

  function pin(id, on, btn) {
    btn.disabled = true;
    post('/api/comments/pin', { id: id, pinned: on }).then(function (d) {
      if (d.error) { btn.disabled = false; alert(d.error); return; }
      load();
    });
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d._status = r.status;
        return d;
      });
    });
  }

  /* Posts a new comment, or a reply when `parentId` is given. `form` is the
     reply form the text came from, so errors land next to the box the person
     is actually looking at instead of at the bottom of the page. */
  function submit(text, parentId, form) {
    var body = String(text || '').trim();
    if (!body) return;
    var errEl = form ? form.querySelector('.cmt-error') : root.querySelector('#cmt-error');
    var btn = form ? form.querySelector('.cmt-submit') : root.querySelector('#cmt-submit');
    var btnLabel = parentId ? 'Post reply' : 'Post comment';
    function fail(msg) {
      if (!errEl) { if (msg) alert(msg); return; }
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    }
    fail('');
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }

    function send(agree) {
      return post('/api/comments', {
        type: TYPE, slug: SLUG, body: body,
        parentId: parentId || undefined, agree: !!agree
      }).then(function (d) {
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
        if (!parentId) {
          var box = root.querySelector('#cmt-box');
          if (box) box.value = '';
        }
        if (state.me) state.me.agreed = true;
        // load() re-renders everything, which closes the reply box for us.
        return load();
      })
      .catch(function (err) {
        fail(err && err.message);
        if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
      });
  }

  function remove(id) {
    // Removing a top-level comment takes its replies with it (the server
    // hides them and brings them back if the comment is restored), so say so
    // rather than surprising someone.
    var nReplies = state.comments.filter(function (c) {
      return String(c.parentId) === String(id);
    }).length;
    var msg = nReplies
      ? 'Remove this comment and its ' + nReplies + ' repl' + (nReplies === 1 ? 'y' : 'ies') + '?'
      : 'Remove this comment?';
    if (!confirm(msg)) return;
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
                 '&slug=' + encodeURIComponent(SLUG) + '&_=' + Date.now(),
                 { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { root.hidden = true; return; }
        state.comments = d.comments || [];
        state.me = d.me || null;
        state.loaded = true;
        var first = lastSeenId() === null;
        render();
        if (first) markSeen(newestId());   // nothing is new on a first visit
        else scheduleMarkSeen();
      })
      .catch(function () { root.hidden = true; });
  }

  /* The dots stay put for this visit — you should be able to see what is new
     — and are marked seen once the comments have been on screen for a moment,
     so they are gone next time. No IntersectionObserver, no dots cleared: the
     reader never reached them. */
  var seenTimer = null;
  function scheduleMarkSeen() {
    var newest = newestId();
    if (!newest || newest === lastSeenId()) return;
    if (typeof IntersectionObserver !== 'function') { markSeen(newest); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          clearTimeout(seenTimer);
          seenTimer = setTimeout(function () { markSeen(newest); io.disconnect(); }, 1500);
        } else {
          clearTimeout(seenTimer);
        }
      });
    }, { threshold: 0.15 });
    io.observe(root);
  }

  load();
})();
