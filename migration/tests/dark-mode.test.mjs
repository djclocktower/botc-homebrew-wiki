import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './worker-fixture.mjs';

const require = createRequire(import.meta.url);
const PageRender = require('../../assets/render-page.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = p => readFile(root + p, 'utf8');

const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
const HEAD_SCRIPT = '<script>try{if(localStorage.getItem("botc_theme")==="dark"&&!document.documentElement.hasAttribute("data-own-colours"))document.documentElement.setAttribute("data-theme","dark")}catch(e){}</script>';

// name -> value, from one block of the generated table
function block(css, selector) {
  const begin = css.indexOf('/* ─── Colour table');
  const at = css.indexOf('\n' + selector + ' {', begin);
  assert.ok(begin >= 0 && at > begin, 'colour table has ' + selector);
  const out = {};
  for (const m of css.slice(at, css.indexOf('\n}', at)).matchAll(/--([a-z0-9-]+):([^;]+);/g)) out[m[1]] = m[2];
  return out;
}
function lightness(value) {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value), r, g, b;
  if (m) {
    const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
    [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  } else {
    m = /^rgba\((\d+),(\d+),(\d+),/.exec(value);
    if (!m) return null;
    [r, g, b] = [+m[1], +m[2], +m[3]];
  }
  const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
}

test('every colour is a variable, and the two tables are up to date', () => {
  // The same check a deploy can rely on: nothing left to convert.
  const out = execFileSync(process.execPath, ['migration/theme-vars.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /would change 0 file/);
});

test('the light table is the value in each name; the dark one keeps text light and surfaces dark', async () => {
  const css = await read('assets/styles.css');
  const light = block(css, ':root'), dark = block(css, ':root[data-theme="dark"]');
  assert.ok(Object.keys(light).length > 300);
  for (const [name, value] of Object.entries(light)) {
    const m = /^(?:fg|bg|bd|sh)-([0-9a-f]{3}|[0-9a-f]{6})$/.exec(name);
    if (m) assert.equal(value, '#' + m[1], name);
  }
  for (const name of Object.keys(dark)) assert.ok(name in light, name + ' has a light value');
  for (const name of Object.keys(light)) {
    const value = dark[name] || light[name];
    const opaque = !/^rgba/.test(value), L = lightness(value);
    if (L == null) continue;
    // Text: light enough to read on the night panel. Opaque surfaces: dark
    // enough to carry that text.
    if (/^fg-/.test(name) && opaque) assert.ok(L > .22, name + ' ' + value + ' is too dark for text');
    if (/^bg-/.test(name) && opaque) assert.ok(L < .2, name + ' ' + value + ' is too light for a surface');
  }
  assert.ok(lightness(dark.parch) < .05 && lightness(dark.maroon) > .4 && lightness(dark.ink) > .7);
  // Team colours stay themselves: red is still red, gold still gold.
  assert.match(dark.evil, /^#f/);
  assert.equal(dark['evil-bg'], undefined, 'the evil fill is not recoloured');
  assert.match(css, /--tex-parch:url\('\/assets\/parchment-night-v\d+\.webp'\)/);
});

test('every page sets the theme before first paint, with the same line', async () => {
  for (const file of (await readdir(root)).filter(f => f.endsWith('.html'))) {
    const html = await read(file);
    if (!html.includes('assets/styles.css')) continue;      // a redirect stub
    const at = html.indexOf(HEAD_SCRIPT);
    assert.ok(at > 0, file + ' has the theme script');
    assert.ok(at < html.indexOf('assets/styles.css'), file + ': before the stylesheet');
  }
});

test('a page with colours of its own is never darkened', async t => {
  assert.equal(PageRender.ownsColours(null), false);
  assert.equal(PageRender.ownsColours({ font: 'cinzel', cardW: 300, width: 'wide', background: 'scripts/x-bg.png' }), false);
  assert.equal(PageRender.ownsColours({ accent: '#ff0000' }), true);
  assert.equal(PageRender.ownsColours({ cardBg: '#101010' }), true);
  assert.equal(PageRender.ownsColours({ panelAlpha: 60 }), true);
  assert.equal(PageRender.ownsColours({ css: 'h1{color:red}' }), true);
  assert.doesNotMatch(PageRender.themeAttrs(PageRender.sanitizeTheme({ font: 'cinzel' }, 'x')).cls, /own-colours/);

  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1' });
  for (const [slug, theme] of [['plain', null], ['fonted', { font: 'cinzel' }], ['coloured', { panel: '#101010' }], ['styled', { css: 'h1{color:gold}' }]]) {
    const r = await f.request('/api/script', post(1, { slug, name: slug, author: 'user-1', characters: [], status: 'published', theme }));
    assert.equal(r.status, 200, await r.clone().text());
  }
  const page = async slug => (await f.request('/s/' + slug)).text();
  for (const slug of ['plain', 'fonted']) {
    const html = await page(slug);
    assert.match(html, /<html lang="en" class="redesign-on">/, slug);
    assert.ok(html.includes(HEAD_SCRIPT), slug + ' has the theme script');
  }
  for (const slug of ['coloured', 'styled']) {
    assert.match(await page(slug), /<html lang="en" class="redesign-on" data-own-colours>/, slug);
  }
});

test('the browser helper follows the stored choice and leaves own-colours pages alone', async () => {
  const vm = await import('node:vm');
  const attrs = new Map(), store = new Map(), events = [];
  const html = {
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    hasAttribute: k => attrs.has(k), getAttribute: k => attrs.get(k) ?? null
  };
  const window = { addEventListener() {} };
  const context = vm.createContext({
    window, document: { documentElement: html, baseURI: 'https://x/', dispatchEvent: e => events.push(e.detail.dark), querySelectorAll: () => [], cookie: '' },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    URL, Map, Promise, location: { origin: 'https://x' }, fetch: async () => ({ ok: false }), requestAnimationFrame() {}
  });
  vm.runInContext(await read('assets/data.js'), context);
  const T = window.BotcData.theme;
  assert.equal(T.choice(), 'light');
  assert.equal(T.set('dark'), true);
  assert.equal(attrs.get('data-theme'), 'dark');
  assert.equal(store.get('botc_theme'), 'dark');
  assert.equal(T.ownColours(true), false);
  assert.equal(attrs.has('data-theme'), false, 'own colours win');
  assert.equal(T.choice(), 'dark', 'the choice itself is kept');
  assert.equal(T.ownColours(false), true);
  assert.equal(T.set('light'), false);
  assert.equal(store.has('botc_theme'), false);
  assert.deepEqual(events, [true, false, true, false]);
});
