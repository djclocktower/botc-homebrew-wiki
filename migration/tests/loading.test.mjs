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
  // An approved editor works on the script's wiki pages too (wikiPageAccess),
  // so the drafts and the add button are theirs as well — privately, never in
  // the shared HTML above.
  const editor = await (await f.request('/api/page-viewer?type=script&slug=demo', member(2))).json();
  assert.equal(editor.editHref, '/publish-script?s=demo');
  assert.match(editor.pages, /PRIVATE LORE/); assert.match(editor.pages, /Write a page/);
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

test('approved editors of a script reach its wiki pages; publishing, deleting and other owners’ pages stay out', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f);
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: [], publicEdit: 'approved', editors: [{ id: 2, username: 'user-2' }] });
  f.db.prepare("UPDATE scripts SET owner_id=1 WHERE slug='demo'").run();
  await f.hooks.ensurePagesTable(f.env);
  f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status) VALUES('secret-lore','PRIVATE LORE','script','demo',1,'{}','draft')").run();
  // Written under the same script by somebody who is not its owner: theirs, not the share's.
  f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status) VALUES('guest-notes','GUEST NOTES','script','demo',3,'{}','published')").run();
  const post = (id, body) => f.request('/api/wiki-page', { method: 'POST',
    headers: { ...member(id).headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // The parent's listing: the editor sees drafts and may add, but is not the owner.
  const listing = await (await f.request('/api/wiki-pages?parentType=script&parentSlug=demo', member(2))).json();
  assert.equal(listing.canEdit, true); assert.equal(listing.isOwner, false);
  assert.ok(listing.pages.some(p => p.slug === 'secret-lore'));
  const strangerListing = await (await f.request('/api/wiki-pages?parentType=script&parentSlug=demo', member(3))).json();
  assert.equal(strangerListing.canEdit, false);
  assert.ok(!strangerListing.pages.some(p => p.slug === 'secret-lore'));

  // The page itself, drafts included, and where the permission came from.
  const shared = await (await f.request('/api/wiki-page?slug=secret-lore', member(2))).json();
  assert.equal(shared.access, 'approved'); assert.equal(shared.canEdit, true); assert.equal(shared.editVia.name, 'Demo');
  assert.equal((await f.request('/api/wiki-page?slug=secret-lore', member(3))).status, 404);
  const theirs = await (await f.request('/api/wiki-page?slug=guest-notes', member(2))).json();
  assert.equal(theirs.access, ''); assert.equal(theirs.canEdit, false);
  // The rendered draft too, and never through the public cache.
  assert.match(await (await f.request('/p/secret-lore', member(2))).text(), /PRIVATE LORE/);
  assert.equal((await f.request('/p/secret-lore', member(3))).status, 404);
  assert.ok(![...f.cache.keys()].some(k => k.startsWith('https://ssr.internal/')));
  // The page's image slots follow the page.
  assert.equal(await f.hooks.uploadSlotDenied(f.env, { userId: 2 }, 'pages/secret-lore-header.png'), null);
  assert.equal((await f.hooks.uploadSlotDenied(f.env, { userId: 3 }, 'pages/secret-lore-header.png')).status, 403);
  assert.equal((await f.hooks.uploadSlotDenied(f.env, { userId: 2 }, 'pages/guest-notes-header.png')).status, 403);

  // An editor's save keeps the stored status whatever it asks for, keeps the
  // owner, and tells the owner.
  const edited = await post(2, { slug: 'secret-lore', title: 'PRIVATE LORE', body: 'Rewritten by the editor', status: 'published' });
  assert.equal(edited.status, 200); assert.equal((await edited.json()).status, 'draft');
  let row = f.db.prepare("SELECT owner_id, status, data FROM pages WHERE slug='secret-lore'").get();
  assert.equal(row.owner_id, 1); assert.equal(row.status, 'draft'); assert.match(row.data, /Rewritten by the editor/);
  await Promise.all(f.background);
  const dm = f.db.prepare('SELECT sender_id, recipient_id, sender_deleted, body FROM dms').get();
  assert.equal(dm.sender_id, 2); assert.equal(dm.recipient_id, 1); assert.equal(dm.sender_deleted, 1);
  assert.match(dm.body, /PRIVATE LORE/);
  // A page the editor adds is a draft filed under the parent's owner, who
  // still publishes it — and only the owner does.
  const added = await (await post(2, { parentType: 'script', parentSlug: 'demo', title: 'Editor Notes', body: 'New', status: 'published' })).json();
  assert.equal(added.slug, 'editor-notes'); assert.equal(added.status, 'draft');
  row = f.db.prepare("SELECT owner_id, status FROM pages WHERE slug='editor-notes'").get();
  assert.equal(row.owner_id, 1); assert.equal(row.status, 'draft');
  const published = await (await post(1, { slug: 'editor-notes', title: 'Editor Notes', body: 'New', status: 'published' })).json();
  assert.equal(published.status, 'published');
  // Out of reach: another owner's page, a stranger, deleting, and a protected parent.
  assert.equal((await post(2, { slug: 'guest-notes', title: 'GUEST NOTES', body: 'Hijacked' })).status, 403);
  assert.equal((await post(3, { parentType: 'script', parentSlug: 'demo', title: 'Stranger', body: 'No' })).status, 403);
  assert.equal((await post(2, { action: 'delete', slug: 'secret-lore' })).status, 403);
  assert.ok(f.db.prepare("SELECT 1 FROM pages WHERE slug='secret-lore'").get());
  f.db.prepare("INSERT INTO settings(key,value) VALUES('protected:script:demo','1')").run();
  assert.equal((await f.request('/api/wiki-page?slug=secret-lore', member(2))).status, 404);
  assert.equal((await post(2, { slug: 'secret-lore', title: 'PRIVATE LORE', body: 'Locked' })).status, 403);
});

test("a set's sharing choice governs its owner's characters and wiki pages, and nobody else's", async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f);
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['mine', 'theirs'] });
  f.db.prepare("UPDATE scripts SET owner_id=1 WHERE slug='demo'").run();
  const setMode = (mode, editors) => {
    const d = { slug: 'demo', name: 'Demo', characters: ['mine', 'theirs'] };
    if (mode) d.publicEdit = mode;
    if (editors) d.editors = editors;
    f.db.prepare("UPDATE scripts SET data=? WHERE slug='demo'").run(JSON.stringify(d));
    return f.hooks.bumpContentVersion(f.env, 'script');
  };
  // The owner's character was opened wide by the admin sweep before it was
  // handed over; the other one on the roster belongs to somebody else.
  f.insert('characters', 'mine', { slug: 'mine', name: 'Mine', ability: 'x', publicEdit: 'all-but-ability' });
  f.insert('characters', 'theirs', { slug: 'theirs', name: 'Theirs', ability: 'y', publicEdit: 'all' });
  f.db.prepare("UPDATE characters SET owner_id=1 WHERE slug='mine'").run();
  f.db.prepare("UPDATE characters SET owner_id=3 WHERE slug='theirs'").run();
  await f.hooks.ensurePagesTable(f.env);
  f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status) VALUES('rules','RULES','script','demo',1,'{}','published')").run();
  f.db.prepare("INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status) VALUES('notes','NOTES','script','demo',1,'{}','draft')").run();
  const page = (slug, id) => f.request('/api/page?type=character&slug=' + slug, member(id)).then(r => r.json());
  const wiki = (slug, id) => f.request('/api/wiki-page?slug=' + slug, member(id)).then(r => r.json());

  // Not set: every page keeps its own setting.
  assert.equal((await page('mine', 3)).editMode, 'all-but-ability');
  assert.equal((await page('mine', 1)).governedBy, null);
  assert.equal((await wiki('rules', 3)).canEdit, false);

  // Approved editing with nobody named yet: closed to strangers, whatever the
  // character's own setting says, and the owner is told what governs it.
  await setMode('approved');
  assert.equal((await page('mine', 3)).editMode, false);
  const owner = await page('mine', 1);
  assert.equal(owner.governedBy.name, 'Demo'); assert.equal(owner.governedBy.mode, 'approved');
  // The other owner's character is not the set owner's to govern.
  assert.equal((await page('theirs', 2)).editMode, 'all');
  // Naming an editor lets them in, on the character and on the wiki pages.
  await setMode('approved', [{ id: 2, username: 'user-2' }]);
  const shared = await page('mine', 2);
  assert.equal(shared.editMode, 'approved'); assert.equal(shared.editVia.name, 'Demo');
  assert.equal((await wiki('notes', 2)).access, 'approved');
  assert.equal((await wiki('notes', 3)).error, 'Not found');

  // Open to all: anyone edits the character and the PUBLISHED wiki page; the
  // draft stays private, the status is pinned, and the owner is told.
  await setMode('all');
  assert.equal((await page('mine', 3)).editMode, 'all');
  const open = await wiki('rules', 3);
  assert.equal(open.access, 'all'); assert.equal(open.editVia.name, 'Demo');
  assert.equal((await wiki('notes', 3)).error, 'Not found');
  assert.equal((await f.request('/p/notes', member(3))).status, 404);
  const saved = await f.request('/api/wiki-page', { method: 'POST',
    headers: { ...member(3).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'rules', title: 'RULES', body: 'Edited by a guest', status: 'draft' }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).status, 'published');
  await Promise.all(f.background);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dms WHERE recipient_id=1 AND sender_id=3').get().n, 1);
  const history = await (await f.request('/api/page-history?type=character&slug=mine')).json();
  assert.equal(history.publicEdit, 'all'); assert.equal(history.publicEditVia.name, 'Demo');

  // Suggestions: the character takes them; a wiki page has no send path, so
  // it reads as closed.
  await setMode('suggest');
  assert.equal((await page('mine', 3)).editMode, 'suggest');
  assert.equal((await wiki('rules', 3)).canEdit, false);

  // Only me: closed to everyone, the tags-open default included.
  await setMode('closed');
  assert.equal((await page('mine', 3)).editMode, false);
  assert.equal((await page('mine', 2)).editMode, false);
  assert.equal((await wiki('rules', 2)).canEdit, false);
  // Back to not set: the character's own setting is in force again.
  await setMode('');
  assert.equal((await page('mine', 3)).editMode, 'all-but-ability');
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

test('the link root comes from our own stylesheet, never an extension-injected one', async () => {
  const source = await read('assets/data.js');
  const rootWith = (sheets, extra = {}) => {
    const context = vm.createContext({ window: { ...extra }, URL,
      location: { origin: 'https://botchomebrew.wiki' },
      document: { baseURI: 'https://botchomebrew.wiki/',
        querySelectorAll: () => sheets.map(href => ({ getAttribute: () => href })) } });
    vm.runInContext(source, context);
    return context.window.BotcData.root();
  };
  // The reported bug: an ad blocker injects its element-hiding stylesheet at
  // document_start, so it is the FIRST link[rel=stylesheet] in the document.
  // Taking that one made every nav link site.js builds point into the
  // extension, and "My Account" opened the blocker's own filter list.
  const blocker = 'chrome-extension://cfhdojbkjhnklbpkdaibdccddilifddb/assets/elemhide.css';
  assert.equal(rootWith([blocker, 'assets/styles.css']), '');
  assert.equal(rootWith([blocker, '/assets/immutable/styles.ef868994.css']), '/');
  assert.equal(rootWith(['moz-extension://abc/assets/hide.css', '../../assets/styles.css']), '../../');
  assert.equal(rootWith(['https://cdn.example.com/assets/x.css', '../assets/styles.css']), '../');
  // A stated root always wins, and is no longer lost when our stylesheet is
  // missing — that used to silently fall back to '' on a nested SSR page.
  assert.equal(rootWith([blocker], { LINK_ROOT: '../../' }), '../../');
  assert.equal(rootWith([], { LINK_ROOT: '../' }), '../');
  assert.equal(rootWith([]), '');
  // Whatever the document holds, a root must stay a path on this site.
  for (const sheets of [[blocker], [blocker, 'assets/styles.css'], ['blob:https://botchomebrew.wiki/assets/x'], []]) {
    const href = new URL(rootWith(sheets) + 'account', 'https://botchomebrew.wiki/c/odyssey/witcher');
    assert.equal(href.origin, 'https://botchomebrew.wiki');
  }
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
  f.approach(); await flush(); assert.deepEqual(f.loaded, ['comments.css', 'ui-icons.js', 'attachment-view.js', 'comments.js']);
  f.handlers.click(); await flush(); assert.equal(f.loaded.length, 4);
  const anchor = await setup('#comment-42', true); assert.ok(anchor.loaded.includes('comments.js'));
  const fallback = await setup('', false); assert.deepEqual(fallback.loaded, []);
  fallback.setFail(true); fallback.handlers.click(); await flush(); assert.match(fallback.button.textContent, /retry/);
  fallback.setFail(false); fallback.handlers.click(); await flush(); assert.ok(fallback.loaded.includes('comments.js'));
});

/* Assigning a collection hands over its character pages (waterfallOwner), and
   it does that in chunks because D1 caps a statement at 100 bound parameters
   and errors above it. The chunk is not the only thing bound — the new owner
   and every admin id are too — so a chunk of a full 100 slugs overran the cap,
   threw, and was swallowed by the loop's catch: a 152-character collection
   assigned the 52 in its short second chunk and reported success. */
test('assigning a collection claims every character page, within D1 bound-parameter limits', async t => {
  const f = await fixture(); t.after(() => f.finish()); users(f);
  f.db.prepare('UPDATE users SET is_admin=1 WHERE id=1').run();
  const SIZE = 152;
  for (let i = 0; i < SIZE; i++) f.insert('characters', 'spud-' + i, {
    slug: 'spud-' + i, name: 'Spud ' + i, team: 'townsfolk', appearsIn: 'The Potato Patch'
  });
  // The roster scan reads the indexed column, which the fixture's insert does
  // not fill; membership here is matched, exactly as the live collection's is.
  f.db.prepare("UPDATE characters SET appears_in='The Potato Patch'").run();
  f.insert('collections', 'the-potato-patch', {
    id: 'the-potato-patch', displayName: 'The Potato Patch', match: ['thepotatopatch']
  });
  // One page already belongs to another member: it must be left alone and
  // reported, not claimed, whichever chunk it falls in.
  f.db.prepare("UPDATE characters SET owner_id=3 WHERE slug='spud-120'").run();
  const before = f.calls.length;
  const response = await f.request('/api/admin/assign-owner', {
    method: 'POST',
    headers: { ...member(1).headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'collection', slug: 'the-potato-patch', username: 'user-2' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.characters, SIZE - 1);
  assert.equal(body.charactersHeld, 1);
  assert.equal(body.charactersFailed, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM characters WHERE owner_id=2').get().n, SIZE - 1);
  assert.equal(f.db.prepare("SELECT owner_id FROM characters WHERE slug='spud-120'").get().owner_id, 3);
  // node:sqlite allows thousands of variables, so the count is the assertion:
  // nothing this route sends may exceed what D1 would accept.
  const over = f.calls.slice(before)
    .filter(call => (call.sql.match(/\?/g) || []).length > 100);
  assert.deepEqual(over.map(call => call.sql.replace(/\s+/g, ' ').slice(0, 60)), []);
});

test('a custom page background is a root-absolute URL, whatever stylesheet consumes it', async t => {
  // Chromium resolves a relative url() inside a custom property against the
  // stylesheet where var() is used; the immutable build moved that stylesheet
  // under /assets/immutable/, which turned '../assets/x-bg.png' into
  // /assets/assets/x-bg.png. A root-absolute URL cannot be moved by anything.
  const attrs = PageRender.themeAttrs({ background: 'scripts/demo-bg.png' }, '../');
  assert.match(attrs.style, /--pg-bg:url\("\/assets\/scripts\/demo-bg\.png"\)/);
  assert.doesNotMatch(attrs.style, /\.\.\//);
  assert.match(attrs.cls, /\btheme-bg\b/);
  const f = await fixture();
  t.after(() => f.finish());
  f.insert('characters', 'char-0', { slug: 'char-0', name: 'Character 0', team: 'townsfolk', art: 'art/demo.png', ability: 'Each night, learn a player.' });
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['char-0'],
    theme: { background: 'scripts/demo-bg.png', accent: '#112233' } });
  f.insert('collections', 'demo', { id: 'demo', slug: 'demo', include: ['char-0'], displayName: 'Demo',
    theme: { background: 'collections/demo-bg.png' } });
  const script = await (await f.request('/s/demo')).text();
  assert.match(script, /<body class="[^"]*\btheme-bg\b[^"]*" style="[^"]*--pg-bg:url\(&quot;\/assets\/scripts\/demo-bg\.png&quot;\)/);
  assert.doesNotMatch(script, /--pg-bg:url\(&quot;\.\.\//);
  const collection = await (await f.request('/collection/demo')).text();
  assert.match(collection, /--pg-bg:url\(&quot;\/assets\/collections\/demo-bg\.png&quot;\)/);
});
