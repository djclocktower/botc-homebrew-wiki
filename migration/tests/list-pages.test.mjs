import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fixture } from './worker-fixture.mjs';

const require = createRequire(import.meta.url);
const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');

// The browser's card, built by the same file the page loads, with the same
// helpers the page has on window.
function browserCF() {
  const CF = require('../../assets/char-filters.js');
  CF.init({ Classify: require('../../assets/classify.js'), CardActions: require('../../assets/card-actions.js'),
    splitCreators: require('../../assets/creators.js').splitCreators });
  return CF;
}

const ABILITY = 'Each night, choose a player.';
function seed(f) {
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, '0');
    f.insert('characters', 'town-' + n, { name: 'Town ' + n, team: 'townsfolk', ability: ABILITY,
      creator: i % 2 ? 'Moll' : 'Saki', tags: i % 3 ? 'Information' : 'Death, Information', art: 'art/town-' + n + '.png' });
  }
  f.insert('characters', 'imp-ish', { name: 'Impish', team: 'demon', ability: 'Each night*, choose a player: they die.', creator: 'Moll', tags: 'Death' });
  f.insert('characters', 'secret-draft', { name: 'Secret Draft', team: 'demon', ability: 'Hidden.', tags: 'Death' }, 'draft');
  f.insert('collections', 'odyssey', { id: 'odyssey', displayName: 'Odyssey', match: ['odyssey'], include: ['town-01'] });
}

test('list pages: the first screen of cards is in the HTML, drawn exactly as the browser draws it', async t => {
  const f = await fixture(); t.after(() => f.finish()); seed(f);
  const CF = browserCF();
  const grid = await (await f.request('/characters.json?fields=grid')).json();
  const res = await f.request('/all-characters');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('Set-Cookie'), null);
  const html = await res.text();
  assert.match(html, /<main class="home-panel list-panel" id="panel" data-ssr="1" data-ssr-sig="/);
  // Same order and grouping as the default view: townsfolk A–Z, first 48.
  const sorted = grid.filter(c => c.team === 'townsfolk').sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted.slice(0, 48)) assert.ok(html.includes(CF.card(c)), 'card for ' + c.name);
  assert.ok(!html.includes(CF.card(sorted[48])), 'the 49th card waits for the browser');
  assert.match(html, /data-total="60"/);
  assert.match(html, /<div class="card-spacer" aria-hidden="true"><\/div><button type="button" class="card-load-more">Show more \(12 remaining\)<\/button>/);
  // Other teams: a heading and a button, drawn on approach.
  assert.match(html, /id="demon"[\s\S]*?<button type="button" class="card-load-more">Show 1 characters<\/button>/);
  // The filter box is there, greyed out until the list arrives, and the count.
  assert.match(html, /<div id="filter-bar" class="filter-bar cf-loading" aria-busy="true"><div class="filter-group">/);
  assert.match(html, /data-tag="Death"/);
  assert.match(html, /data-source="collection"/);
  assert.match(html, /<p id="filter-count" class="filter-count">61 characters<span class="cf-loading-note">/);
  assert.match(html, /<button type="button" id="filter-toggle" class="filter-toggle" aria-expanded/);
  // The feeds are no longer preloaded: the cards are here already.
  assert.doesNotMatch(html, /rel="preload" href="characters\.json/);
  // Drafts never reach it.
  assert.doesNotMatch(html, /Secret Draft|secret-draft/);
  // The bar is the browser's bar.
  const colls = await (await f.request('/collections.json?fields=browse')).json();
  const scripts = await (await f.request('/scripts.json?fields=browse')).json();
  const sourceOf = CF.makeSourceOf(colls, scripts);
  const model = CF.barModel(grid, sourceOf);
  assert.ok(html.includes(CF.barHTML(model, CF.config(), { creatorChips: CF.creatorListHTML(model.creators, '') })));
});

test('list pages: team and tag pages honour ?t=, end with the add card, and fall back when they cannot draw', async t => {
  const f = await fixture(); t.after(() => f.finish()); seed(f);
  const CF = browserCF();
  const grid = await (await f.request('/characters.json?fields=grid')).json();

  const demon = await (await f.request('/team?t=demon')).text();
  assert.match(demon, /<title>Demon — BOTC HomeBrew Wiki<\/title>/);
  assert.match(demon, /<h1 id="hero-title">Demon<\/h1>/);
  assert.ok(demon.includes(CF.card(grid.find(c => c.slug === 'imp-ish'))));
  assert.doesNotMatch(demon, /Town 0|Secret Draft/);
  // All of them fit, so the "+ Add a Demon" card closes the grid and the button is hidden.
  assert.match(demon, /\+ Add a Demon<\/a><\/div><div class="card-spacer" aria-hidden="true"><\/div><button type="button" class="card-load-more" hidden>/);

  const town = await (await f.request('/team?t=townsfolk')).text();
  assert.equal((town.match(/class="char-card" href=/g) || []).length, 48);
  assert.doesNotMatch(town, /Add a Townsfolk/);   // only after the last card
  assert.match(town, /Show more \(12 remaining\)/);
  // Feed order, as the page always drew it.
  assert.ok(town.indexOf('Town 00') < town.indexOf('Town 01'));

  const death = await (await f.request('/tag?t=DEATH')).text();
  assert.match(death, /<h1 id="hero-title">Death<\/h1>/);
  assert.match(death, /<p id="hero-desc">Kills players, or cares about players dying\.<\/p>/);
  assert.equal((death.match(/class="char-card" href=/g) || []).length, 21);
  assert.doesNotMatch(death, /Secret Draft/);

  // What the server cannot draw is the static page, as before.
  for (const path of ['/team?t=nobody', '/tag?t=no-such-tag', '/tag', '/all-characters?favorites=1', '/all-characters?collection=Standalone']) {
    const body = await (await f.request(path)).text();
    assert.doesNotMatch(body, /data-ssr="1"/, path);
    assert.match(body, /<main class="home-panel list-panel" id="panel">/, path);
  }
});

test('list pages: one shared copy for everyone, keyed on the content, never on the reader', async t => {
  const f = await fixture(); t.after(() => f.finish()); seed(f);
  const anon = await (await f.request('/team?t=demon')).text();
  await Promise.all(f.background);
  const before = f.calls.length;
  const member = await f.request('/team?t=demon', { headers: { Cookie: 'botc_session=whatever' } });
  assert.equal(await member.text(), anon);
  assert.equal(member.headers.get('Set-Cookie'), null);
  // Served from the edge copy: no table was read for it.
  assert.ok(!f.calls.slice(before).some(c => /FROM characters/.test(c.sql)));
  // A new character is a new version, so the next reader sees it.
  f.insert('characters', 'new-demon', { name: 'Newcomer', team: 'demon', ability: 'Each day, wave.' });
  await f.hooks.bumpContentVersion(f.env, 'character');
  assert.match(await (await f.request('/team?t=demon')).text(), /Newcomer/);
});

test('list pages: the browser adopts the server cards and its own markup matches', async () => {
  const CF = browserCF();
  const items = Array.from({ length: 60 }, (_, i) => ({ slug: 's' + i, page: 'c/x/s' + i, name: 'N' + i, team: 'townsfolk', ability: 'A' }));
  const laid = CF.singleGrid(items, '<a class="char-card empty-card" href="create">+</a>');
  const html = CF.batchedHTML(laid, c => CF.card(c));
  assert.equal(CF.layoutSig(laid.groups), '.char-grid[data-group="list"]');
  assert.match(html, /^<div class="type-section"><div class="char-grid" data-group="list" data-total="60" data-tail="1">/);
  assert.match(html, /<button type="button" class="card-load-more">Show more \(12 remaining\)<\/button><\/div>$/);
  assert.equal(CF.loadMoreLabel(60, 48, true), 'Show more (12 remaining)');
  assert.equal(CF.loadMoreLabel(7, 0, false), 'Show 7 characters');
});

/* A small stand-in for the DOM: enough for viewport.js to adopt, append,
   insert its spacer and button and measure nothing. */
class El {
  constructor(cls, attrs) { this.className = cls || ''; this.attrs = attrs || {}; this.children = []; this.parent = null; this.style = {}; this.listeners = {}; this.hidden = false; this.textContent = ''; this.rect = { top: 0, bottom: 0, height: 0 }; }
  get nextElementSibling() { const p = this.parent; return p ? p.children[p.children.indexOf(this) + 1] || null : null; }
  insertAdjacentElement(_, el) { el.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, el); }
  insertAdjacentHTML(_, html) {
    const re = /<a class="([^"]*)" href="([^"]*)"/g; let m;
    while ((m = re.exec(html))) { const a = new El(m[1], { href: m[2] }); a.parent = this; this.children.push(a); }
  }
  set innerHTML(v) { this.children = []; if (v) this.insertAdjacentHTML('beforeend', v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  removeEventListener() {}
  click() { if (this.listeners.click) this.listeners.click({ target: this }); }
  querySelector(sel) {
    const m = /data-group="([^"]*)"/.exec(sel), want = m && m[1];
    const walk = el => { for (const c of el.children) { if (want ? c.attrs['data-group'] === want : (' ' + c.className + ' ').includes(' ' + sel.slice(1) + ' ')) return c; const r = walk(c); if (r) return r; } return null; };
    return walk(this);
  }
  closest() { return null; }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return this.rect; }
}
async function viewport(extra) {
  let intersect = null; const observed = new Set(), frames = [], idles = [];
  const context = vm.createContext({ window: { innerHeight: 800, ...extra },
    document: { createElement: () => new El(), readyState: 'complete' },
    IntersectionObserver: class { constructor(cb) { intersect = cb; } observe(x) { observed.add(x); } unobserve(x) { observed.delete(x); } disconnect() { observed.clear(); } } });
  context.window.requestAnimationFrame = cb => frames.push(cb);
  context.window.requestIdleCallback = cb => idles.push(cb);
  vm.runInContext(await read('assets/viewport.js'), context);
  return { mount: context.window.mountCardBatches, frames, idles, observed, intersect: e => intersect(e),
    flush() { while (frames.length) frames.shift()(); } };
}
function host(names) {
  const h = new El();
  for (const n of names) { const g = new El('char-grid', { 'data-group': n }); g.parent = h; h.children.push(g); }
  return h;
}
const FAR = { top: 99999, bottom: 99999, height: 0 };
const items = n => Array.from({ length: n }, (_, i) => ({ page: 'c/x/' + i }));
const card = c => '<a class="char-card" href="' + c.page + '">';

test('card batches: one step per frame on approach, stop below the screen, cancel cleanly', async () => {
  const v = await viewport();
  const h = host(['a', 'b']);
  const cancel = v.mount(h, [{ selector: '[data-group="a"]', items: items(200) }, { selector: '[data-group="b"]', items: items(200) }], card);
  const a = h.children[0], b = h.children[3];   // grid, spacer, button, grid…
  assert.equal(a.children.length, 48); assert.equal(b.children.length, 0);
  assert.equal(a.nextElementSibling.className, 'card-spacer');
  assert.equal(a.nextElementSibling.nextElementSibling.textContent, 'Show more (152 remaining)');
  const bSpacer = b.nextElementSibling, bButton = bSpacer.nextElementSibling;
  assert.equal(bButton.textContent, 'Show 200 characters');
  v.flush(); assert.equal(a.children.length, 48);   // nothing near: nothing drawn
  bSpacer.rect = FAR;
  v.intersect([{ target: bSpacer, isIntersecting: true }]);
  assert.equal(b.children.length, 0);                // never inside the observer callback
  v.frames.shift()(); assert.equal(b.children.length, 24);
  assert.equal(v.frames.length, 0);                  // out of reach: it stops
  a.nextElementSibling.nextElementSibling.click(); assert.equal(a.children.length, 96);
  cancel(); v.flush();
  v.intersect([{ target: bSpacer, isIntersecting: true }]); v.flush();
  assert.equal(b.children.length, 24); assert.equal(v.observed.size, 0);
});

test('card batches: server cards are adopted when they are the list, redrawn when not', async () => {
  const v = await viewport();
  const h = host(['a', 'b']);
  const CF = browserCF();
  const list = items(100);
  // What the server printed: the first 48 in grid a, nothing in b.
  h.children[0].insertAdjacentHTML('beforeend', list.slice(0, 48).map(card).join(''));
  for (const g of [h.children[1], h.children[0]]) {
    const sp = new El('card-spacer'), bt = new El('card-load-more');
    g.insertAdjacentElement('afterend', bt); g.insertAdjacentElement('afterend', sp);
  }
  const first = h.children[0].children[0];
  v.mount(h, [{ selector: '[data-group="a"]', items: list }, { selector: '[data-group="b"]', items: items(3) }], card, { adopt: true });
  assert.equal(h.children.length, 6);                 // no second spacer or button
  assert.equal(h.children[0].children[0], first);     // the same nodes, not redrawn
  assert.equal(h.children[0].children.length, 48);
  assert.equal(h.children[2].textContent, CF.loadMoreLabel(100, 48, true));
  assert.equal(h.children[5].textContent, CF.loadMoreLabel(3, 0, false));
  // A list that moved on since the server drew it is drawn afresh.
  const h2 = host(['a']);
  h2.children[0].insertAdjacentHTML('beforeend', card({ page: 'c/x/old' }));
  v.mount(h2, [{ selector: '[data-group="a"]', items: list }], card, { adopt: true });
  assert.equal(h2.children[0].children[0].getAttribute('href'), 'c/x/0');
  assert.equal(h2.children[0].children.length, 48);
});

test('card batches: a short first batch finishes in later frames, and idle time draws ahead', async () => {
  const v = await viewport();
  const h = host(['a']);
  v.mount(h, [{ selector: '[data-group="a"]', items: items(100), tail: '<a class="char-card empty-card" href="create">' }], card, { first: 16 });
  const a = h.children[0];
  assert.equal(a.children.length, 16);
  a.nextElementSibling.rect = FAR;                    // the reader is far above the end
  v.frames.shift()(); assert.equal(a.children.length, 40);
  v.flush(); assert.equal(a.children.length, 40);
  // In reach of the idle look-ahead (two margins), not of the observer.
  a.nextElementSibling.rect = { top: 2500, bottom: 2500, height: 0 };
  v.idles.shift()({ timeRemaining: () => 50 });
  assert.equal(a.children.length, 64);
  for (let i = 0; i < 5 && v.idles.length; i++) v.idles.shift()({ timeRemaining: () => 50 });
  assert.equal(a.children.length, 101);               // the tail card closes the grid
  assert.equal(a.children[100].className, 'char-card empty-card');
  assert.equal(a.nextElementSibling.nextElementSibling.hidden, true);
});

test('a server-drawn page fetches its list once: on idle, on a tap, or for the "Show more" it was asked for', async () => {
  const winListeners = {};
  const v = await viewport({ addEventListener: (t, fn) => { winListeners[t] = fn; }, removeEventListener: t => { delete winListeners[t]; } });
  const h = host(['a']);
  const sp = new El('card-spacer'), bt = new El('card-load-more');
  h.children[0].insertAdjacentElement('afterend', bt); h.children[0].insertAdjacentElement('afterend', sp);
  h.querySelectorAll = () => [sp];
  const calls = [];
  v.mount.whenNeeded(h, b => calls.push(b));
  assert.deepEqual(calls, []);                            // nothing until it is needed
  h.listeners.click({ target: { closest: () => bt } });   // "Show more" before the list came
  assert.equal(calls.length, 1); assert.equal(calls[0], bt);
  v.idles.forEach(cb => cb({ timeRemaining: () => 50 }));
  winListeners.scroll && winListeners.scroll();
  assert.equal(calls.length, 1);                          // once
  const idleOnly = [];
  v.mount.whenNeeded(host(['b']), b => idleOnly.push(b));
  v.idles.forEach(cb => cb({ timeRemaining: () => 50 }));
  assert.deepEqual(idleOnly, [null]);
});
