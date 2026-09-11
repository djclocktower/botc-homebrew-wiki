/* Comments and attachment UI are optional reading-page work. */
(function () {
  if (!window.PAGE_SLUG && !window.CHAR_SLUG) return;
  var root = document.getElementById('comments');
  if (!root) {
    root = document.createElement('section'); root.id = 'comments';
    (document.getElementById('content') || document.body).appendChild(root);
  }
  root.innerHTML = '<button type="button" class="card-load-more" id="sec-comments">Show comments</button>';
  var pending = null, observer;
  function load() {
    if (pending) return pending;
    if (observer) observer.disconnect();
    window.BotcData.style('comments.css');
    pending = window.BotcData.script('attachment-view.js').then(function () { return window.BotcData.script('comments.js'); }).catch(function () {
      pending = null;
      var button = root.querySelector('button');
      if (button) button.textContent = 'Could not load comments. Tap to retry.';
    });
    return pending;
  }
  function anchor() {
    if (/^#(?:comments|sec-comments|comment[-_]|cmt[-_])/.test(location.hash)) load();
  }
  root.addEventListener('click', load);
  window.addEventListener('hashchange', anchor);
  anchor();
  if (!pending && typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) load();
    }, { rootMargin: '500px 0px' });
    observer.observe(root);
  }
})();
