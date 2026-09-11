/* Render bounded batches only when the reader approaches their section.
   Buttons also work without IntersectionObserver and make every card reachable. */
(function () {
  'use strict';
  window.mountCardBatches = function (host, groups, renderCard, options) {
    var opts = options || {}, size = opts.size || 48, alive = true, observer;
    var jobs = [];
    function append(job) {
      if (!alive || !job || job.at >= job.items.length) return;
      var end = Math.min(job.at + size, job.items.length);
      job.grid.insertAdjacentHTML('beforeend', job.items.slice(job.at, end).map(renderCard).join(''));
      job.at = end;
      job.button.hidden = end === job.items.length;
      job.button.textContent = 'Show more (' + (job.items.length - end) + ' remaining)';
      if (observer) {
        observer.unobserve(job.button);
        if (!job.button.hidden) requestAnimationFrame(function () { if (alive) observer.observe(job.button); });
      }
    }
    if (typeof IntersectionObserver === 'function') observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) append(jobs.find(function (job) { return job.button === entry.target; }));
      });
    }, { rootMargin: '500px 0px' });
    groups.forEach(function (group, index) {
      var grid = host.querySelector(group.selector);
      if (!grid || !group.items.length) return;
      var button = document.createElement('button');
      button.type = 'button'; button.className = 'card-load-more';
      grid.insertAdjacentElement('afterend', button);
      var job = { grid: grid, items: group.items, at: 0, button: button };
      jobs.push(job);
      button.addEventListener('click', function () { append(job); });
      // Only the first group is drawn eagerly. Other sections get their
      // first batch on approach, including direct jumps to a team anchor.
      if (index === 0 || !observer) append(job);
      else { button.textContent = 'Show ' + group.items.length + ' characters'; observer.observe(button); }
    });
    return function () { alive = false; if (observer) observer.disconnect(); };
  };
})();
