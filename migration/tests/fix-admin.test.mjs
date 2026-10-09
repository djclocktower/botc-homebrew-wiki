import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const as = who => ({ headers: { Cookie: 'botc_session=' + who } });
const post = (who, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=' + who, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(res.status + ' ' + text); }
}
// An admin (1), two members (2, 3).
async function seed(f) {
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(2,'member','')").run();
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(3,'other','')").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
  f.state.sessions.set('sess:member', { userId: 2, username: 'member' });
  f.state.sessions.set('sess:other', { userId: 3, username: 'other' });
  await f.hooks.ensurePagesTable(f.env);
}
const page = (f, slug, parentType, parentSlug, status, owner, author = 'Someone') =>
  f.db.prepare('INSERT INTO pages(slug,title,parent_type,parent_slug,author,owner_id,data,status) VALUES(?,?,?,?,?,?,?,?)')
    .run(slug, slug, parentType, parentSlug, author, owner, JSON.stringify({ body: 'Text of ' + slug }), status);
const count = (f, sql, ...a) => Number(f.db.prepare(sql).get(...a).n);
const complete = { team: 'townsfolk', ability: 'Does a thing.', art: 'art/x.png', tags: 'Information' };

test('admin page list: the collection filter covers the whole table, and totals are real', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  const ins = f.db.prepare(`INSERT INTO characters(slug,name,team,data,status,updated_at,url_slug)
    VALUES(?,?,'townsfolk',?,'published',?,?)`);
  f.db.exec('BEGIN');
  // Three old members of a collection, then 1,100 newer pages that are not.
  for (let i = 0; i < 3; i++) ins.run('old-' + i, 'Old ' + i, '{}', '2020-01-01 00:00:00', 'x/old-' + i);
  for (let i = 0; i < 1100; i++) ins.run('new-' + i, 'New ' + i, '{}', '2026-09-01 00:00:00', 'x/new-' + i);
  f.db.exec('COMMIT');
  f.insert('collections', 'old-set', { id: 'old-set', displayName: 'Old Set', include: ['old-0', 'old-1', 'old-2'] });

  let d = await json(await f.request('/api/admin/pages?type=character&collection=old-set&owner=none', as('admin')));
  assert.deepEqual(d.pages.map(p => p.slug).sort(), ['old-0', 'old-1', 'old-2']);
  assert.equal(d.total, 3);

  d = await json(await f.request('/api/admin/pages?type=character', as('admin')));
  assert.equal(d.pages.length, 400);
  assert.equal(d.total, 1103);

  d = await json(await f.request('/api/admin/pages?type=character&flag=no-owner', as('admin')));
  assert.equal(d.total, 1103);
});

test('creator matching is Unicode-correct: an accented credit is found in any case', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.db.prepare(`INSERT INTO characters(slug,name,team,creator,owner_id,data,status,url_slug)
    VALUES('saga','Saga','townsfolk','Ólafur, Moll',2,?, 'published','x/saga')`)
    .run(JSON.stringify({ name: 'Saga', creator: 'Ólafur, Moll', ...complete }));
  f.db.prepare(`INSERT INTO characters(slug,name,team,creator,owner_id,data,status,url_slug)
    VALUES('mollie','Mollie','townsfolk','Mollie',3,?, 'published','x/mollie')`)
    .run(JSON.stringify({ name: 'Mollie', creator: 'Mollie', ...complete }));

  for (const a of ['Ólafur', 'ólafur', 'ÓLAFUR']) {
    const d = await json(await f.request('/api/user?a=' + encodeURIComponent(a)));
    assert.equal(d.profile.claimed, true, a);
    assert.equal(d.profile.username, 'member', a);
    assert.deepEqual(d.characters.map(c => c.slug), ['saga'], a);
  }
  // Still one segment at a time: "Moll" is not "Mollie".
  const moll = await json(await f.request('/api/user?a=Moll'));
  assert.deepEqual(moll.characters.map(c => c.slug), ['saga']);

  const cc = await json(await f.request('/api/admin/collect-creator',
    post('admin', { creator: 'ólafur', collection: 'Olafs Things', dryRun: true })));
  assert.equal(cc.count, 1);

  page(f, 'olaf-guide', 'article', '', 'published', null, 'Ólafur');
  const wp = await json(await f.request('/api/wiki-pages?author=' + encodeURIComponent('ÓLAFUR')));
  assert.deepEqual(wp.pages.map(p => p.slug), ['olaf-guide']);
});

test('a set page is public only while its set exists and is published', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.db.prepare("INSERT INTO scripts(slug,name,owner_id,data,status) VALUES('hidden','Hidden',2,?,'draft')")
    .run(JSON.stringify({ slug: 'hidden', name: 'Hidden', characters: [] }));
  f.db.prepare("INSERT INTO scripts(slug,name,owner_id,data,status) VALUES('live','Live',2,?,'published')")
    .run(JSON.stringify({ slug: 'live', name: 'Live', characters: [] }));
  page(f, 'under-draft', 'script', 'hidden', 'published', 2, 'member');
  page(f, 'under-purged', 'script', 'no-such-script', 'published', 2, 'member');
  page(f, 'under-live', 'script', 'live', 'published', 2, 'member');

  for (const slug of ['under-draft', 'under-purged']) {
    assert.equal((await f.request('/p/' + slug)).status, 404, slug);
    assert.equal((await f.request('/p/' + slug, as('other'))).status, 404, slug);
    assert.equal((await f.request('/p/' + slug, as('member'))).status, 200, slug);
    assert.equal((await f.request('/p/' + slug, as('admin'))).status, 200, slug);
    assert.equal((await f.request('/api/comments?type=wikipage&slug=' + slug)).status, 404, slug);
    assert.equal((await f.request('/api/wiki-page?slug=' + slug, as('other'))).status, 404, slug);
  }
  assert.equal((await f.request('/p/under-live')).status, 200);
  assert.equal((await f.request('/api/comments?type=wikipage&slug=under-live')).status, 200);

  const prof = await json(await f.request('/api/user?u=member'));
  assert.deepEqual(prof.pages.map(p => p.slug), ['under-live']);
  const byAuthor = await json(await f.request('/api/wiki-pages?author=member'));
  assert.deepEqual(byAuthor.pages.map(p => p.slug), ['under-live']);

  for (const slug of ['under-draft', 'under-purged', 'under-live']) {
    assert.equal((await f.request('/api/admin/featured-article', post('admin', { slug, on: true }))).status, 200);
  }
  assert.deepEqual((await json(await f.request('/api/featured-articles'))).articles.map(a => a.slug), ['under-live']);
  const all = await json(await f.request('/api/featured-articles?all=1', as('admin')));
  assert.deepEqual(Object.fromEntries(all.articles.map(a => [a.slug, a.hidden])),
    { 'under-live': '', 'under-draft': 'parent-draft', 'under-purged': 'parent-deleted' });
});

test('deleting a wiki page or news, and purging a set, clear what is keyed on them', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.db.prepare("INSERT INTO scripts(slug,name,owner_id,data,status) VALUES('demo','Demo',2,?,'published')")
    .run(JSON.stringify({ slug: 'demo', name: 'Demo', characters: [] }));
  page(f, 'rules', 'script', 'demo', 'published', 2, 'member');
  page(f, 'lore', 'script', 'demo', 'published', 2, 'member');
  // Creates the comment tables.
  assert.equal((await f.request('/api/comments?type=wikipage&slug=rules')).status, 200);
  f.db.exec(`CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY, entity_type TEXT, slug TEXT, data TEXT, status TEXT);
             CREATE TABLE IF NOT EXISTS favorites (user_id INTEGER, entity_type TEXT, slug TEXT, ts TEXT)`);
  const refs = (type, slug) => {
    const c = f.db.prepare("INSERT INTO comments(entity_type,slug,user_id,body) VALUES(?,?,3,'hi')").run(type, slug);
    f.db.prepare('INSERT INTO comment_reports(comment_id,reporter_id) VALUES(?,2)').run(c.lastInsertRowid);
    f.db.prepare("INSERT INTO revisions(entity_type,slug,name,status,data) VALUES(?,?,'x','published','{}')").run(type, slug);
    f.db.prepare("INSERT INTO page_views(entity_type,slug,day,n) VALUES(?,?,'2026-01-01',3)").run(type, slug);
    f.db.prepare("INSERT INTO suggestions(entity_type,slug,data,status) VALUES(?,?,'{}','open')").run(type, slug);
    f.db.prepare("INSERT INTO settings(key,value) VALUES(?,'1')").run('protected:' + type + ':' + slug);
  };
  const left = (type, slug) =>
    count(f, 'SELECT COUNT(*) AS n FROM comments WHERE entity_type=? AND slug=?', type, slug) +
    count(f, 'SELECT COUNT(*) AS n FROM comment_reports') +
    count(f, 'SELECT COUNT(*) AS n FROM revisions WHERE entity_type=? AND slug=?', type, slug) +
    count(f, 'SELECT COUNT(*) AS n FROM page_views WHERE entity_type=? AND slug=?', type, slug) +
    count(f, 'SELECT COUNT(*) AS n FROM suggestions WHERE entity_type=? AND slug=?', type, slug) +
    count(f, "SELECT COUNT(*) AS n FROM settings WHERE key=?", 'protected:' + type + ':' + slug);

  // A protected script's page cannot be deleted by its owner; an admin can.
  f.db.prepare("INSERT INTO settings(key,value) VALUES('protected:script:demo','1')").run();
  assert.equal((await f.request('/api/wiki-page', post('member', { action: 'delete', slug: 'rules' }))).status, 423);
  f.db.prepare("DELETE FROM settings WHERE key='protected:script:demo'").run();

  refs('wikipage', 'rules');
  // (refs() protected the page itself, so this one is the admin's to delete.)
  assert.equal((await f.request('/api/wiki-page', post('member', { action: 'delete', slug: 'rules' }))).status, 423);
  let r = await f.request('/api/wiki-page', post('admin', { action: 'delete', slug: 'rules' }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(left('wikipage', 'rules'), 0);
  // A new page taking the slug starts with no history.
  page(f, 'rules', 'script', 'demo', 'published', 3, 'other');
  assert.equal((await json(await f.request('/api/page-history?type=wikipage&slug=rules'))).entries.length, 0);

  // News.
  assert.equal((await f.request('/api/news')).status, 200);
  f.db.prepare("INSERT INTO news(slug,title,data,status) VALUES('n1','N1','{}','published')").run();
  refs('news', 'n1');
  r = await f.request('/api/admin/news', post('admin', { action: 'delete', slug: 'n1' }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal(left('news', 'n1'), 0);

  // Purging a soft-deleted script takes its wiki pages, and everything on it.
  refs('script', 'demo');
  refs('wikipage', 'lore');
  f.db.prepare("UPDATE scripts SET status='deleted' WHERE slug='demo'").run();
  r = await f.request('/api/admin/purge', post('admin', { type: 'script', slug: 'demo' }));
  const d = await json(r);
  assert.equal(d.ok, true);
  assert.equal(d.pagesPurged, 2);
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM pages WHERE parent_slug='demo'"), 0);
  assert.equal(left('script', 'demo'), 0);
  assert.equal(left('wikipage', 'lore'), 0);
});

test('bulk publish skips incomplete characters; one-shot admin tools default to a dry run', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.insert('characters', 'whole', { name: 'Whole', ...complete }, 'draft');
  f.insert('characters', 'bare', { name: 'Bare', team: 'townsfolk' }, 'draft');
  f.db.prepare("UPDATE characters SET owner_id=2").run();
  const d = await json(await f.request('/api/admin/bulk',
    post('admin', { type: 'character', action: 'publish', slugs: ['whole', 'bare'] })));
  assert.equal(d.done, 1);
  assert.deepEqual(d.failed, ['bare']);
  assert.equal(d.incomplete[0].slug, 'bare');
  assert.ok(d.incomplete[0].missing.length);
  assert.equal(f.db.prepare("SELECT status FROM characters WHERE slug='bare'").get().status, 'draft');
  assert.equal(f.db.prepare("SELECT status FROM characters WHERE slug='whole'").get().status, 'published');

  // No dryRun at all: nothing is written.
  const c = await json(await f.request('/api/admin/curata-owner', post('admin', { username: 'member' })));
  assert.equal(c.dryRun, true);
  assert.doesNotMatch(f.db.prepare("SELECT data FROM characters WHERE slug='whole'").get().data, /"curata"/);
  const dm = await json(await f.request('/api/admin/demote-incomplete', post('admin', {})));
  assert.equal(dm.dryRun, true);
  assert.equal(f.db.prepare("SELECT status FROM characters WHERE slug='whole'").get().status, 'published');
  const cc = await json(await f.request('/api/admin/collect-creator', post('admin', { creator: 'x', collection: 'Y' })));
  assert.equal(cc.dryRun, true);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM collections'), 0);
});

test('non-Latin set names match themselves and nothing else', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  // A collection with no id or display name: an all-non-Latin key used to
  // normalise to '' and land on it.
  f.db.prepare("INSERT INTO collections(slug,display_name,data) VALUES('bare','bare','{}')").run();
  assert.equal((await f.request('/api/admin/pages?type=character&collection=' + encodeURIComponent('太一'), as('admin'))).status, 404);
  f.insert('collections', 'omega', { id: 'omega', displayName: 'Ωμέγα', include: ['w1'] });
  f.insert('characters', 'w1', { name: 'W1', ...complete });
  const d = await json(await f.request('/api/admin/pages?type=character&collection=' + encodeURIComponent('ΩΜΕΓΑ'), as('admin')));
  assert.deepEqual(d.pages.map(p => p.slug), ['w1']);
});

test('nest-urls files pages exactly as a save would, and counts a failed batch', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  // On a DRAFT script's roster only: a save files it under its author, not
  // the draft script, and so must the sweep.
  f.db.prepare("INSERT INTO scripts(slug,name,data,status) VALUES('drafty','Drafty',?,'draft')")
    .run(JSON.stringify({ slug: 'drafty', name: 'Drafty', characters: ['roster-char'] }));
  // Included by a collection that also excludes it.
  f.insert('collections', 'picky', { id: 'picky', displayName: 'Picky', include: ['excluded-char'], exclude: ['excluded-char'] });
  f.insert('characters', 'roster-char', { name: 'Roster Char', creator: 'Moll', ...complete });
  f.insert('characters', 'excluded-char', { name: 'Excluded Char', creator: 'Moll', ...complete });
  f.db.prepare("UPDATE characters SET creator='Moll'").run();
  let d = await json(await f.request('/api/admin/nest-urls', post('admin', { dryRun: true })));
  const to = Object.fromEntries(d.samples.map(s => [s.slug, s.to]));
  assert.equal(to['roster-char'], 'moll/roster-char');
  assert.equal(to['excluded-char'], 'moll/excluded-char');

  f.env.DB.batch = async () => { throw new Error('boom'); };
  d = await json(await f.request('/api/admin/nest-urls', post('admin', { dryRun: false })));
  assert.equal(d.changed, 0);
  assert.equal(d.failed, 2);
});

test('a rename leaves a numbered address; a legacy row is not reported as moved', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  const save = async body => json(await f.request('/api/character',
    post('member', { ...complete, appearsIn: 'Test Set', ...body })));
  assert.equal((await save({ slug: 'c2', name: 'Carpenter 2' })).page, 'c/test-set/carpenter-2');
  assert.equal((await save({ slug: 'c2', name: 'Carpenter' })).page, 'c/test-set/carpenter');
  // A real duplicate (-2 is parked by the redirect c2 left) keeps its number
  // when nothing about it changed, even once the unnumbered form is free.
  assert.equal((await save({ slug: 'c3', name: 'Carpenter' })).page, 'c/test-set/carpenter-3');
  assert.equal((await save({ slug: 'c2', name: 'Joiner' })).page, 'c/test-set/joiner');
  assert.equal((await save({ slug: 'c3', name: 'Carpenter' })).page, 'c/test-set/carpenter-3');

  f.db.prepare(`INSERT INTO characters(slug,name,team,owner_id,data,status) VALUES('legacy','Legacy','townsfolk',2,?,'published')`)
    .run(JSON.stringify({ name: 'Legacy', ...complete }));
  const d = await save({ slug: 'legacy', name: 'Legacy' });
  assert.equal(d.page, 'c/test-set/legacy');
  assert.equal(d.movedFrom, null);
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM activity_log WHERE action='rename' AND entity_slug='legacy'"), 0);
});

test('assigning a set carries its unowned and admin-owned wiki pages, never a member\'s', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  f.db.prepare("INSERT INTO collections(slug,display_name,owner_id,data) VALUES('The Set','The Set',1,?)")
    .run(JSON.stringify({ id: 'the-set', displayName: 'The Set' }));
  page(f, 'p-none', 'collection', 'The Set', 'published', null);
  page(f, 'p-admin', 'collection', 'the-set', 'published', 1);
  page(f, 'p-member', 'collection', 'The Set', 'published', 3);
  const d = await json(await f.request('/api/admin/assign-owner',
    post('admin', { type: 'collection', slug: 'the-set', username: 'member' })));
  assert.equal(d.wikiPages, 2);
  const owner = s => f.db.prepare('SELECT owner_id FROM pages WHERE slug=?').get(s).owner_id;
  assert.equal(owner('p-none'), 2);
  assert.equal(owner('p-admin'), 2);
  assert.equal(owner('p-member'), 3);
});

test('an article credited to somebody else is not listed on their creator page', async t => {
  const f = await fixture(); t.after(() => f.finish()); await seed(f);
  page(f, 'forged', 'article', '', 'published', 3, 'Moll');
  page(f, 'imported', 'article', '', 'published', null, 'Moll');
  const moll = await json(await f.request('/api/user?a=Moll'));
  assert.deepEqual(moll.pages.map(p => p.slug), ['imported']);
  assert.deepEqual((await json(await f.request('/api/wiki-pages?author=Moll'))).pages.map(p => p.slug), ['imported']);
  // Its writer's own page still lists it, by ownership.
  const other = await json(await f.request('/api/user?u=other'));
  assert.deepEqual(other.pages.map(p => p.slug), ['forged']);
});

test('a wiki page\'s history goes down with its set', async t => {
  const f = await fixture(); t.after(() => f.finish());
  await seed(f);
  f.insert('scripts', 'live-set', { slug: 'live-set', name: 'Live Set' });
  f.insert('scripts', 'draft-set', { slug: 'draft-set', name: 'Draft Set' }, 'draft');
  f.db.prepare('UPDATE scripts SET owner_id=2').run();
  page(f, 'under-live', 'script', 'live-set', 'published', 2);
  page(f, 'under-draft', 'script', 'draft-set', 'published', 2);
  const hist = (slug, who) => f.request('/api/page-history?type=wikipage&slug=' + slug, who ? as(who) : {});
  assert.equal((await hist('under-live')).status, 200);
  assert.equal((await hist('under-draft')).status, 404, 'anonymous readers cannot see it');
  assert.equal((await hist('under-draft', 'other')).status, 404, 'nor another member');
  assert.equal((await hist('under-draft', 'member')).status, 200, 'its owner still can');
  assert.equal((await hist('under-draft', 'admin')).status, 200);
});
