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

// ── 7. Contrast of the small marks that were under 4.5:1 ───────────────
function luminance(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map(v => v / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
function blend(rgb, alpha, bg) {
  const b = parseInt(bg.slice(1), 16), c = [b >> 16, (b >> 8) & 255, b & 255];
  return '#' + rgb.map((v, i) => Math.round(v * alpha + c[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}
function ruleBody(selector) {
  const m = css.match(new RegExp('(^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
  assert.ok(m, 'styles.css has a ' + selector + ' rule');
  return m[2];
}
test('a11y: the Partial badge, the footer and the browse count are 4.5:1 or better', () => {
  const partial = ruleBody('.page-class-partial');
  const pc = partial.match(/color:\s*(#[0-9a-f]{6})/i)[1];
  assert.match(partial, /opacity:\s*1\b/, 'the Partial badge does not inherit .page-class opacity');
  for (const bg of ['#f7f6f2', '#f0e8d5', '#fffdf8']) assert.ok(ratio(pc, bg) >= 4.5, 'Partial on ' + bg + ': ' + ratio(pc, bg).toFixed(2));

  const foot = ruleBody('.foot').match(/color:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
  const fc = blend([+foot[1], +foot[2], +foot[3]], +foot[4], '#1a0820');
  assert.ok(ratio(fc, '#1a0820') >= 4.5, 'footer: ' + ratio(fc, '#1a0820').toFixed(2));

  const count = ruleBody('.browse-card-count').match(/color:\s*(#[0-9a-f]{6})/i)[1];
  assert.ok(ratio(count, '#f0e8d5') >= 4.5, 'browse count: ' + ratio(count, '#f0e8d5').toFixed(2));
});

// ── 8. Every form control has a name a screen reader can say ───────────
// Pages that existed when this test was written must stay clean. A page
// added later (another branch's new tool, say) is still scanned, and what
// it needs is printed as a diagnostic with the exact one-line fix, but it
// does not fail the suite until it is added to KNOWN_PAGES — so a merge is
// never blocked by surprise. Set A11Y_STRICT=1 to fail on those too.
const ADMIN_EXEMPT = new Set(['dashboard.html', 'text-editor.html', 'normalize-icons.html']);
const KNOWN_PAGES = new Set(('404 account all-characters all-collections articles authors bloodstar character ' +
  'create-script create creators dashboard drafts edit-collection edit-script edit favorites grimforge history ' +
  'iconforge index jinxes login mass-upload messages news normalize-icons profile publish-collection publish-news ' +
  'publish-page publish-script register-collection reset-password rules script-view script scripts search ' +
  'steven-approved-order storyteller suggestions tag tags team text-editor tokens tools').split(' ').map(n => n + '.html'));

export function unlabelledControls(html) {
  const h = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const fors = new Set([...h.matchAll(/<label\b[^>]*\bfor\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]));
  const ranges = [...h.matchAll(/<label\b[\s\S]*?<\/label>/gi)].map(m => [m.index, m.index + m[0].length]);
  const bad = [];
  for (const m of h.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const a = m[2];
    if (/\btype\s*=\s*["']?(hidden|submit|button|reset|image)\b/i.test(a)) continue;
    if (/\b(aria-label|aria-labelledby|title|placeholder)\s*=\s*["'][^"']/i.test(a)) continue;
    const id = (a.match(/\bid\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (id && fors.has(id)) continue;
    if (ranges.some(([s, e]) => m.index > s && m.index < e)) continue;
    const name = (a.match(/\bname\s*=\s*["']([^"']+)["']/i) || [])[1];
    bad.push(m[1].toLowerCase() + (id ? '#' + id : name ? '[name="' + name + '"]' : ' (no id: line ' + (h.slice(0, m.index).split('\n').length) + ')'));
  }
  return bad;
}

test('a11y: every input, select and textarea has a label', t => {
  const failures = [], later = [];
  for (const f of rootHtml) {
    if (ADMIN_EXEMPT.has(f)) continue;
    const bad = unlabelledControls(read(f));
    if (!bad.length) continue;
    const line = f + ': ' + bad.join(', ');
    (KNOWN_PAGES.has(f) ? failures : later).push(line);
  }
  const fix = ' Fix: give each one aria-label="…", a <label for="its-id">, a wrapping <label>, a title or a placeholder.';
  if (later.length) {
    t.diagnostic('Pages this test does not know yet have unlabelled controls (add the page to KNOWN_PAGES once fixed):');
    for (const l of later) t.diagnostic('  ' + l);
    t.diagnostic(fix);
    if (process.env.A11Y_STRICT) failures.push(...later);
  }
  assert.deepEqual(failures, [], 'Unlabelled form controls.' + fix);
  // The scanner itself: each way of naming a control counts, and nothing else.
  assert.deepEqual(unlabelledControls('<input id="a"><label for="b">B</label><input id="b">' +
    '<label>C <select id="c"></select></label><textarea placeholder="d"></textarea><input type="hidden">' +
    '<input aria-label="e"><input title="f"><!-- <input id="g"> --><script>"<input id=h>"</script>'), ['input#a']);
});

test('a11y: the login switch is two toggle buttons, not a half-built tablist', () => {
  const html = read('login.html');
  assert.doesNotMatch(html, /class="login-tabs" role="tablist"/);
  assert.match(html, /id="tab-login" type="button" aria-pressed="true"/);
  assert.match(html, /\$\('tab-signup'\)\.setAttribute\('aria-pressed'/);
});
