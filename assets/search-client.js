/* One lazy worker shared by the header and results page. Failed loads retry. */
(function () {
  'use strict';
  var worker, serial = 0, pending = new Map(), fallback, warmed;
  function failWorker(message) {
    if (worker) worker.terminate();
    worker = null; warmed = null;
    pending.forEach(function (task) { clearTimeout(task.timer); task.reject(new Error(message)); });
    pending.clear();
  }
  function localIndex() {
    if (!fallback) fallback = window.BotcData.script('search-engine.js').then(function () {
      return fetch('/api/search-index', { credentials: 'omit' });
    }).then(function (r) {
      if (!r.ok) throw new Error('Could not load search.');
      return r.json();
    }).then(function (data) {
      if (data.schema !== 1 || !Array.isArray(data.documents)) throw new Error('Invalid search index.');
      return new window.BotcSearchEngine.Index(data.documents);
    }).catch(function (error) { fallback = null; throw error; });
    return fallback;
  }
  function request(options) {
    if (!window.Worker) return localIndex().then(function (index) { return options ? index.search(options) : { facets: index.facets }; });
    if (!worker) {
      try { worker = new Worker(window.BotcData.asset('search-worker.js')); }
      catch (error) { return localIndex().then(function (index) { return options ? index.search(options) : { facets: index.facets }; }); }
      worker.onmessage = function (event) {
        var message = event.data, task = pending.get(message.id);
        if (!task) return;
        pending.delete(message.id);
        clearTimeout(task.timer);
        if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
      };
      worker.onerror = function () {
        failWorker('Could not load search. Try again.');
      };
    }
    return new Promise(function (resolve, reject) {
      var id = ++serial;
      var timer = setTimeout(function () { failWorker('Search took too long. Try again.'); }, 30000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      worker.postMessage({ id: id, options: options, engineURL: window.BotcData.asset('search-engine.js') });
    });
  }
  function warm() {
    if (!warmed) warmed = request().catch(function (error) { warmed = null; throw error; });
    return warmed;
  }
  function escape(value) {
    return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  var labels = { character: 'Character', script: 'Script', collection: 'Collection', user: 'User', creator: 'Creator', page: 'Page', news: 'News', tag: 'Tag', tool: 'Site page' };
  function resultHTML(doc, preview) {
    var url = /^\/(?!\/)/.test(doc.url) ? doc.url : '/search';
    var image = /^(?:https?:\/\/|\/(?!\/))/.test(doc.image || '') ? doc.image : '/assets/favicon.png';
    var subtitle = [doc.team ? doc.team.charAt(0).toUpperCase() + doc.team.slice(1) : '', doc.creator || ''].filter(Boolean).join(' · ');
    return '<a class="search-result' + (preview ? '' : ' search-page-result') + '" href="' + escape(url) + '">' +
      '<img class="search-result-thumb" loading="lazy" decoding="async" width="56" height="56" src="' + escape(image) + '" alt="">' +
      '<div class="search-result-info"><span class="search-result-name">' + escape(doc.title) +
      '<span class="search-match">' + escape(labels[doc.type] || doc.type) + '</span></span>' +
      (subtitle ? '<span class="search-result-type' + (/^(townsfolk|outsider)$/.test(doc.team) ? ' good' : '') + '">' + escape(subtitle) + '</span>' : '') +
      '<span class="search-result-ability">' + escape(String(doc.summary || '').slice(0, preview ? 100 : 300)) + '</span></div></a>';
  }
  // Capture failed thumbnails once, without inline handlers or retry loops.
  document.addEventListener('error', function (event) {
    var img = event.target;
    if (img.tagName === 'IMG' && img.classList.contains('search-result-thumb') && !img.dataset.fallback) {
      img.dataset.fallback = '1'; img.src = '/assets/favicon.png';
    }
  }, true);
  window.BotcSearch = { warm: warm, search: request, resultHTML: resultHTML, escape: escape };
})();
