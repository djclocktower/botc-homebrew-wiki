// Run with Node 22.13+ / 24: node --test migration/tests/performance.test.mjs
// Uses SQLite and the real renderers; no production services or dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = process.env.BOTC_TEST_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');
const Render = (await import(pathToFileURL(resolve(root, 'assets/render.js')))).default;
const PageRender = (await import(pathToFileURL(resolve(root, 'assets/render-page.js')))).default;
PageRender.init(Render);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('SSR keeps versioned main/alternate art, nested roots and unversioned export URLs', async () => {
  const f = await fixture();
  const d = { slug: 'traveller', page: 'c/test-set/traveller', name: 'Traveller', team: 'traveller',
    art: 'art/traveller.png', artAlt: 'art/traveller-good.png', v: 'current' };
  const html = f.hooks.renderCharacterPage(d, 'https://botchomebrew.wiki', false, false, '');
  assert.match(html, /src="\.\.\/\.\.\/assets\/art\/traveller\.png\?v=current"/);
  assert.match(html, /assets\/art\/traveller-good\.png\?v=current/);
  assert.ok(Render.buildSchema(d).image.every(url => !url.includes('?v=')));
  const preview = Render.renderCharacter(d, 'blob:preview', '../../');
  assert.match(preview, /src="blob:preview"/);
  await f.finish();
});

test('script routes normalize roster identity/address/version and cache local banners', async () => {
  const f = await fixture();
  f.insert('characters', 'sculptor', { slug: 'obsolete', page: 'c/obsolete.html', name: 'Sculptor', team: 'townsfolk', art: 'art/sculptor.png' });
  f.insert('characters', 'secret', { name: 'Secret', team: 'townsfolk' }, 'draft');
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', header: 'scripts/demo.png', logo: 'scripts/logo.png', characters: ['sculptor', 'secret'] });
  const response = await f.request('/s/demo');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /href="\.\.\/c\/test-set\/sculptor"/);
  assert.doesNotMatch(html, /href="\.\.\/c\/obsolete/);
  assert.match(html, /assets\/thumb\/sculptor\.png\.webp\?v=[a-z0-9]+/);
  assert.match(html, /assets\/scripts\/demo\.png\?v=[a-z0-9]+/);
  assert.match(html, /assets\/scripts\/logo\.png\?v=[a-z0-9]+/);
  assert.doesNotMatch(html, /href="\.\.\/c\/test-set\/secret"/);
  await f.finish();
});

test('collection renderer versions local headers and logos without altering remote URLs', () => {
  const local = PageRender.renderCollectionPage({ id: 'demo', slug: 'demo', header: 'collections/demo.png', logo: 'collections/logo.png', v: 'fresh' }, []);
  assert.match(local, /assets\/collections\/demo\.png\?v=fresh/);
  assert.match(local, /assets\/collections\/logo\.png\?v=fresh/);
  const remote = 'https://example.com/logo.png?signature=keep';
  const html = PageRender.renderScriptPage({ slug: 'demo', name: 'Demo', header: remote, logo: remote, v: 'fresh', characters: [] }, []);
  assert.ok(html.includes('src="' + remote + '"'));
  assert.ok(!html.includes('signature=keep?v='));
});

test('Appears in is linked in initial HTML with collection-first alias precedence', async () => {
  const f = await fixture();
  f.insert('collections', 'Old Display Name', { id: 'the-set', slug: 'Old Display Name', displayName: 'The Set', match: ['alias'] });
  f.insert('scripts', 'alias', { slug: 'alias', name: 'Alias' });
  f.insert('characters', 'member', { name: 'Member', team: 'townsfolk', appearsIn: 'Alias' });
  const response = await f.request('/c/test-set/member');
  const html = await response.text();
  assert.match(html, /class="appears-in-link" href="\.\.\/\.\.\/collection\/the-set">Alias<\/a>/);
  assert.match(html, /window\.APPEARS_IN_RESOLVED = true/);
  const missing = f.hooks.renderCharacterPage({ slug: 'x', name: 'X', appearsIn: 'Unmatched' }, 'https://botchomebrew.wiki', false, false, '');
  assert.match(missing, /window\.APPEARS_IN_RESOLVED = true/);
  assert.doesNotMatch(missing, /class="appears-in-link"/);
  const fallback = f.hooks.renderCharacterPage({ slug: 'x', name: 'X', appearsIn: 'Unmatched' }, 'https://botchomebrew.wiki', false, false);
  assert.doesNotMatch(fallback, /APPEARS_IN_RESOLVED/);
  const escaped = Render.renderCharacter({ name: 'X', appearsIn: '<test>' }, '', '', { appearsInHref: 'javascript:alert(1)' });
  assert.doesNotMatch(escaped, /href="javascript:/);
  assert.ok(escaped.includes('&lt;test&gt;'));
  await f.finish();
});

test('excluded members do not inherit an Appears in collection', async () => {
  const f = await fixture();
  f.insert('collections', 'demo', { slug: 'demo', id: 'demo', include: ['kept', 'excluded'], exclude: ['excluded'] });
  const chars = [{ slug: 'kept' }, { slug: 'excluded' }];
  await f.hooks.applyCollectionAppearsIn(f.env, chars);
  assert.equal(chars[0].appearsInFrom[0].id, 'demo');
  assert.equal(chars[1].appearsInFrom, undefined);
  await f.finish();
});

test('24 simultaneous cold feed requests perform one version read and one feed scan', async t => {
  const f = await fixture();
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo' });
  const gate = deferred();
  f.state.intercept = async ({ sql, value }) => { if (sql.includes('FROM scripts')) await gate.promise; return value; };
  const pending = Array.from({ length: 24 }, () => f.request('/scripts.json'));
  await flush();
  gate.resolve();
  const responses = await Promise.all(pending);
  t.diagnostic('24 requests: ' + f.calls.filter(x => x.kind === 'first' && x.sql.includes('SELECT value,')).length +
    ' version reads; ' + f.calls.filter(x => x.kind === 'all' && x.sql.includes('FROM scripts')).length + ' feed scans.');
  assert.equal(f.calls.filter(x => x.kind === 'first' && x.sql.includes('SELECT value,')).length, 1);
  assert.equal(f.calls.filter(x => x.kind === 'all' && x.sql.includes('FROM scripts')).length, 1);
  const bodies = await Promise.all(responses.map(r => r.text()));
  assert.ok(bodies.every(body => body === bodies[0]));
  const etag = responses[0].headers.get('ETag');
  const count = f.calls.length;
  const unchanged = await f.default.fetch(new Request('https://botchomebrew.wiki/scripts.json', { headers: { 'If-None-Match': etag } }), f.env, f.ctx);
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), '');
  assert.equal(f.calls.length, count);
  await f.finish();
});

test('a failed feed build can retry, and edits invalidate its completed cache', async () => {
  const f = await fixture();
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Before' });
  let fail = true;
  f.state.intercept = ({ sql, value }) => { if (fail && sql.includes('FROM scripts')) throw new Error('temporary D1 failure'); return value; };
  await assert.rejects(f.request('/scripts.json'), /temporary D1 failure/);
  fail = false;
  assert.match(await (await f.request('/scripts.json')).text(), /Before/);
  f.db.prepare('UPDATE scripts SET data=? WHERE slug=?').run(JSON.stringify({ slug: 'demo', name: 'After' }), 'demo');
  await f.hooks.bumpContentVersion(f.env);
  const updated = await f.request('/scripts.json');
  assert.match(updated.headers.get('ETag'), /v8/);
  assert.match(await updated.text(), /After/);
  await f.finish();
});

test('a late version read cannot repopulate the memo after a save', async () => {
  const f = await fixture();
  const gate = deferred();
  let first = true;
  f.state.intercept = async ({ sql, value }) => {
    if (first && sql.includes('SELECT value,')) { first = false; await gate.promise; }
    return value;
  };
  const old = f.hooks.contentVersion(f.env);
  await f.hooks.bumpContentVersion(f.env);
  gate.resolve();
  assert.equal(await old, '7');
  assert.equal(await f.hooks.contentVersion(f.env), '8');
  await f.finish();
});

test('failed version reads are retried instead of memoizing version zero', async () => {
  const f = await fixture();
  let fail = true;
  f.state.intercept = ({ value }) => { if (fail) throw new Error('temporary'); return value; };
  assert.equal(await f.hooks.contentVersion(f.env), '0');
  fail = false;
  assert.equal(await f.hooks.contentVersion(f.env), '7');
  await f.finish();
});

async function searchFixture(fetcher) {
  const source = await read('assets/site.js');
  const handlers = new Map();
  function element(id) {
    return { value: '', hidden: true, innerHTML: '', setAttribute() {}, blur() {}, contains() { return false; },
      addEventListener(event, callback) { handlers.set(id + ':' + event, callback); } };
  }
  const input = element('input'), drop = element('drop'), wrap = element('wrap'), mobile = element('mobile'), menu = element('menu');
  const context = vm.createContext({
    window: {}, URL, location: { origin: 'https://botchomebrew.wiki' },
    document: { baseURI: 'https://botchomebrew.wiki/', getElementById: id => ({ 'search-input': input, 'search-drop': drop, 'search-wrap': wrap, 'nav-search-input': mobile, hamburger: menu })[id] || null,
      addEventListener(event, callback) { handlers.set('document:' + event, callback); } },
    fetch: url => fetcher(new URL(url).pathname.slice(1) + new URL(url).search), ROOT: '', GOOD: { townsfolk: true }, TEAM_LABEL: {},
    esc: s => String(s).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    setTimeout, clearTimeout
  });
  vm.runInContext(await read('assets/data.js'), context);
  vm.runInContext(source.slice(source.indexOf('  /* ── Search ── */'), source.indexOf('  /* ── Mobile nav ── */')), context);
  return { input, drop, mobile, dispatch(id, event, data = {}) { handlers.get(id + ':' + event)?.(data); } };
}
const ok = rows => ({ ok: true, json: async () => rows });

test('search warms on touch/keyboard focus and cached searches have no 150ms delay', async () => {
  let requests = 0;
  const f = await searchFixture(async path => { requests++; return ok(path.startsWith('characters') ? [{ name: 'Sculptor', page: 'c/set/sculptor' }] : []); });
  f.dispatch('input', 'focus');
  assert.equal(requests, 3);
  await flush();
  f.input.value = 'Sculptor';
  f.dispatch('input', 'input');
  assert.equal(f.drop.hidden, false);
  assert.match(f.drop.innerHTML, /Sculptor/);
  assert.equal(requests, 3);
});

test('search retries failed HTTP responses and ignores results after clearing or Escape', async () => {
  let fail = true, characterRequests = 0;
  const gate = deferred();
  const f = await searchFixture(async path => {
    if (!path.startsWith('characters')) return ok([]);
    characterRequests++;
    if (fail) return { ok: false, json: async () => ({ error: 'temporary' }) };
    await gate.promise;
    return ok([{ name: 'Sculptor', page: 'c/set/sculptor' }]);
  });
  f.dispatch('input', 'focus');
  await flush();
  fail = false;
  f.input.value = 'Sculptor';
  f.dispatch('input', 'input');
  f.input.value = '';
  f.dispatch('input', 'input');
  gate.resolve();
  await flush();
  assert.equal(characterRequests, 2);
  assert.equal(f.drop.hidden, true);

  const secondGate = deferred();
  const next = await searchFixture(async path => { await secondGate.promise; return ok(path.startsWith('characters') ? [{ name: 'Sculptor' }] : []); });
  next.input.value = 'Sculptor';
  next.dispatch('input', 'input');
  next.dispatch('input', 'keydown', { key: 'Escape' });
  secondGate.resolve();
  await flush();
  assert.equal(next.drop.hidden, true);
});

test('only the latest query paints after a shared request finishes', async () => {
  const gate = deferred();
  let requests = 0;
  const f = await searchFixture(async path => { requests++; await gate.promise; return ok(path.startsWith('characters') ? [{ name: 'Sculptor' }, { name: 'Oracle' }] : []); });
  f.input.value = 'Sculptor'; f.dispatch('input', 'input');
  f.input.value = 'Oracle'; f.dispatch('input', 'input');
  gate.resolve(); await flush();
  assert.match(f.drop.innerHTML, /Oracle/);
  assert.doesNotMatch(f.drop.innerHTML, /Sculptor/);
  assert.equal(requests, 3);
});

test('the actual mobile field warms data and closing the menu cancels pending results', async () => {
  const gate = deferred();
  let requests = 0;
  const f = await searchFixture(async () => { requests++; await gate.promise; return ok([]); });
  f.mobile.value = 'Oracle';
  f.dispatch('mobile', 'focus');
  assert.equal(requests, 3);
  assert.equal(f.input.value, 'Oracle');
  f.dispatch('menu', 'click');
  gate.resolve(); await flush();
  assert.equal(f.drop.hidden, true);
});

test('resolved Appears in markup skips both browser feed requests', async () => {
  let requests = 0;
  const field = { textContent: 'A Set', querySelector() { return null; }, getAttribute() { return 'A Set'; } };
  const context = vm.createContext({
    window: { CHAR_SLUG: 'demo', APPEARS_IN_RESOLVED: true }, location: { hash: '' },
    document: { getElementById: id => id === 'content' ? {} : null,
      querySelector: selector => selector === '.info-appears-in' ? field : null },
    fetch: async () => { requests++; return ok([]); }
  });
  vm.runInContext(await read('assets/charpage.js'), context);
  await flush();
  assert.equal(requests, 0);
  context.window.APPEARS_IN_RESOLVED = false;
  vm.runInContext(await read('assets/charpage.js'), context);
  await flush();
  assert.equal(requests, 2);
});

test('empty browse results disconnect the previous viewport renderer', async () => {
  const source = await read('all-characters.html');
  const renderer = source.slice(source.indexOf('    function render(){'), source.indexOf('    Promise.all([', source.indexOf('    function render(){')));
  let cancelled = 0;
  const panel = { innerHTML: '' };
  let list = Array.from({ length: 200 }, (_, id) => ({ team: 'townsfolk', id }));
  const state = { includeTeams: [], excludeTeams: [], includeTags: [], excludeTags: [], includeSources: [], excludeSources: [], includeCreators: [], excludeCreators: [] };
  const context = vm.createContext({ applyFilters: () => list, STATE: state, FULL: list,
    TEAMS: [['townsfolk', 'Townsfolk']], card: () => '<a>card</a>',
    window: { mountCardBatches() { return () => { cancelled++; }; } },
    document: { getElementById: id => id === 'panel' ? panel : id === 'filter-count' ? {} : null } });
  vm.runInContext(renderer + '\nrender();', context);
  list = [];
  vm.runInContext('render();', context);
  assert.match(panel.innerHTML, /No characters match/);
  assert.equal(cancelled, 1);
});
