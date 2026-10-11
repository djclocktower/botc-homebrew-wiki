// Phone chrome and accessibility (CLAUDE.md, "Phone chrome and
// accessibility"). Browser-free: these read the source files and run the
// small pure pieces in a vm, so they guard the rules without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => readFileSync(resolve(root, p), 'utf8');
const css = read('assets/styles.css');
const site = read('assets/site.js');
const rootHtml = readdirSync(root).filter(f => f.endsWith('.html')).sort();

// ── 1. The hamburger menu fits the screen and closes on Escape ──────────
test('a11y: the menu is capped to the screen and scrolls inside itself', () => {
  const fn = site.slice(site.indexOf('function positionDrop()'), site.indexOf("btn.setAttribute('aria-controls'"));
  assert.match(fn, /drop\.style\.maxHeight\s*=/, 'positionDrop() must cap the menu height');
  assert.match(fn, /visualViewport/, 'the cap follows the visual viewport (the phone keyboard)');
  assert.match(site, /function closeMenu\(\)/);
  assert.match(site, /e\.key !== 'Escape' \|\| !drop\.classList\.contains\('open'\)/, 'Escape closes the open menu');
  assert.match(site, /btn\.setAttribute\('aria-controls', 'nav-dropdown'\)/);
  // Closing on a focusout with no relatedTarget would swallow iOS taps on
  // in-menu search results (Safari does not focus links on tap).
  assert.match(site, /if \(!to \|\| drop\.contains\(to\) \|\| btn\.contains\(to\)\) return;/);
  const rule = css.match(/\.nav-dropdown\s*\{[^}]*overflow-y:\s*auto[^}]*\}/);
  assert.ok(rule, 'styles.css gives .nav-dropdown overflow-y: auto');
  assert.match(rule[0], /overscroll-behavior:\s*contain/);
});

// ── 2. iOS input zoom, and never a zoom lock ─────────────────────────────
test('a11y: iOS fields are 16px, and the exemptions never shrink a field', () => {
  const m = css.match(/@supports \(-webkit-touch-callout: none\) \{([\s\S]*?\})\s*\}/);
  assert.ok(m, 'styles.css has the iOS-only @supports block');
  const block = m[1];
  assert.match(block, /font-size:\s*16px\s*!important/);
  assert.match(block, /(^|[\s,])select\s*,/, 'select is covered');
  assert.match(block, /textarea/, 'textarea is covered');
  // Fields already drawn above 16px must not be shrunk to it.
  assert.match(block, /:not\(\.sp-input\)/);
  assert.match(block, /:not\(#gf-name\)/);
  assert.match(block, /textarea:not\(#gf-input\)/);
});

test('a11y: no page blocks pinch-zoom', () => {
  const bad = [];
  for (const f of rootHtml.concat(['worker/worker.js'])) {
    const text = read(f);
    if (/maximum-scale|user-scalable\s*=\s*(no|0)/i.test(text)) bad.push(f);
  }
  assert.deepEqual(bad, [], 'maximum-scale / user-scalable=no blocks pinch-zoom in in-app browsers and on Android ' +
    '(WCAG 1.4.4). iOS zoom-on-focus is fixed by the 16px @supports rule in styles.css instead.');
});

// ── 3. dialog.js ─────────────────────────────────────────────────────────
function loadDialog() {
  const listeners = [];
  const document = {
    activeElement: null,
    addEventListener: (t, f, c) => listeners.push([t, f, c]),
    removeEventListener: (t, f) => { const i = listeners.findIndex(l => l[0] === t && l[1] === f); if (i >= 0) listeners.splice(i, 1); },
    contains: () => true
  };
  const window = { getComputedStyle: () => ({ position: 'static' }) };
  const ctx = vm.createContext({ window, document });
  vm.runInContext(read('assets/dialog.js'), ctx);
  return { BotcDialog: window.BotcDialog, document, listeners };
}

test('a11y: dialog.js cycles focus both ways and closes once', () => {
  const { BotcDialog, document, listeners } = loadDialog();
  assert.equal(BotcDialog._cycle(3, 2, false), 0);
  assert.equal(BotcDialog._cycle(3, 0, true), 2);
  assert.equal(BotcDialog._cycle(3, 1, false), 2);
  assert.equal(BotcDialog._cycle(3, 1, true), 0);

  // An element with nothing focusable inside: open() must not throw, and
  // must focus the dialog itself.
  const attrs = {};
  let focused = null;
  const el = {
    getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; },
    hasAttribute: k => k in attrs, querySelectorAll: () => [], querySelector: () => null,
    contains: () => false, focus() { focused = this; document.activeElement = this; }
  };
  const opener = { focus() { focused = this; document.activeElement = this; } };
  document.activeElement = opener;
  const results = [];
  const dlg = BotcDialog.open(el, { onClose: r => results.push(r), escapeResult: 'esc' });
  assert.equal(attrs.role, 'dialog');
  assert.equal(attrs['aria-modal'], 'true');
  assert.equal(attrs.tabindex, '-1');
  assert.equal(focused, el);
  assert.equal(listeners.length, 1, 'one capture-phase keydown listener while open');
  const key = listeners[0][1];
  key({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(results, ['esc']);
  assert.equal(focused, opener, 'focus goes back to the opener');
  assert.equal(listeners.length, 0, 'the listener is removed on close');
  dlg.close('again');
  assert.deepEqual(results, ['esc'], 'close is idempotent');

  // A must-answer dialog ignores Escape.
  document.activeElement = opener;
  const must = BotcDialog.open(el, { closeOnEscape: false, onClose: r => results.push(r) });
  listeners[0][1]({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(results.length, 1);
  must.close('ok');
  assert.deepEqual(results, ['esc', 'ok']);
});

test('a11y: the modals use dialog.js, and their pages load it first', () => {
  for (const f of ['rules-gate.js', 'editor-notices.js', 'comments.js', 'art-adjust.js', 'token-tool.js']) {
    assert.match(read('assets/' + f), /BotcDialog/, f + ' adopts assets/dialog.js');
  }
  // comments.js is lazy and fetches it itself.
  assert.match(read('assets/comments.js'), /BotcData\.script\('dialog\.js'\)/);
  const pages = { 'create.html': ['rules-gate.js', 'editor-notices.js', 'art-adjust.js'],
    'edit.html': ['rules-gate.js', 'editor-notices.js', 'art-adjust.js'], 'tokens.html': ['token-tool.js'] };
  for (const [page, users] of Object.entries(pages)) {
    const html = read(page);
    const at = html.indexOf('<script src="assets/dialog.js"></script>');
    assert.ok(at > 0, page + ' loads assets/dialog.js');
    for (const u of users) {
      const ui = html.indexOf('<script src="assets/' + u + '"');
      assert.ok(ui > at, page + ' loads dialog.js before ' + u);
    }
  }
  assert.match(read('tokens.html'), /id="tt-editor" role="dialog" aria-modal="true" aria-labelledby="tte-title"/);
});

// ── 4. Skip link ─────────────────────────────────────────────────────────
test('a11y: site.js adds a skip link, away from the end of the file', () => {
  assert.match(site, /a\.className = 'skip-link'/);
  assert.match(css, /\.skip-link:focus\s*\{/);
  // The end of site.js is where the error beacon lives; new blocks go in
  // the middle so the two never collide.
  const tail = site.split('\n').slice(-40).join('\n');
  assert.doesNotMatch(tail, /skip-link|syncChip/);
});

// ── 5. Search results are a list of links, not a listbox ────────────────
test('a11y: the search drop is not a listbox of options', () => {
  assert.doesNotMatch(site, /role="option"/);
  assert.match(site, /drop\.removeAttribute\('role'\)/);
  assert.match(site, /input\.removeAttribute\('aria-haspopup'\)/);
  assert.match(site, /input\.setAttribute\('aria-controls', 'search-drop'\)/);
  assert.match(site, /className = 'sr-only'/);
  assert.match(css, /\.sr-only\s*\{/);
});

// ── 6. Three-state chips ────────────────────────────────────────────────
test('a11y: chips mirror their state into aria-pressed and show a mark', () => {
  const src = site.slice(site.indexOf('/* a11y-chip:start */'), site.indexOf('/* a11y-chip:end */'));
  assert.ok(src.length > 20, 'syncChip is between the a11y-chip markers');
  const ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.syncChip = syncChip;', ctx);
  function chip(classes, role) {
    const attrs = role ? { role } : {};
    const sets = [];
    return { tagName: 'BUTTON', sets, classList: { contains: c => classes.includes(c) },
      getAttribute: k => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; sets.push([k, v]); } };
  }
  const on = chip(['filter-chip', 'active']), ex = chip(['filter-chip', 'active-exclude']), off = chip(['filter-chip']);
  for (const c of [on, ex, off]) ctx.syncChip(c);
  assert.deepEqual([on, ex, off].map(c => c.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  const tab = chip(['filter-chip', 'active'], 'tab');
  ctx.syncChip(tab);
  assert.deepEqual(tab.sets, [], 'a role="tab" chip is left alone');
  const rule = css.match(/\.filter-chip\.active-exclude:not\(\.filter-chip-curata\)[^{]*::before\s*\{[^}]*\}/);
  assert.ok(rule, 'styles.css draws a mark on an excluded chip');
  assert.match(css, /\.filter-chip\.active-exclude[^{]*::before\s*\{[^}]*text-decoration:\s*none/,
    'the ✕ is not struck through by the chip\'s line-through');
  assert.match(css, /content: "\\2715" \/ "Excluded: "/);
  assert.match(css, /:not\(\.sp-tab\)::before/, 'the /search tabs get no ✓');
});
