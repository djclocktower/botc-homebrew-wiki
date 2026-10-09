// Run with Node 22.13+ / 24: node --test migration/tests/fix-caching.test.mjs
// Regression tests for feed/SSR cache invalidation and fail-closed reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixture } from './worker-fixture.mjs';

const IMP_ABILITY = 'Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp.';
const as = token => ({ headers: { Cookie: 'botc_session=' + token } });
const post = (token, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=' + token, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
function accounts(f) {
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'boss','',1)").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(2,'maker','')").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'boss', isAdmin: true });
  f.state.sessions.set('sess:maker', { userId: 2, username: 'maker' });
}
const json = async (f, path, opts) => JSON.parse(await (await f.request(path, opts)).text());
const ssrKeys = f => [...f.cache.keys()].filter(k => k.startsWith('https://ssr.internal'));
const settle = f => Promise.all(f.background);
const failOn = (f, re) => {
  f.state.intercept = ({ sql, value }) => { if (re.test(sql)) throw new Error('D1 blip'); return value; };
};

test('ban-purge takes the account\'s pages out of the feeds and the shared SSR cache', async t => {
  const f = await fixture(); t.after(() => f.finish()); accounts(f);
  f.insert('characters', 'spam', { name: 'Spam', team: 'townsfolk', ability: 'x', art: 'art/spam.png' });
  f.db.prepare("UPDATE characters SET owner_id=2 WHERE slug='spam'").run();
  assert.equal((await json(f, '/characters.json')).length, 1);
  assert.equal((await f.request('/c/test-set/spam')).status, 200);
  await settle(f);
  assert.equal(ssrKeys(f).length, 1);
  const r = await f.request('/api/admin/user', post('admin', { id: 2, action: 'ban-purge' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await json(f, '/characters.json'), []);
  assert.equal((await f.request('/c/test-set/spam')).status, 404);
});

test('concepts-to-pages, clean-refs and official-cleanup roll the feeds they rewrite', async t => {
  const f = await fixture(); t.after(() => f.finish()); accounts(f);
  f.insert('characters', 'state', { name: 'State', team: 'fabled', appearsIn: 'Rules', ability: 'A rule.', lede: 'A thing.' });
  f.insert('characters', 'imp-copy', { name: 'Imp', team: 'demon', ability: IMP_ABILITY, art: 'art/imp.png' });
  f.insert('collections', 'rules', { id: 'rules', displayName: 'Rules' });
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['imp-copy', 'gone'] });
  await f.hooks.ensurePagesTable(f.env);
  const charSlugs = async () => (await json(f, '/characters.json?fields=grid')).map(c => c.slug).sort();
  const roster = async () => (await json(f, '/scripts.json?fields=browse'))[0].characters;
  assert.deepEqual(await charSlugs(), ['imp-copy', 'state']);
  assert.deepEqual(await roster(), ['imp-copy', 'gone']);

  assert.equal((await f.request('/api/admin/concepts-to-pages', post('admin', { from: 'Rules', parent: 'rules' }))).status, 200);
  assert.deepEqual(await charSlugs(), ['imp-copy'], 'the retired character leaves the feed at once');

  assert.equal((await f.request('/api/admin/clean-refs', post('admin', { type: 'script', slug: 'demo', remove: ['gone'] }))).status, 200);
  assert.deepEqual(await roster(), ['imp-copy']);

  assert.equal((await f.request('/api/admin/official-cleanup', post('admin', {}))).status, 200);
  assert.deepEqual(await roster(), ['off-imp'], 'the repointed roster reaches the browse feed');
});

test('the sitemap fails closed and never caches a degraded answer', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('scripts', 'live', { name: 'Live' });
  f.insert('scripts', 'secret', { name: 'Secret' }, 'draft');
  failOn(f, /FROM scripts WHERE status='published'/);
  const bad = await f.request('/sitemap.xml');
  const badBody = await bad.text();
  assert.doesNotMatch(badBody, /secret/);
  assert.equal(bad.headers.get('Cache-Control'), 'no-store');
  await settle(f);
  assert.ok(![...f.cache.keys()].some(k => k.includes('sitemap')));
  f.state.intercept = null;
  const good = await (await f.request('/sitemap.xml')).text();
  assert.match(good, /\/s\/live/);
  assert.doesNotMatch(good, /secret/);
});

test('/api/user never falls back to unfiltered rows, and a failed read is not cached', async t => {
  const f = await fixture(); t.after(() => f.finish()); accounts(f);
  f.insert('characters', 'shown', { name: 'Shown', creator: 'maker', ability: 'x' });
  f.insert('characters', 'hidden', { name: 'Hidden', creator: 'maker', ability: 'x' }, 'draft');
  f.db.prepare('UPDATE characters SET owner_id=2').run();
  failOn(f, /SELECT slug, data, status FROM characters WHERE/);
  const bad = await json(f, '/api/user?u=maker');
  assert.deepEqual(bad.characters, []);
  await settle(f);
  assert.ok(![...f.cache.keys()].some(k => k.includes('user.json')));
  f.state.intercept = null;
  const good = await json(f, '/api/user?u=maker');
  assert.deepEqual(good.characters.map(c => c.slug), ['shown']);
});

test('the search index drops suspended accounts and does not cache a failed read', async t => {
  const f = await fixture(); t.after(() => f.finish()); accounts(f);
  f.db.prepare("ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0").run();
  f.db.prepare("UPDATE users SET banned=1, avatar_url='https://x.test/a.png' WHERE id=2").run();
  f.insert('characters', 'mine', { name: 'Mine', creator: 'maker', ability: 'x' });
  f.db.prepare("UPDATE characters SET owner_id=2, creator='maker'").run();
  failOn(f, /FROM users WHERE COALESCE\(banned,0\)=0/);
  const bad = await f.request('/api/search-index');
  assert.equal(bad.headers.get('Cache-Control'), 'no-store');
  assert.equal(bad.headers.get('ETag'), null);
  assert.deepEqual((await bad.json()).users, []);
  f.state.intercept = null;
  const good = await json(f, '/api/search-index');
  assert.deepEqual(good.users.map(u => u.username), ['boss']);
  const maker = good.creators.find(c => c.name === 'maker');
  assert.ok(maker);
  assert.equal(maker.username, undefined, 'a suspended account is not attached to its credit');
  assert.equal(maker.avatarUrl, undefined);
});

test('the creators list follows resolveCreatorAccount: scripts count, and a disown on a script wins', async t => {
  const f = await fixture(); t.after(() => f.finish()); accounts(f);
  f.insert('scripts', 'by-maker', { name: 'By Maker', author: 'Penname' });
  f.db.prepare("UPDATE scripts SET author='Penname', owner_id=2").run();
  const creators = async () => (await json(f, '/api/creators')).creators;
  assert.equal((await creators()).find(c => c.name === 'Penname').username, 'maker');
  // The same name on a character, ticked "not mine" on a script.
  f.insert('characters', 'pc', { name: 'PC', creator: 'Penname', ability: 'x' });
  f.db.prepare("UPDATE characters SET creator='Penname', owner_id=2").run();
  f.db.prepare(`UPDATE scripts SET data='{"name":"By Maker","author":"Penname","creditUnlinked":true}'`).run();
  await f.hooks.bumpContentVersion(f.env, 'script');
  assert.equal((await creators()).find(c => c.name === 'Penname').username, null);
  assert.equal((await f.request('/author?a=Penname')).status, 200, 'and /author agrees: no redirect');
});

test('a creator\'s Curata opt-out holds on script rosters and their creator page', async t => {
  const f = await fixture(); t.after(() => f.finish()); accounts(f);
  f.insert('characters', 'shy', { name: 'Shy', creator: 'maker', ability: 'x', curata: true, curataOptOut: true });
  f.insert('collections', 'gold', { id: 'gold', displayName: 'Gold', curata: true, include: ['shy'] });
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['shy'] });
  f.db.prepare('UPDATE characters SET owner_id=2').run();
  const html = await (await f.request('/s/demo')).text();
  assert.doesNotMatch(html, /data-curata="1"/);
  const profile = await json(f, '/api/user?u=maker');
  assert.equal(profile.characters[0].curata, undefined);
});

test('an SSR page rendered without its registries is served but not cached, and nothing failed is memoised', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('characters', 'hero', { name: 'Hero', ability: 'x', lede: 'Friend of [[Sidekick]].' });
  f.insert('characters', 'sidekick', { name: 'Sidekick', ability: 'x' });
  // The /c/ route's own row read still works; the card feed behind the
  // [[Name]] link map and the jinx index does not.
  failOn(f, /SELECT data, status, slug, url_slug, updated_at FROM characters WHERE status='published'/);
  const bad = await f.request('/c/test-set/hero');
  assert.equal(bad.status, 200);
  assert.equal(bad.headers.get('X-Botc-Degraded'), null, 'the internal marker never leaves the Worker');
  await settle(f);
  assert.deepEqual(ssrKeys(f), []);
  f.state.intercept = null;
  const good = await (await f.request('/c/test-set/hero')).text();
  assert.match(good, /href="[^"]*c\/test-set\/sidekick"/, 'the link map was not memoised empty');
  await settle(f);
  assert.equal(ssrKeys(f).length, 1);
});

test('a failed official roster is not memoised, and the official-character guard fails closed', async t => {
  const f = await fixture(); t.after(() => f.finish()); accounts(f);
  const real = f.env.ASSETS.fetch;
  f.env.ASSETS.fetch = async request => new URL(request.url).pathname === '/assets/roles.json'
    ? new Response('nope', { status: 503 }) : real(request);
  const imp = { slug: 'imp-again', name: 'Imp', team: 'demon', ability: IMP_ABILITY, art: 'art/imp.png' };
  const refused = await f.request('/api/character', post('maker', imp));
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /try again/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM characters").get().n, 0);
  f.env.ASSETS.fetch = real;
  const exact = await f.request('/api/character', post('maker', imp));
  assert.equal(exact.status, 400, 'the next request loads the roster and refuses the copy');
});

test('one unparseable row does not take the feeds down; legacy sets get their PK slug', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('characters', 'fine', { name: 'Fine', ability: 'x' });
  f.db.prepare("INSERT INTO characters(slug,name,data,status,team) VALUES('broken','Broken','{not json','published','townsfolk')").run();
  f.insert('scripts', 'legacy-script', { name: 'Legacy' });
  f.insert('collections', 'The Academy', { displayName: 'The Academy' });
  const chars = await f.request('/characters.json');
  assert.equal(chars.status, 200);
  assert.deepEqual((await chars.json()).map(c => c.slug), ['fine']);
  assert.equal((await json(f, '/scripts.json?fields=browse'))[0].slug, 'legacy-script');
  assert.equal((await json(f, '/collections.json'))[0].slug, 'The Academy');
  assert.equal((await f.request('/api/home')).status, 200);
});

test('a pinned article older than the newest three still reaches the homepage cards', async t => {
  const f = await fixture(); t.after(() => f.finish());
  await f.request('/api/news');
  const add = f.db.prepare('INSERT INTO news(slug,title,status,published_at,data) VALUES(?,?,?,?,?)');
  add.run('pinned-old', 'Pinned', 'published', '2026-01-01', JSON.stringify({ pinned: true, body: 'x' }));
  for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
    add.run('n-' + d, 'N ' + d, 'published', d, JSON.stringify({ body: 'x' }));
  }
  await f.hooks.bumpContentVersion(f.env, 'news');
  const { html } = await json(f, '/api/news?limit=3&format=cards');
  assert.match(html, /news\/pinned-old/);
  assert.ok(html.indexOf('pinned-old') < html.indexOf('n-2026-09-04'));
  assert.doesNotMatch(html, /n-2026-09-02/);
});

test('a script or collection banner hosted elsewhere is its og:image as given', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('scripts', 'remote', { slug: 'remote', name: 'Remote', header: 'https://img.example/banner.png', characters: [] });
  f.insert('scripts', 'local', { slug: 'local', name: 'Local', logo: 'scripts/local.png', characters: [] });
  const og = async path => (await (await f.request(path)).text()).match(/property="og:image" content="([^"]+)"/)[1];
  assert.equal(await og('/s/remote'), 'https://img.example/banner.png');
  assert.equal(await og('/s/local'), 'https://botchomebrew.wiki/assets/scripts/local.png');
});

test('BUILD_ID rolls when the official data files change', async t => {
  const root = await mkdtemp(join(tmpdir(), 'botc-build-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['assets', 'worker', 'migration', 'characters']) await mkdir(join(root, dir));
  const write = (path, data) => writeFile(join(root, path), data);
  await write('assets/data.js', 'window.data = 1;');
  await write('assets/roles.json', '[]');
  await write('worker/worker.js', 'export default {};');
  await write('index.html', '<!doctype html><meta charset="UTF-8">');
  const script = fileURLToPath(new URL('../build-assets.mjs', import.meta.url));
  const build = (...args) => execFileSync(process.execPath, [script, ...args], { env: { ...process.env, BOTC_BUILD_ROOT: root }, stdio: 'pipe' });
  const id = async () => (await readFile(join(root, 'worker/asset-manifest.js'), 'utf8')).match(/BUILD_ID = "([^"]+)"/)[1];
  build(); const first = await id();
  await write('assets/roles.json', '[{"id":"imp"}]');
  assert.throws(() => build('--check'), /manifest is stale/);
  build(); assert.notEqual(await id(), first);
  await write('assets/night-order.json', '{}');
  const second = await id(); build(); assert.notEqual(await id(), second);
});
