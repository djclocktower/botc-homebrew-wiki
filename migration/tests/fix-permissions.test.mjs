import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* Content write paths and edit permissions: who may change a set's roster,
   what a rollback or an approved suggestion may bring back, what a save reads
   before it writes, and what the read routes tell somebody who cannot see a
   page. Accounts 1 (the owner) and 2 (somebody else) exist in every test. */

const as = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
const post = (f, id, path, body) => f.request(path, {
  method: 'POST',
  headers: { ...(id ? { Cookie: 'botc_session=user-' + id } : {}), 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
async function setup(t) {
  const f = await fixture();
  t.after(() => f.finish());
  for (const id of [1, 2, 3]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
  return f;
}
const own = (f, table, slug, id) => f.db.prepare(`UPDATE ${table} SET owner_id=? WHERE slug=?`).run(id, slug);
const dataOf = (f, table, slug) => JSON.parse(f.db.prepare(`SELECT data FROM ${table} WHERE slug=?`).get(slug).data);
const char = (slug, extra = {}) => ({ slug, name: slug.replace(/-/g, ' '), team: 'townsfolk', ability: 'Does a thing.', art: 'art/' + slug + '.png', ...extra });

test('a guest on a set cannot add or remove the set owner\'s own characters', async t => {
  const f = await setup(t);
  f.insert('characters', 'mine-open', char('mine-open'));
  f.insert('characters', 'mine-closed', char('mine-closed', { publicEdit: 'closed' }));
  f.insert('characters', 'mine-draft', char('mine-draft'), 'draft');
  f.insert('characters', 'theirs', char('theirs'));
  for (const s of ['mine-open', 'mine-closed', 'mine-draft']) own(f, 'characters', s, 1);
  own(f, 'characters', 'theirs', 2);

  // A script opened to everyone. The guest adds the owner's closed page and
  // their own, and takes the owner's open one off.
  f.insert('scripts', 'open-set', { slug: 'open-set', name: 'Open Set', author: 'x', publicEdit: 'all', characters: ['mine-open', 'off-imp'] });
  own(f, 'scripts', 'open-set', 1);
  let r = await post(f, 2, '/api/script', { slug: 'open-set', name: 'Open Set', author: 'x', characters: ['off-imp', 'mine-closed', 'theirs'] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).editors, undefined, 'a guest is not sent the editor list');
  assert.deepEqual(dataOf(f, 'scripts', 'open-set').characters, ['mine-open', 'off-imp', 'theirs']);
  // So the closed page is still closed to them.
  r = await post(f, 2, '/api/character', char('mine-closed', { ability: 'Rewritten.' }));
  assert.equal(r.status, 403);

  // A collection with an approved editor: include/exclude of the owner's
  // characters are pinned, match[] is the owner's outright.
  f.insert('collections', 'shared-coll', { id: 'shared-coll', displayName: 'Shared', publicEdit: 'approved',
    editors: [{ id: 2, username: 'user-2' }], match: ['shared'], include: ['mine-open'] });
  own(f, 'collections', 'shared-coll', 1);
  r = await post(f, 2, '/api/collection', { slug: 'shared-coll', id: 'somewhere-else', displayName: 'Shared',
    match: ['everything'], include: ['mine-draft', 'theirs'], exclude: ['mine-open'] });
  assert.equal(r.status, 200);
  const coll = dataOf(f, 'collections', 'shared-coll');
  assert.deepEqual(coll.match, ['shared']);
  assert.deepEqual(coll.include, ['mine-open', 'theirs']);
  assert.deepEqual(coll.exclude, []);
  assert.equal(coll.id, 'shared-coll', 'the URL does not move');
  // The approved editor still cannot reach the owner's draft.
  assert.equal((await f.request('/api/page?type=character&slug=mine-draft', as(2))).status, 404);

  // The owner moves their own roster freely, but not the collection's URL.
  r = await post(f, 1, '/api/collection', { slug: 'shared-coll', id: 'renamed', displayName: 'Shared',
    match: ['other'], include: ['mine-draft'] });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray((await r.json()).editors), 'the owner gets the editor list back');
  assert.deepEqual(dataOf(f, 'collections', 'shared-coll').include, ['mine-draft']);
  assert.equal(dataOf(f, 'collections', 'shared-coll').id, 'shared-coll');
});

test('a rollback brings content back and nothing the page\'s administration decides', async t => {
  const f = await setup(t);
  f.insert('characters', 'roll', char('roll', { name: 'New Name', publicEdit: 'closed' }));
  own(f, 'characters', 'roll', 1);
  f.db.prepare("UPDATE characters SET url_slug='user-1/new-name' WHERE slug='roll'").run();
  const old = char('roll', { name: 'Old Name', team: 'Traveler', curata: true, publicEdit: 'all',
    editors: [{ id: 3, username: 'user-3' }], tagsBy: 'guest', _draftNote: { reason: 'old' }, creditUnlinked: true });
  f.db.prepare("CREATE TABLE IF NOT EXISTS revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, slug TEXT, name TEXT, status TEXT, data TEXT, edited_by TEXT, ts TEXT DEFAULT (datetime('now')))").run();
  const id = f.db.prepare("INSERT INTO revisions(entity_type,slug,name,status,data) VALUES('character','roll','Old Name','published',?)")
    .run(JSON.stringify(old)).lastInsertRowid;
  const r = await post(f, 1, '/api/page-rollback', { type: 'character', slug: 'roll', id: Number(id) });
  assert.equal(r.status, 200);
  const d = dataOf(f, 'characters', 'roll');
  assert.equal(d.name, 'Old Name');
  assert.equal(d.team, 'traveller', 'the team is normalised as a save does');
  for (const k of ['curata', 'editors', 'tagsBy', '_draftNote', 'creditUnlinked']) assert.equal(d[k], undefined, k);
  assert.equal(d.publicEdit, 'closed');
  const row = f.db.prepare("SELECT name, url_slug FROM characters WHERE slug='roll'").get();
  assert.equal(row.name, 'Old Name');
  assert.match(row.url_slug, /\/old-name$/, 'the address follows the name');
  assert.equal(f.db.prepare("SELECT to_slug FROM redirects WHERE from_slug='user-1/new-name'").get().to_slug, 'roll');
});

test('approving a suggestion goes through what a save checks', async t => {
  const f = await setup(t);
  f.insert('characters', 'sug', char('sug', { name: 'Sug', publicEdit: 'suggest' }));
  own(f, 'characters', 'sug', 1);
  const send = async data => {
    const r = await post(f, 2, '/api/suggest', { type: 'character', slug: 'sug', data: { ...char('sug', { name: 'Sug' }), ...data } });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    return (await r.json()).id;
  };
  const approve = id => post(f, 1, '/api/suggestion', { id, action: 'approve' });

  // A suggestion's diff, read by the suggester, never carries the owner's
  // private fields.
  f.db.prepare("UPDATE characters SET data=? WHERE slug='sug'")
    .run(JSON.stringify(char('sug', { name: 'Sug', publicEdit: 'suggest', _draftNote: { reason: 'private' } })));
  let id = await send({ team: 'Nonsense', flavor: 'x' });
  f.db.prepare("UPDATE suggestions SET data=? WHERE id=?").run(JSON.stringify(char('sug', { name: 'Sug', team: 'nonsense', _draftNote: null })), id);
  const list = await (await f.request('/api/suggestions?type=character&slug=sug', as(2))).json();
  assert.ok(list.suggestions.length);
  for (const s of list.suggestions) assert.ok(!s.changes.some(c => c.field === '_draftNote' || c.field === 'editors'));
  assert.equal((await approve(id)).status, 400, 'an invalid team is refused');

  // An exact copy of an official character is refused.
  id = await send({ name: 'Washerwoman', ability: 'You start knowing that 1 of 2 players is a particular Townsfolk.' });
  assert.equal((await approve(id)).status, 400);
  // A live page cannot lose its ability through an approval.
  id = await send({ ability: '' , flavor: 'y' });
  f.db.prepare("UPDATE suggestions SET data=? WHERE id=?").run(JSON.stringify({ ...char('sug', { name: 'Sug' }), ability: '' }), id);
  assert.equal((await approve(id)).status, 400);
  // A rename moves the address, and the conflict stamp is never stored.
  id = await send({ name: 'Sug Renamed', baseUpdatedAt: 'x' });
  const r = await approve(id);
  assert.equal(r.status, 200);
  const d = dataOf(f, 'characters', 'sug');
  assert.equal(d.baseUpdatedAt, undefined);
  assert.equal(d.publicEdit, 'suggest');
  assert.match(f.db.prepare("SELECT url_slug FROM characters WHERE slug='sug'").get().url_slug, /\/sug-renamed$/);
});

test('suggestions on a page the reader cannot see are Not Found', async t => {
  const f = await setup(t);
  f.insert('characters', 'hidden', char('hidden', { name: 'Secret Name', publicEdit: 'suggest' }));
  own(f, 'characters', 'hidden', 1);
  const r0 = await post(f, 2, '/api/suggest', { type: 'character', slug: 'hidden', data: char('hidden', { name: 'Secret Name', flavor: 'z' }) });
  assert.equal(r0.status, 200);
  f.db.prepare("UPDATE characters SET status='draft' WHERE slug='hidden'").run();
  for (const id of [2, 3]) {
    const r = await f.request('/api/suggestions?type=character&slug=hidden', as(id));
    assert.equal(r.status, 404);
    assert.ok(!/Secret Name/.test(await r.text()));
  }
  assert.equal((await f.request('/api/suggestions?type=character&slug=hidden', as(1))).status, 200);
  f.db.prepare("UPDATE characters SET status='deleted' WHERE slug='hidden'").run();
  assert.equal((await f.request('/api/suggestions?type=character&slug=hidden', as(3))).status, 404);
});

test('a draft set is not named to people who cannot see it', async t => {
  const f = await setup(t);
  f.insert('characters', 'gov', char('gov'));
  own(f, 'characters', 'gov', 1);
  f.insert('scripts', 'draft-set', { slug: 'draft-set', name: 'Unannounced Set', publicEdit: 'all', characters: ['gov'] }, 'draft');
  own(f, 'scripts', 'draft-set', 1);
  for (const opts of [undefined, as(2)]) {
    const page = await (await f.request('/api/page?type=character&slug=gov', opts)).json();
    assert.equal(page.governedBy, null);
    const hist = await (await f.request('/api/page-history?type=character&slug=gov', opts)).json();
    assert.equal(hist.publicEditVia, null);
    assert.equal(hist.publicEdit, 'all', 'the mode in force is still reported');
  }
  const mine = await (await f.request('/api/page?type=character&slug=gov', as(1))).json();
  assert.equal(mine.governedBy.key, 'draft-set');
  f.db.prepare("UPDATE scripts SET status='published' WHERE slug='draft-set'").run();
  await f.hooks.bumpContentVersion(f.env, 'script');
  const pub = await (await f.request('/api/page?type=character&slug=gov')).json();
  assert.equal(pub.governedBy.key, 'draft-set');
});

test('a save whose read failed writes nothing; a create never overwrites a row it did not load', async t => {
  const f = await setup(t);
  f.insert('characters', 'victim', char('victim', { ability: 'Original.' }));
  own(f, 'characters', 'victim', 1);
  f.insert('scripts', 'victim-s', { slug: 'victim-s', name: 'V', characters: [] });
  own(f, 'scripts', 'victim-s', 1);
  const isRead = (sql, table) => sql.startsWith('SELECT slug, ') && sql.includes(`FROM ${table} WHERE slug=?`);
  f.state.intercept = ({ sql, value }) => {
    if (isRead(sql, 'characters') || isRead(sql, 'scripts')) throw new Error('D1 hiccup');
    return value;
  };
  let r = await post(f, 2, '/api/character', char('victim', { ability: 'Hijacked.' }));
  assert.equal(r.status, 503);
  r = await post(f, 2, '/api/script', { slug: 'victim-s', name: 'Hijacked', characters: [] });
  assert.equal(r.status, 503);
  // The read "succeeds" but misses the row (a race): the create is refused.
  f.state.intercept = ({ sql, kind, value }) => (isRead(sql, 'characters') || isRead(sql, 'scripts')) && kind === 'first' ? null : value;
  r = await post(f, 2, '/api/character', char('victim', { ability: 'Hijacked.' }));
  assert.equal(r.status, 409);
  r = await post(f, 2, '/api/script', { slug: 'victim-s', name: 'Hijacked', characters: [] });
  assert.equal(r.status, 409);
  f.state.intercept = null;
  assert.equal(dataOf(f, 'characters', 'victim').ability, 'Original.');
  assert.equal(dataOf(f, 'scripts', 'victim-s').name, 'V');
  assert.equal(f.db.prepare("SELECT owner_id FROM characters WHERE slug='victim'").get().owner_id, 1);
});

test('unticking "this credit isn\'t mine" takes the uploader off and drops an empty approved mode', async t => {
  const f = await setup(t);
  f.insert('characters', 'credit', char('credit', { creditUnlinked: true, publicEdit: 'approved', editors: [{ id: 1, username: 'user-1' }] }));
  own(f, 'characters', 'credit', 1);
  const r = await post(f, 1, '/api/character', char('credit', { publicEdit: 'approved', editors: [{ id: 1, username: 'user-1' }] }));
  assert.equal(r.status, 200);
  const d = dataOf(f, 'characters', 'credit');
  assert.equal(d.creditUnlinked, undefined);
  assert.equal(d.editors, undefined);
  assert.equal(d.publicEdit, undefined);
  // An owner who picked approved editing with nobody named, and never ticked
  // the box, keeps the choice.
  f.insert('characters', 'chosen', char('chosen', { publicEdit: 'approved' }));
  own(f, 'characters', 'chosen', 1);
  await post(f, 1, '/api/character', char('chosen', { publicEdit: 'approved' }));
  assert.equal(dataOf(f, 'characters', 'chosen').publicEdit, 'approved');
});

test('a script roster is refused past the cap, never cut', async t => {
  const f = await setup(t);
  const roster = n => Array.from({ length: n }, (_, i) => 'c-' + i);
  let r = await post(f, 1, '/api/script', { slug: 'big', name: 'Big', characters: roster(150) });
  assert.equal(r.status, 200);
  assert.equal(dataOf(f, 'scripts', 'big').characters.length, 150);
  r = await post(f, 1, '/api/script', { slug: 'big', name: 'Big', characters: roster(201) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /at most 200/);
  assert.equal(dataOf(f, 'scripts', 'big').characters.length, 150);
});

test('a new identity is never off- and never one a live page still answers on', async t => {
  const f = await setup(t);
  let r = await post(f, 1, '/api/character', char('off-kilter', { name: 'Off-Kilter' }));
  assert.equal(r.status, 400);
  let j = await (await f.request('/api/slug-check?type=character&name=Off-Kilter', as(1))).json();
  assert.equal(j.taken, true);
  assert.equal(j.suggestion, 'offkilter');
  assert.equal((await post(f, 1, '/api/character', char('offkilter', { name: 'Off-Kilter' }))).status, 200);

  // A flat identity parked by a redirect to a live page.
  f.insert('characters', 'moved', char('moved'));
  f.db.prepare("CREATE TABLE IF NOT EXISTS redirects (entity_type TEXT NOT NULL, from_slug TEXT NOT NULL, to_slug TEXT NOT NULL, created_at TEXT, PRIMARY KEY (entity_type, from_slug))").run();
  f.db.prepare("INSERT INTO redirects(entity_type,from_slug,to_slug) VALUES('character','old-flat','moved')").run();
  j = await (await f.request('/api/slug-check?type=character&name=old flat', as(1))).json();
  assert.equal(j.taken, true);
  assert.notEqual(j.suggestion, 'old-flat');
  r = await post(f, 1, '/api/character', char('old-flat'));
  assert.equal(r.status, 409);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM characters WHERE slug='old-flat'").get().n, 0);
  // Once the page it pointed at is gone it parks nothing.
  f.db.prepare("UPDATE characters SET status='deleted' WHERE slug='moved'").run();
  j = await (await f.request('/api/slug-check?type=character&name=old flat', as(1))).json();
  assert.equal(j.taken, false);
  assert.equal((await post(f, 1, '/api/character', char('old-flat'))).status, 200);
});

test('the wiki lock covers rollbacks and suggestions; protection fails closed', async t => {
  const f = await setup(t);
  f.insert('characters', 'locked', char('locked'));
  own(f, 'characters', 'locked', 1);
  f.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('wiki_locked','1')").run();
  for (const p of ['/api/page-rollback', '/api/suggest', '/api/suggestion']) {
    assert.equal((await post(f, 1, p, { type: 'character', slug: 'locked', id: 1 })).status, 423, p);
  }
  f.db.prepare("DELETE FROM settings WHERE key='wiki_locked'").run();

  // A protection read that fails refuses the owner's save rather than
  // waving it through.
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  f.env.DB.prepare = sql => {
    const st = prepare(sql);
    const bind = st.bind.bind(st);
    st.bind = (...v) => {
      if (String(v[0]).startsWith('protected:')) st.first = async () => { throw new Error('D1 hiccup'); };
      return bind(...v);
    };
    return st;
  };
  const r = await post(f, 1, '/api/character', char('locked', { ability: 'Changed.' }));
  assert.equal(r.status, 423);
  assert.equal(dataOf(f, 'characters', 'locked').ability, 'Does a thing.');
});
