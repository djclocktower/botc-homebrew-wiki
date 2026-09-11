import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';
import { homeData, featuredPick } from '../../worker/home-data.js';
import PageRender from '../../assets/render-page.js';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const member = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
function users(f) {
  for (const id of [1, 2, 3]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
}

test('homepage returns compact public summaries; full exports retain their fields', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  for (let i = 0; i < 200; i++) f.insert('characters', 'char-' + i, {
    slug: 'char-' + i, name: 'Character ' + i, creator: 'Creator ' + (i % 5),
    team: 'townsfolk', art: 'art/demo.png', ability: 'Each night, learn a player.',
    tags: 'Information', summaryBullets: ['A finished page'], howToRun: ['Wake them'], examples: ['For example'], lede: 'A long lede. '.repeat(100),
    reminders: ['Learned'], firstNightReminder: 'Wake this player',
    jinxes: [{ id: 'imp', reason: 'Keep this in exports' }]
  });
  f.insert('characters', 'secret', { name: 'UNPUBLISHED SECRET' }, 'draft');
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['char-0'],
    synopsis: 'Long prose '.repeat(500), nightOrder: { first: ['char-0'] }, editors: [{ id: 99 }] });
  f.insert('collections', 'demo', { id: 'demo', slug: 'demo', include: ['char-0', 'char-1'], displayName: 'Demo' });
  const response = await f.request('/api/home'), body = await response.text(), home = JSON.parse(body);
  assert.equal(home.stats.characters, 200);
  assert.equal(home.stats.jinxed, 200);
  assert.equal(home.collections[0].count, 2);
  assert.equal(home.scripts[0].count, 1);
  assert.equal(home.recent.length, 8);
  assert.ok(home.featured?.ability);
  assert.equal(home.scripts[0].characters, undefined);
  assert.doesNotMatch(body, /UNPUBLISHED SECRET|summaryBullets|firstNightReminder|synopsis|editors/);
  const grid = await (await f.request('/characters.json?fields=grid')).text();
  assert.doesNotMatch(grid, /lede|firstNightReminder/);
  assert.ok(body.length < grid.length / 4);
  t.diagnostic('200-character fixture: homepage ' + Buffer.byteLength(body) + ' bytes; grid ' + Buffer.byteLength(grid) + ' bytes.');
  const cards = await (await f.request('/characters.json?fields=card')).json();
  assert.deepEqual(cards[0].reminders, ['Learned']);
  assert.equal(cards[0].firstNightReminder, 'Wake this player');
  const browse = await (await f.request('/scripts.json?fields=browse')).json();
  assert.equal(browse[0].synopsis, undefined);
  assert.equal(browse[0].nightOrder, undefined);
  const full = await (await f.request('/scripts.json')).json();
  assert.equal(full[0].nightOrder.first[0], 'char-0');
  const unchanged = await f.request('/api/home', { headers: { 'If-None-Match': response.headers.get('ETag') } });
  assert.equal(unchanged.status, 304);
});

test('daily featured rotation is deterministic without repeating creators at block seams', () => {
  for (const n of [2, 3, 5, 12]) {
    const chars = Array.from({ length: n }, (_, i) => ({ slug: 'c-' + i, name: 'C' + i,
      creator: 'Creator ' + i, art: 'art/c.png', ability: 'Learn a player.', classification: 'standard' }));
    for (let day = 19000; day < 19500; day++) {
      const today = featuredPick(chars, day);
      assert.deepEqual(today, featuredPick(chars, day));
      assert.notEqual(today.creator, featuredPick(chars, day - 1).creator, 'day ' + day + ', creators ' + n);
    }
  }
  assert.equal(homeData([], [], [], 20000).featured, null);
});

test('content types invalidate their dependents while unrelated news edits retain warm feeds and pages', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('characters', 'demo', { slug: 'demo', name: 'Demo' });
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['demo'] });
  await f.hooks.bumpContentVersion(f.env); // initialize scoped counters once
  const original = await f.request('/characters.json?fields=grid');
  const etag = original.headers.get('ETag');
  await f.request('/s/demo'); await Promise.all(f.background);
  const scriptReads = () => f.calls.filter(c => c.sql.includes('FROM scripts')).length;
  const reads = scriptReads();
  await f.hooks.logActivity(f.env, null, 'update', 'news', 'story', 'Story');
  assert.equal((await f.request('/characters.json?fields=grid', { headers: { 'If-None-Match': etag } })).status, 304);
  await f.request('/s/demo');
  assert.equal(scriptReads(), reads);
  f.insert('collections', 'demo', { slug: 'demo', id: 'demo', displayName: 'A new collection', include: ['demo'] });
  await f.hooks.logActivity(f.env, null, 'update', 'collection', 'demo', 'Demo');
  const changed = await f.request('/characters.json?fields=grid', { headers: { 'If-None-Match': etag } });
  assert.equal(changed.status, 200);
  assert.match(await changed.text(), /A new collection/);
  await f.request('/s/demo'); assert.ok(scriptReads() > reads);
  const beforePage = await f.hooks.contentVersion(f.env, ['script', 'wikipage']);
  await f.hooks.logActivity(f.env, null, 'publish', 'wikipage', 'lore', 'Lore');
  assert.notEqual(await f.hooks.contentVersion(f.env, ['script', 'wikipage']), beforePage);
});

test('manual version bumps and mixed bulk writes reset all dependency keys', async t => {
  const f = await fixture(); t.after(() => f.finish());
  await f.hooks.bumpContentVersion(f.env, 'news');
  const before = await f.hooks.contentVersion(f.env, ['character']);
  f.db.prepare("UPDATE settings SET value='100' WHERE key='content_version'").run();
  await f.hooks.bumpContentVersion(f.env, 'news');
  const after = await f.hooks.contentVersion(f.env, ['character']);
  assert.notEqual(after, before);
  assert.equal(await f.hooks.contentVersion(f.env), '101');
  await Promise.all(Array.from({ length: 12 }, () => f.hooks.bumpContentVersion(f.env, 'script')));
  assert.equal(await f.hooks.contentVersion(f.env), '113');
  const packed = JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='cache_versions'").get().value);
  assert.equal(packed.global, 113); assert.equal(packed.script, 12);
  await f.hooks.logActivity(f.env, null, 'bulk-publish', 'mixed', '', 'Mixed pages');
  assert.notEqual(await f.hooks.contentVersion(f.env, ['character']), after);
});

test('transient database errors never retry a public query without visibility columns or filters', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('scripts', 'secret', { slug: 'secret', name: 'PRIVATE DATA' }, 'draft');
  f.state.intercept = ({ sql, value }) => {
    if (/SELECT .*status.*FROM scripts/.test(sql)) throw new Error('temporary read failure');
    return value;
  };
  await assert.rejects(f.request('/scripts.json'), /temporary read failure/);
  await assert.rejects(f.request('/s/secret'), /temporary read failure/);
  assert.ok(!f.calls.some(c => /SELECT data FROM scripts/.test(c.sql)));
});

test('failed version reads cannot match a previously cached version-zero feed', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.state.intercept = ({ sql, value }) => { if (sql.includes('SELECT value,')) throw new Error('temporary'); return value; };
  await assert.rejects(f.request('/characters.json?fields=grid'), /Content version unavailable/);
  f.state.intercept = null;
  assert.equal((await f.request('/characters.json?fields=grid')).status, 200);
});

test('members share public HTML; owner and approved-editor controls stay private', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f);
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: [], publicEdit: 'approved', editors: [{ id: 2, username: 'user-2' }] });
  f.db.prepare("UPDATE scripts SET owner_id=1 WHERE slug='demo'").run();
  await f.hooks.ensurePagesTable(f.env);
  f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status) VALUES('secret-lore','PRIVATE LORE','script','demo',1,'{}','draft')").run();
  const publicHtml = await (await f.request('/s/demo')).text(); await Promise.all(f.background);
  const reads = f.calls.length;
  const ownerHtml = await (await f.request('/s/demo', member(1))).text();
  assert.equal(ownerHtml, publicHtml);
  assert.doesNotMatch(ownerHtml, /PRIVATE LORE|Edit this script|Write a page/);
  assert.equal(f.calls.length, reads); // no member-specific render or query
  const owner = await f.request('/api/page-viewer?type=script&slug=demo', member(1));
  assert.equal(owner.headers.get('Cache-Control'), 'no-store');
  const controls = await owner.json();
  assert.match(controls.pages, /PRIVATE LORE/); assert.match(controls.pages, /id="sec-pages"/);
  assert.match(controls.pages, /Write a page/); assert.equal(controls.editHref, '/publish-script?s=demo');
  const editor = await (await f.request('/api/page-viewer?type=script&slug=demo', member(2))).json();
  assert.equal(editor.editHref, '/publish-script?s=demo'); assert.equal(editor.pages, null);
  const stranger = await (await f.request('/api/page-viewer?type=script&slug=demo', member(3))).json();
  assert.equal(stranger.editHref, ''); assert.equal(stranger.pages, null);
  // A demoted admin's old session must not expose another owner's draft links.
  f.state.sessions.get('sess:user-3').isAdmin = true;
  const demoted = await (await f.request('/api/page-viewer?type=script&slug=demo', member(3))).json();
  assert.equal(demoted.editHref, ''); assert.equal(demoted.pages, null);
  assert.deepEqual(await (await f.request('/api/page-viewer?type=script&slug=demo')).json(), {});
});

test('draft pages and pages under deleted parents never enter the public SSR cache', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f);
  f.insert('scripts', 'private', { slug: 'private', name: 'PRIVATE SCRIPT', characters: [] }, 'draft');
  f.db.prepare("UPDATE scripts SET owner_id=1 WHERE slug='private'").run();
  assert.equal((await f.request('/s/private')).status, 404);
  assert.match(await (await f.request('/s/private', member(1))).text(), /PRIVATE SCRIPT/);
  assert.equal((await f.request('/s/private', member(3))).status, 404);
  await f.hooks.ensurePagesTable(f.env);
  f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status) VALUES('lore','PRIVATE LORE','script','private',1,'{}','published')").run();
  f.db.prepare("UPDATE scripts SET status='deleted' WHERE slug='private'").run();
  await f.hooks.bumpContentVersion(f.env, 'script');
  assert.match(await (await f.request('/p/lore', member(1))).text(), /PRIVATE LORE/);
  assert.equal((await f.request('/p/lore')).status, 404);
  assert.equal((await f.request('/p/lore', member(3))).status, 404);
  assert.ok(![...f.cache.keys()].some(k => k.startsWith('https://ssr.internal/')));
});

function r2(f) {
  const objects = new Map(); let reads = 0;
  function object(key, body, etag, sourceETag) { objects.set(key, { body: Buffer.from(body), etag, sourceETag }); }
  f.env.ART = {
    async head(key) { reads++; const row = objects.get(key); return row ? { etag: row.etag } : null; },
    async get(key, options) {
      reads++; const row = objects.get(key); if (!row) return null;
      const metadata = { size: row.body.length, etag: row.etag, httpEtag: '"' + row.etag + '"',
        customMetadata: { sourceETag: row.sourceETag }, writeHttpMetadata(h) { h.set('Content-Type', key.endsWith('.webp') ? 'image/webp' : 'image/png'); } };
      return options?.onlyIf?.get('If-None-Match') === metadata.httpEtag ? metadata : { ...metadata, body: row.body };
    }
  };
  return { object, reads: () => reads };
}

test('responsive images reuse immutable variants and reject stale variants after original replacement', async t => {
  const f = await fixture(); t.after(() => f.finish()); const art = r2(f);
  const original = 'original'.repeat(200), variant = 'webp'.repeat(200);
  const key = 'media/320/scripts/a banner.png.webp', path = '/assets/media/320/scripts/a%20banner.png.webp?v=first';
  art.object('scripts/a banner.png', original, 'source-one');
  assert.equal(await (await f.request(path)).text(), original);
  assert.ok(!f.cache.has('https://botchomebrew.wiki' + path));
  art.object(key, variant, 'variant-one', 'source-one');
  const response = await f.request(path);
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  assert.equal(await response.text(), variant);
  await Promise.all(f.background); const reads = art.reads();
  assert.equal(await (await f.request(path)).text(), variant); assert.equal(art.reads(), reads);
  art.object('scripts/a banner.png', 'new original'.repeat(100), 'source-two');
  const freshPath = path.replace('first', 'second');
  assert.equal(await (await f.request(freshPath)).text(), 'new original'.repeat(100));
  assert.ok(!f.cache.has('https://botchomebrew.wiki' + freshPath));
  art.object(key, 'new webp'.repeat(100), 'variant-two', 'source-two');
  assert.equal(await (await f.request(freshPath)).text(), 'new webp'.repeat(100));
  assert.equal((await f.request('/assets/media/999/scripts/a.png.webp')).status, 404);
  assert.match(PageRender.responsiveAttrs('../', 'scripts/a banner.png', 'v'), /a%20banner\.png/);
  assert.equal(PageRender.responsiveAttrs('', 'https://example.com/banner.png', 'v'), '');
});

test('responsive image upload permissions are inherited from the source page', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); r2(f);
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', publicEdit: 'approved', editors: [{ id: 2 }] });
  f.db.prepare("UPDATE scripts SET owner_id=1 WHERE slug='demo'").run();
  const key = 'media/640/scripts/demo-logo.png.webp';
  assert.equal(await f.hooks.uploadSlotDenied(f.env, { userId: 1 }, key), null);
  assert.equal(await f.hooks.uploadSlotDenied(f.env, { userId: 2 }, key), null);
  assert.equal((await f.hooks.uploadSlotDenied(f.env, { userId: 3 }, key)).status, 403);
  assert.equal((await f.hooks.uploadSlotDenied(f.env, { userId: 1, isAdmin: true }, 'media/640/news/demo.png.webp')).status, 400);
});

test('uploading derivatives requires the current original ETag and replacing originals retires all sizes', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f); const art = r2(f);
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  art.object('scripts/demo.png', 'original'.repeat(200), 'current-source');
  const stored = [], removed = [];
  f.env.ART.put = async (key, bytes, options) => { stored.push({ key, options }); return { etag: 'new-source' }; };
  f.env.ART.delete = async key => removed.push(key);
  const upload = body => f.request('/api/upload', { method: 'POST',
    headers: { ...member(1).headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { key: 'media/320/scripts/demo.png.webp', data: 'data:image/webp;base64,' + Buffer.alloc(900, 1).toString('base64') };
  assert.equal((await upload({ ...body, sourceETag: 'old-source' })).status, 409);
  assert.equal(stored.length, 0);
  assert.equal((await upload({ ...body, sourceETag: '"current-source"' })).status, 200);
  assert.equal(stored[0].options.customMetadata.sourceETag, 'current-source');
  const original = await upload({ key: 'scripts/demo.png', data: 'data:image/png;base64,' + Buffer.alloc(1000, 1).toString('base64') });
  assert.equal(original.status, 200); assert.equal((await original.json()).etag, 'new-source');
  assert.deepEqual(removed, [[320, 640, 1280].map(width => 'media/' + width + '/scripts/demo.png.webp')]);
});

test('data loader shares parsed public objects, keeps private requests separate, and retries failures', async () => {
  let calls = 0, fail = false;
  const context = vm.createContext({ window: {}, URL, location: { origin: 'https://botchomebrew.wiki' },
    document: { baseURI: 'https://botchomebrew.wiki/' },
    fetch: async () => { calls++; return { ok: !fail, status: fail ? 503 : 200, json: async () => [{ name: 'Demo' }] }; } });
  vm.runInContext(await read('assets/data.js'), context);
  const json = context.window.BotcData.json;
  const [a, b] = await Promise.all([json('characters.json?fields=grid'), json('/characters.json?fields=grid')]);
  assert.equal(calls, 1); assert.equal(a, b); assert.equal(await json('/characters.json?fields=grid'), a);
  await Promise.all([json('/characters.json?drafts=1'), json('/characters.json?drafts=1')]);
  assert.equal(calls, 3);
  fail = true; await assert.rejects(json('/scripts.json?fields=browse'));
  fail = false; assert.equal((await json('/scripts.json?fields=browse'))[0].name, 'Demo');
  assert.equal(calls, 5);
});

test('card batches stop below the viewport, support section jumps, and cancel stale callbacks', async () => {
  let intersect; const observed = new Set(), frames = [];
  const grids = new Map(['first', 'second'].map(name => [name, { cards: '', insertAdjacentHTML(_, html) { this.cards += html; }, insertAdjacentElement(_, button) { this.button = button; } }]));
  const context = vm.createContext({ window: {}, requestAnimationFrame: cb => frames.push(cb),
    document: { createElement() { return { addEventListener(_, cb) { this.click = cb; } }; } },
    IntersectionObserver: class { constructor(cb) { intersect = cb; } observe(x) { observed.add(x); } unobserve(x) { observed.delete(x); } disconnect() { observed.clear(); } } });
  vm.runInContext(await read('assets/viewport.js'), context);
  const cancel = context.window.mountCardBatches({ querySelector: s => grids.get(s) },
    [...grids.keys()].map(selector => ({ selector, items: Array.from({ length: 200 }, () => 'x') })), x => x);
  assert.equal(grids.get('first').cards.length, 48); assert.equal(grids.get('second').cards.length, 0);
  while (frames.length) frames.shift()();
  assert.equal(grids.get('first').cards.length, 48); // idle does not finish the whole list
  intersect([{ target: grids.get('second').button, isIntersecting: true }]);
  assert.equal(grids.get('second').cards.length, 48);
  grids.get('first').button.click(); assert.equal(grids.get('first').cards.length, 96);
  cancel(); while (frames.length) frames.shift()();
  intersect([{ target: grids.get('second').button, isIntersecting: true }]);
  assert.equal(grids.get('second').cards.length, 48); assert.equal(observed.size, 0);
});

test('comments wait for proximity or intent; comment anchors and failed-load retries work', async () => {
  async function setup(hash, withObserver) {
    const loaded = [], handlers = {}, button = {}, root = { innerHTML: '', querySelector: () => button, addEventListener: (event, fn) => { handlers[event] = fn; } };
    let intersect, fail = false;
    const context = vm.createContext({ window: { PAGE_SLUG: 'demo', addEventListener: (event, fn) => { handlers[event] = fn; },
      BotcData: { style: path => loaded.push(path), script: async path => { loaded.push(path); if (fail) throw new Error('offline'); } } },
      document: { getElementById: () => root }, location: { hash },
      IntersectionObserver: withObserver ? class { constructor(cb) { intersect = cb; } observe() {} disconnect() {} } : undefined });
    vm.runInContext(await read('assets/reading-lazy.js'), context);
    await flush();
    return { loaded, handlers, button, approach: () => intersect([{ isIntersecting: true }]), setFail(value) { fail = value; } };
  }
  const f = await setup('', true); assert.deepEqual(f.loaded, []);
  f.approach(); await flush(); assert.deepEqual(f.loaded, ['comments.css', 'attachment-view.js', 'comments.js']);
  f.handlers.click(); await flush(); assert.equal(f.loaded.length, 3);
  const anchor = await setup('#comment-42', true); assert.ok(anchor.loaded.includes('comments.js'));
  const fallback = await setup('', false); assert.deepEqual(fallback.loaded, []);
  fallback.setFail(true); fallback.handlers.click(); await flush(); assert.match(fallback.button.textContent, /retry/);
  fallback.setFail(false); fallback.handlers.click(); await flush(); assert.ok(fallback.loaded.includes('comments.js'));
});
