// Edit safety: what rollback, suggestion approval and an open page's guests
// can and cannot change, and wiki pages under a set that is not public.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixture } from './worker-fixture.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function setup() {
  const f = await fixture();
  const kv = new Map();
  f.env.SESSIONS = {
    async get(k) { return kv.has(k) ? kv.get(k) : null; },
    async put(k, v) { kv.set(k, String(v)); },
    async delete(k) { kv.delete(k); }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const u = String((input && input.url) || input);
    if (u.startsWith('https://api.pwnedpasswords.com/range/')) return new Response('0000000000000000000000000000000000A:0');
    if (u.startsWith('https://api.resend.com/')) return new Response('{}');
    if (u.includes('/assets/')) return f.env.ASSETS.fetch(new Request(u));
    throw new Error('unexpected fetch ' + u);
  };
  const post = (path, body, cookie) => f.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  const get = (path, cookie, html) => f.request(path, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(html ? { Accept: 'text/html' } : {}) }
  });
  const cookieOf = res => (res.headers.get('Set-Cookie') || '').split(';')[0];
  const user = async (name, admin) => {
    const pw = name + '-password-long-9';
    const c = cookieOf(await post('/api/signup', { username: name, email: name + '@example.com', password: pw }));
    const id = f.db.prepare('SELECT id FROM users WHERE username=?').get(name).id;
    if (!admin) return { id, cookie: c };
    f.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(id);
    return { id, cookie: cookieOf(await post('/api/login', { username: name, password: pw })) };
  };
  const data = (table, slug) => JSON.parse(f.db.prepare(`SELECT data FROM ${table} WHERE slug=?`).get(slug).data);
  const own = (table, slug, id) => f.db.prepare(`UPDATE ${table} SET owner_id=? WHERE slug=?`).run(id, slug);
  const revs = (type, slug) => f.db.prepare('SELECT id, data FROM revisions WHERE entity_type=? AND slug=? ORDER BY id').all(type, slug);
  const finish = async () => { globalThis.fetch = realFetch; await f.finish(); };
  return { f, post, get, user, data, own, revs, finish };
}

const BASE = { name: 'Gardener', team: 'townsfolk', ability: 'You grow things.', art: 'art/gardener.png', tags: 'information' };

/* ---------------- Part A: rollback and approval restore content only ---------------- */

test('a rollback restores content but keeps who may edit the page and its Curata mark', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const admin = await t.user('boss', true);
    const vandal = await t.user('vandal');
    t.f.insert('characters', 'gardener', { ...BASE, lede: 'Original.', curata: true, publicEdit: 'all' });
    t.own('characters', 'gardener', alice.id);
    let r = await t.post('/api/character', { ...BASE, slug: 'gardener', lede: 'VANDALISED' }, vandal.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const cur = t.data('characters', 'gardener');
    r = await t.post('/api/character', { ...cur, slug: 'gardener', publicEdit: 'closed' }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    r = await t.post('/api/admin/curata', { type: 'character', slug: 'gardener', curata: false }, admin.cookie);
    assert.equal(r.status, 200);

    const first = t.revs('character', 'gardener')[0];
    assert.equal(JSON.parse(first.data).curata, true);
    r = await t.post('/api/page-rollback', { type: 'character', slug: 'gardener', id: first.id }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const d = t.data('characters', 'gardener');
    assert.equal(d.lede, 'Original.');
    assert.equal(d.curata, undefined);
    assert.equal(d.publicEdit, 'closed');
    r = await t.post('/api/character', { ...BASE, slug: 'gardener', lede: 'VANDALISED AGAIN' }, vandal.cookie);
    assert.equal(r.status, 403);
  } finally { await t.finish(); }
});

test('a rollback keeps an admin’s moderation note on a drafted page', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const admin = await t.user('boss', true);
    t.f.insert('characters', 'gardener', { ...BASE, lede: 'First.' });
    t.own('characters', 'gardener', alice.id);
    let r = await t.post('/api/character', { ...BASE, slug: 'gardener', lede: 'Second.' }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    r = await t.post('/api/admin/draft-page', { type: 'character', slug: 'gardener', reason: 'The art is not yours.' }, admin.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const first = t.revs('character', 'gardener')[0];
    r = await t.post('/api/page-rollback', { type: 'character', slug: 'gardener', id: first.id }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const row = t.f.db.prepare("SELECT status, data FROM characters WHERE slug='gardener'").get();
    assert.equal(row.status, 'draft');
    const d = JSON.parse(row.data);
    assert.equal(d.lede, 'First.');
    assert.equal(d._draftNote.reason, 'The art is not yours.');
  } finally { await t.finish(); }
});

test('a version a published page could not be saved as is refused, and leaves nothing behind', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    t.f.insert('characters', 'gardener', { ...BASE, lede: 'Now.' });
    t.own('characters', 'gardener', alice.id);
    const noArt = { ...BASE, lede: 'Old.' };
    delete noArt.art;
    t.f.db.prepare("INSERT INTO revisions (entity_type, slug, data, ts) VALUES ('character','gardener',?,datetime('now'))")
      .run(JSON.stringify(noArt));
    const before = t.f.db.prepare("SELECT data, updated_at FROM characters WHERE slug='gardener'").get();
    const id = t.revs('character', 'gardener')[0].id;
    let r = await t.post('/api/page-rollback', { type: 'character', slug: 'gardener', id }, alice.cookie);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /an icon/);
    assert.deepEqual(t.f.db.prepare("SELECT data, updated_at FROM characters WHERE slug='gardener'").get(), before);
    assert.equal(t.revs('character', 'gardener').length, 1);

    // The same version is fine on a draft, which has no bar to meet.
    t.f.db.prepare("UPDATE characters SET status='draft' WHERE slug='gardener'").run();
    r = await t.post('/api/page-rollback', { type: 'character', slug: 'gardener', id }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(t.data('characters', 'gardener').lede, 'Old.');
  } finally { await t.finish(); }
});

test('an admin rollback follows the same rules', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const admin = await t.user('boss', true);
    t.f.insert('characters', 'gardener', { ...BASE, publicEdit: 'closed' });
    t.own('characters', 'gardener', alice.id);
    t.f.db.prepare("INSERT INTO revisions (entity_type, slug, data, ts) VALUES ('character','gardener',?,datetime('now'))")
      .run(JSON.stringify({ ...BASE, lede: 'Old.', publicEdit: 'all', curata: true, team: 'Townsfolk' }));
    const id = t.revs('character', 'gardener')[0].id;
    const r = await t.post('/api/admin/rollback', { type: 'character', slug: 'gardener', id }, admin.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const d = t.data('characters', 'gardener');
    assert.equal(d.lede, 'Old.');
    assert.equal(d.team, 'townsfolk');
    assert.equal(d.publicEdit, 'closed');
    assert.equal(d.curata, undefined);
  } finally { await t.finish(); }
});

test('a rollback carries the restored tags’ own provenance', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    t.f.insert('characters', 'gardener', { ...BASE, tags: 'information' });
    t.own('characters', 'gardener', alice.id);
    t.f.db.prepare("INSERT INTO revisions (entity_type, slug, data, ts) VALUES ('character','gardener',?,datetime('now'))")
      .run(JSON.stringify({ ...BASE, tags: 'misinformation', tagsBy: 'guest' }));
    const id = t.revs('character', 'gardener')[0].id;
    const r = await t.post('/api/page-rollback', { type: 'character', slug: 'gardener', id }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const d = t.data('characters', 'gardener');
    assert.equal(d.tags, 'misinformation');
    assert.equal(d.tagsBy, 'guest');
  } finally { await t.finish(); }
});

test('approving a suggestion is held to the rules a save is held to', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const sug = await t.user('sugg');
    const base = { ...BASE, publicEdit: 'suggest' };
    t.f.insert('characters', 'gardener', base);
    t.own('characters', 'gardener', alice.id);
    const before = t.f.db.prepare("SELECT data, team FROM characters WHERE slug='gardener'").get();
    const suggest = async data => {
      const r = await t.post('/api/suggest', { type: 'character', slug: 'gardener', data }, sug.cookie);
      assert.equal(r.status, 200, await r.clone().text());
      return (await r.json()).id;
    };
    const approve = id => t.post('/api/suggestion', { id, action: 'approve' }, alice.cookie);

    let r = await approve(await suggest({ ...base, team: '<img src=x onerror=alert(1)>' }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /valid team/);
    const noArt = { ...base, lede: 'No picture.' };
    delete noArt.art;
    r = await approve(await suggest(noArt));
    assert.equal(r.status, 400);
    assert.deepEqual(t.f.db.prepare("SELECT data, team FROM characters WHERE slug='gardener'").get(), before);
    assert.equal(t.revs('character', 'gardener').length, 0);

    // A valid rename the owner approves moves the address, with a 301 behind.
    r = await approve(await suggest({ ...base, name: 'Planter' }));
    assert.equal(r.status, 200, await r.clone().text());
    const row = t.f.db.prepare("SELECT name, url_slug FROM characters WHERE slug='gardener'").get();
    assert.equal(row.name, 'Planter');
    assert.match(row.url_slug, /\/planter$/);
    const redirect = t.f.db.prepare("SELECT to_slug FROM redirects WHERE entity_type='character' AND from_slug='test-set/gardener'").get();
    assert.equal(redirect && redirect.to_slug, 'gardener');
  } finally { await t.finish(); }
});

test('approving a suggestion that turns a page into an official character is refused', async () => {
  const t = await setup();
  try {
    const roles = JSON.parse(await readFile(root + 'assets/roles.json', 'utf8'));
    const imp = roles.find(x => x.id === 'imp');
    assert.ok(imp && imp.ability);
    const alice = await t.user('alice');
    const sug = await t.user('sugg');
    const base = { ...BASE, publicEdit: 'suggest' };
    t.f.insert('characters', 'gardener', base);
    t.own('characters', 'gardener', alice.id);
    let r = await t.post('/api/suggest', {
      type: 'character', slug: 'gardener', data: { ...base, name: imp.name, team: 'demon', ability: imp.ability }
    }, sug.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    r = await t.post('/api/suggestion', { id: (await r.json()).id, action: 'approve' }, alice.cookie);
    assert.equal(r.status, 400);
    assert.equal(t.f.db.prepare("SELECT name FROM characters WHERE slug='gardener'").get().name, 'Gardener');
  } finally { await t.finish(); }
});

/* ---------------- Part C: a set's wiki pages go down with the set ---------------- */

async function rulesPage(t, ownerId, scriptData = {}) {
  t.f.insert('scripts', 'secret-script', { name: 'Secret Unreleased Script', characters: [], ...scriptData });
  t.own('scripts', 'secret-script', ownerId);
  await t.f.hooks.ensurePagesTable(t.f.env);
  t.f.db.prepare(`INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status,created_at,updated_at)
    VALUES('rules','Rules','script','secret-script',?,?,'published',datetime('now'),datetime('now'))`)
    .run(ownerId, JSON.stringify({ title: 'Rules', body: 'Hello there.' }));
}

test('a wiki page under a draft script is hidden from strangers and shown to its owner', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const admin = await t.user('boss', true);
    const bob = await t.user('bob');
    await rulesPage(t, alice.id);
    t.f.db.prepare("INSERT INTO settings(key,value) VALUES('featured_articles',?)")
      .run(JSON.stringify([{ slug: 'rules', at: 1 }]));

    // Public while the script is: this read also warms the shared page cache.
    let r = await t.get('/p/rules', null, true);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Secret Unreleased Script/);

    r = await t.post('/api/publish', { type: 'script', slug: 'secret-script', status: 'draft' }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());

    r = await t.get('/p/rules', null, true);
    assert.equal(r.status, 404);
    assert.doesNotMatch(await r.text(), /Secret Unreleased Script/);
    assert.equal((await t.get('/p/rules', bob.cookie, true)).status, 404);
    assert.equal((await t.get('/api/wiki-page?slug=rules')).status, 404);
    assert.equal((await t.get('/api/comments?type=wikipage&slug=rules')).status, 404);
    r = await t.post('/api/comments', { type: 'wikipage', slug: 'rules', body: 'Hi!', agree: true }, bob.cookie);
    assert.equal(r.status, 404);
    assert.deepEqual((await (await t.get('/api/featured-articles')).json()).articles, []);
    const all = await (await t.get('/api/featured-articles?all=1', admin.cookie)).json();
    assert.equal(all.articles[0].hidden, 'parent-draft');

    r = await t.get('/p/rules', alice.cookie, true);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /NOT PUBLIC/);
    assert.equal((await t.get('/api/wiki-page?slug=rules', alice.cookie)).status, 200);

    r = await t.post('/api/publish', { type: 'script', slug: 'secret-script', status: 'published' }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    r = await t.get('/p/rules', null, true);
    assert.equal(r.status, 200);
    assert.doesNotMatch(await r.text(), /NOT PUBLIC/);
    assert.equal((await t.get('/api/wiki-page?slug=rules')).status, 200);
  } finally { await t.finish(); }
});

test('a drafted set open to everyone does not open its hidden pages; its approved editors still see them', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const bob = await t.user('bob');
    const carol = await t.user('carol');
    await rulesPage(t, alice.id, { publicEdit: 'all' });
    t.f.db.prepare("UPDATE scripts SET status='draft' WHERE slug='secret-script'").run();
    assert.equal((await t.get('/p/rules', bob.cookie, true)).status, 404);
    assert.equal((await t.get('/api/wiki-page?slug=rules', bob.cookie)).status, 404);

    t.f.db.prepare("UPDATE scripts SET data=? WHERE slug='secret-script'").run(JSON.stringify({
      name: 'Secret Unreleased Script', characters: [], publicEdit: 'approved',
      editors: [{ id: carol.id, username: 'carol' }]
    }));
    assert.equal((await t.get('/p/rules', bob.cookie, true)).status, 404);
    assert.equal((await t.get('/p/rules', carol.cookie, true)).status, 200);
    const r = await t.get('/api/wiki-page?slug=rules', carol.cookie);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).access, 'approved');
  } finally { await t.finish(); }
});

test('an article stays public, and a page under a deleted set is its owner’s alone', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    await t.f.hooks.ensurePagesTable(t.f.env);
    t.f.db.prepare(`INSERT INTO pages(slug,title,parent_type,parent_slug,owner_id,data,status,created_at,updated_at)
      VALUES('guide','Guide','article','',?,?,'published',datetime('now'),datetime('now'))`)
      .run(alice.id, JSON.stringify({ title: 'Guide', body: 'Read me.' }));
    assert.equal((await t.get('/p/guide', null, true)).status, 200);
    assert.equal((await t.get('/api/comments?type=wikipage&slug=guide')).status, 200);

    await rulesPage(t, alice.id);
    t.f.db.prepare("UPDATE scripts SET status='deleted' WHERE slug='secret-script'").run();
    assert.equal((await t.get('/p/rules', null, true)).status, 404);
    assert.equal((await t.get('/p/rules', alice.cookie, true)).status, 200);
  } finally { await t.finish(); }
});

test('a page owner can still remove a comment after the page went to drafts', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const bob = await t.user('bob');
    t.f.insert('characters', 'gardener', BASE);
    t.own('characters', 'gardener', alice.id);
    let r = await t.post('/api/comments', { type: 'character', slug: 'gardener', body: 'Rude words.', agree: true }, bob.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const id = (await r.json()).comment?.id ?? t.f.db.prepare('SELECT id FROM comments').get().id;
    r = await t.post('/api/publish', { type: 'character', slug: 'gardener', status: 'draft' }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    r = await t.post('/api/comments/delete', { id }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(t.f.db.prepare('SELECT status FROM comments WHERE id=?').get(id).status, 'removed');
  } finally { await t.finish(); }
});

/* ---------------- Part B: an open page's guest cannot move it or re-credit it ---------------- */

test('a guest on an open character cannot move its address or change its credit', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const guest = await t.user('guest');
    const base = { ...BASE, creator: 'Moll', publicEdit: 'all-but-ability' };
    t.f.insert('characters', 'gardener', base);
    t.own('characters', 'gardener', alice.id);
    t.f.db.prepare("UPDATE characters SET url_slug='moll/gardener' WHERE slug='gardener'").run();
    let r = await t.post('/api/character', { ...base, slug: 'gardener', appearsIn: 'Other Set' }, guest.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    r = await t.post('/api/character', { ...base, slug: 'gardener', appearsIn: 'Other Set', creator: 'guest' }, guest.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const row = t.f.db.prepare("SELECT url_slug, creator, appears_in, data FROM characters WHERE slug='gardener'").get();
    assert.equal(row.url_slug, 'moll/gardener');
    assert.equal(row.creator, 'Moll');
    assert.equal(JSON.parse(row.data).creator, 'Moll');
    assert.equal(row.appears_in, 'Other Set');
    // No address was parked: the lazily-made redirects table is empty or absent.
    let parked = 0;
    try { parked = t.f.db.prepare('SELECT COUNT(*) AS n FROM redirects').get().n; } catch { parked = 0; }
    assert.equal(parked, 0);

    // The owner's next save files it under the set "Appears in" now names.
    r = await t.post('/api/character', { ...t.data('characters', 'gardener'), slug: 'gardener' }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(t.f.db.prepare("SELECT url_slug FROM characters WHERE slug='gardener'").get().url_slug, 'other-set/gardener');
  } finally { await t.finish(); }
});

test('an approved editor still moves the address, as the creator would', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const carol = await t.user('carol');
    const base = { ...BASE, creator: 'Moll', publicEdit: 'approved', editors: [{ id: carol.id, username: 'carol' }] };
    t.f.insert('characters', 'gardener', base);
    t.own('characters', 'gardener', alice.id);
    t.f.db.prepare("UPDATE characters SET url_slug='moll/gardener' WHERE slug='gardener'").run();
    const r = await t.post('/api/character', { ...base, slug: 'gardener', appearsIn: 'Other Set' }, carol.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(t.f.db.prepare("SELECT url_slug FROM characters WHERE slug='gardener'").get().url_slug, 'other-set/gardener');
  } finally { await t.finish(); }
});

test('a collection keeps its id on every save, and an open set keeps its author', async () => {
  const t = await setup();
  try {
    const alice = await t.user('alice');
    const guest = await t.user('guest');
    t.f.insert('collections', 'odyssey', { id: 'odyssey', displayName: 'Odyssey', author: 'Alice', publicEdit: 'all', include: [] });
    t.own('collections', 'odyssey', alice.id);
    let r = await t.post('/api/collection', { slug: 'odyssey', id: 'gotcha', displayName: 'Odyssey Fixed', author: 'x' }, guest.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const d = t.data('collections', 'odyssey');
    assert.equal(d.id, 'odyssey');
    assert.equal(d.author, 'Alice');
    assert.equal(d.displayName, 'Odyssey Fixed');
    r = await t.post('/api/collection', { ...d, id: 'other' }, alice.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(t.data('collections', 'odyssey').id, 'odyssey');

    t.f.insert('scripts', 'tale', { name: 'Tale', author: 'Alice', characters: [], publicEdit: 'all' });
    t.own('scripts', 'tale', alice.id);
    r = await t.post('/api/script', { slug: 'tale', name: 'Tale, fixed', author: 'x', characters: [] }, guest.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    const s = t.f.db.prepare("SELECT name, author, data FROM scripts WHERE slug='tale'").get();
    assert.equal(s.name, 'Tale, fixed');
    assert.equal(s.author, 'Alice');
    assert.equal(JSON.parse(s.data).author, 'Alice');
  } finally { await t.finish(); }
});
