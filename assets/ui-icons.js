/* ui-icons.js — the wiki's interface icons, as inline SVG.
 *
 * Pages used to label their buttons with emoji and dingbats (a floppy disk,
 * a die, a printer, a copy mark, a cross).
 * Two things are wrong with that. An emoji is drawn by the READER's font, in
 * the font's own colours, so the bar came out as a row of little coloured
 * pictures that belong to no site — and on the dark and the plain paper tones
 * they were the one thing on the page that did not take the tone's ink. A
 * dingbat is the opposite problem: it is whatever weight and size the text
 * font happens to draw it at, so ✕ and ⎘ never matched each other.
 *
 * So every mark is one inline SVG from this file, drawn as a 24×24 stroke in
 * **currentColor**. That is the whole of the colour rule: an icon is the
 * colour of the text it sits in, which is already the site's own ink
 * (--maroon on parchment, the tone's own ink in dark and paper, --parch
 * inside a filled button), and a new tone needs no icon work at all.
 *
 * Two doors, one set of path data:
 *   UIIcons.svg(name, opts)  the markup, for anything built in JS
 *   UIIcons.paint(root)      fills every <i data-icon="name"> placeholder,
 *                            for static markup
 *
 * opts: {size} a CSS length (default 1em, so it follows the button's type),
 *       {fill} paint the shape solid rather than outline (a pinned pin),
 *       {cls}  extra classes.
 * An unknown name draws nothing rather than a box — a missing icon should
 * cost a label its picture, never its button.
 *
 * Browser only. The Worker's own SSR markup (render-page.js) carries the
 * same shapes inline — there is no global to reach there.
 */
(function () {
  'use strict';

  /* 24×24, stroke-drawn, on the same visual weight. Keep new ones inside a
     2px stroke on a 24 grid or they will not sit with the rest. */
  var PATHS = {
    /* windows and panels */
    menu:      '<path d="M3 6h18M3 12h18M3 18h18"/>',
    more:      '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
    gear:      '<path d="M4 7h9M17.5 7H20M4 17h3.5M12 17h8"/><circle cx="15.2" cy="7" r="2.6"/><circle cx="9.7" cy="17" r="2.6"/>',
    widen:     '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M3 12h18"/>',
    close:     '<path d="M6 6l12 12M18 6L6 18"/>',
    check:     '<path d="M4.5 12.5l5 5 10-11"/>',
    plus:      '<path d="M12 5v14M5 12h14"/>',
    minus:     '<path d="M5 12h14"/>',
    up:        '<path d="M6 15l6-6 6 6"/>',
    down:      '<path d="M6 9l6 6 6-6"/>',
    left:      '<path d="M15 6l-6 6 6 6"/>',
    right:     '<path d="M9 6l6 6-6 6"/>',
    external:  '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10"/>',
    /* the script's own actions */
    dice:      '<rect x="2.6" y="2.6" width="18.8" height="18.8" rx="4.4"/><circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="2.4" fill="currentColor" stroke="none"/>',
    sort:      '<path d="M7 4v16M7 20l-3.2-3.4M7 20l3.2-3.4M17 20V4M17 4l-3.2 3.4M17 4l3.2 3.4"/>',
    undo:      '<path d="M4 9h11a5 5 0 0 1 0 10H9"/><path d="M8 4.5L3.5 9 8 13.5"/>',
    redo:      '<path d="M20 9H9a5 5 0 0 0 0 10h6"/><path d="M16 4.5L20.5 9 16 13.5"/>',
    reset:     '<path d="M3.8 12a8.2 8.2 0 1 0 2.6-6"/><path d="M3.5 3.5V10H10"/>',
    save:      '<path d="M4.5 4.5h11.4L19.5 8v11.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/><path d="M8 4.5v5h7v-5M8 20.5v-5.8h8v5.8"/>',
    download:  '<path d="M12 3.5v11M12 14.5L7.5 10M12 14.5L16.5 10"/><path d="M4 16v3.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V16"/>',
    upload:    '<path d="M12 20.5v-11M12 9.5L7.5 14M12 9.5L16.5 14"/><path d="M4 8V4.5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1V8"/>',
    copy:      '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 5.5v-1a1 1 0 0 0-1-1h-10a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1"/>',
    clipboard: '<path d="M9 4.5H6.5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-14a1 1 0 0 0-1-1H15"/><rect x="9" y="2.6" width="6" height="3.8" rx="1.2"/>',
    link:      '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.4 7"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 1 0 11 18.7L12.6 17"/>',
    print:     '<path d="M7 9V3.5h10V9"/><path d="M7 18H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-2"/><rect x="7" y="14.5" width="10" height="6"/>',
    sheet:     '<path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z"/><path d="M14 3.5V8h4M8.5 12.5h7M8.5 16h4.5"/>',
    book:      '<path d="M4 4.5h5.5A2.5 2.5 0 0 1 12 7v12a2 2 0 0 0-2-2H4z"/><path d="M20 4.5h-5.5A2.5 2.5 0 0 0 12 7v12a2 2 0 0 1 2-2h6z"/>',
    bag:       '<path d="M5.5 8h13l1.2 11a1.5 1.5 0 0 1-1.5 1.7H5.8A1.5 1.5 0 0 1 4.3 19z"/><path d="M8.8 10.5V7a3.2 3.2 0 0 1 6.4 0v3.5"/>',
    trash:     '<path d="M4.5 6.5h15M9.5 6.5V4.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.3"/><path d="M6.8 6.5l.9 13a1 1 0 0 0 1 1h6.6a1 1 0 0 0 1-1l.9-13"/>',
    pencil:    '<path d="M16.4 3.9l3.7 3.7M4 20l.9-4.2L16.1 4.6a1.4 1.4 0 0 1 2 0l1.3 1.3a1.4 1.4 0 0 1 0 2L8.2 19.1z"/>',
    star:      '<path d="M12 3.6l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9z"/>',
    pin:       '<path d="M9 3.5h6l-.8 5.2 3.3 3.5v2H6.5v-2l3.3-3.5z"/><path d="M12 14.2v6.3"/>',
    jinx:      '<circle cx="8.2" cy="12" r="4.4"/><circle cx="15.8" cy="12" r="4.4"/>',
    globe:     '<circle cx="12" cy="12" r="8.8"/><path d="M3.2 12h17.6M12 3.2a13 13 0 0 1 0 17.6 13 13 0 0 1 0-17.6"/>',
    cloud:     '<path d="M7 19h10.2a4.3 4.3 0 0 0 .4-8.6 6 6 0 0 0-11.5 1.2A3.9 3.9 0 0 0 7 19z"/>',
    chat:      '<path d="M20.5 12.4c0 3.9-3.8 7-8.5 7a9.9 9.9 0 0 1-2.6-.34L4.2 20.5l1.3-3.5a6.6 6.6 0 0 1-2-4.6c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/>',
    grip:      '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function svg(name, opts) {
    var body = PATHS[name];
    if (!body) return '';
    opts = opts || {};
    var size = opts.size || '1em';
    var cls = 'sbi' + (opts.cls ? ' ' + opts.cls : '');
    return '<svg class="' + esc(cls) + '" viewBox="0 0 24 24" width="' + esc(size) + '" height="' + esc(size) +
      '" fill="' + (opts.fill ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="' +
      (opts.weight || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      body + '</svg>';
  }

  /* The static markup writes <i class="sbi-i" data-icon="save"></i> and this
     fills it — one copy of the path data rather than a second set inlined in
     the HTML that could drift from this one. It runs on DOMContentLoaded
     (or at once, if the page is already parsed), so nothing flashes; a page
     that somehow misses it shows a button with its label and no picture,
     which is legible. Markup built later paints itself — paint(thatNode), or
     ask svg() for the string. */
  function paint(root) {
    var host = root || document;
    var list = host.querySelectorAll ? host.querySelectorAll('[data-icon]') : [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var m = svg(el.getAttribute('data-icon'), {
        size: el.getAttribute('data-icon-size') || '',
        fill: el.hasAttribute('data-icon-fill')
      });
      if (m) el.innerHTML = m;
    }
  }

  window.UIIcons = { svg: svg, paint: paint, PATHS: PATHS };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { paint(document); });
    else paint(document);
  }
}());
