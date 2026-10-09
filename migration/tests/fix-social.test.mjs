import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

/* Comments, DMs, modmail, favorites: the regressions fixed together. */

const as = id => ({ headers: { Cookie: 'botc_session=user-' + id } });
const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
// Account 9 is an admin; the rest are members.
function users(f, ids = [1, 2, 9]) {
  for (const id of ids) {
    f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(?,?,'',?)").run(id, 'user-' + id, id === 9 ? 1 : 0);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id, isAdmin: id === 9 });
  }
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

test('favorites: a page that is not public answers like a missing one, and a saved one stays removable', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('characters', 'pub', { slug: 'pub', name: 'Pub', team: 'townsfolk' });
  f.insert('characters', 'secret', { slug: 'secret', name: 'Secret Name', team: 'townsfolk' }, 'draft');
  f.insert('characters', 'binned', { slug: 'binned', name: 'Binned Name', team: 'townsfolk' }, 'deleted');

  // Neither saving nor unsaving a page you never saved tells you it exists.
  for (const slug of ['secret', 'binned', 'nope']) {
    for (const on of [true, false]) {
      const r = await f.request('/api/favorite', post(1, { type: 'character', slug, on }));
      assert.equal(r.status, 404, slug + ' on=' + on);
      const body = await r.json();
      assert.equal(body.name, undefined);
      assert.equal(body.error, 'No such page');
    }
  }

  // Saved while public, then the page went to draft: still removable, no name.
  assert.equal((await f.request('/api/favorite', post(1, { type: 'character', slug: 'pub', on: true }))).status, 200);
  f.db.prepare("UPDATE characters SET status='draft' WHERE slug='pub'").run();
  let r = await f.request('/api/favorite', post(1, { type: 'character', slug: 'test-set/pub', on: false }));
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.slug, 'pub');
  assert.equal(body.on, false);
  assert.equal(body.name, undefined);
  assert.deepEqual((await (await f.request('/api/favorites', as(1))).json()).characters, []);
});

test('favorites: a deleted or vanished saved page is listed, counted and removable', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('characters', 'gone', { slug: 'gone', name: 'Gone Name', team: 'townsfolk' });
  f.insert('scripts', 'old', { slug: 'old', name: 'Old Script', characters: ['gone'] });
  for (const [type, slug] of [['character', 'gone'], ['script', 'old']]) {
    assert.equal((await f.request('/api/favorite', post(1, { type, slug, on: true }))).status, 200);
  }
  f.db.prepare("UPDATE characters SET status='deleted' WHERE slug='gone'").run();
  f.db.prepare("DELETE FROM scripts WHERE slug='old'").run();

  const exp = await (await f.request('/api/favorites?expand=1', as(1))).json();
  assert.equal(exp.total, 2);
  assert.deepEqual(exp.items.characters.map(i => [i.slug, i.status, i.name]), [['gone', 'deleted', 'gone']]);
  assert.deepEqual(exp.items.scripts.map(i => [i.slug, i.status, i.name]), [['old', 'deleted', 'old']]);
  assert.deepEqual(exp.characterSlugs, []);

  for (const [type, slug] of [['character', 'gone'], ['script', 'old']]) {
    const r = await f.request('/api/favorite', post(1, { type, slug, on: false }));
    assert.equal(r.status, 200, type);
    assert.equal((await r.json()).name, undefined);
  }
  assert.equal((await (await f.request('/api/favorites', as(1))).json()).total, 0);
});

test('modmail: a pre-thread answer survives the replies written after it', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  // Creates the tables through a real route first.
  assert.equal((await f.request('/api/contact', post(1, { category: 'bug', body: 'first message here' }))).status, 200);
  f.db.prepare(`UPDATE messages SET last_reply='The old answer', replied_at='2020-01-01 00:00:00', replied_by='user-9',
                ts='2019-12-31 00:00:00' WHERE id=1`).run();

  const thread = async () => (await (await f.request('/api/contact/thread?id=1', as(1))).json()).replies;
  // Untouched: reconstructed on read, nothing written.
  assert.deepEqual((await thread()).map(t => [t.staff, t.body]), [[true, 'The old answer']]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM modmail_replies').get().n, 0);

  // The member writes back: the old answer is kept as a turn of its own.
  assert.equal((await f.request('/api/contact/reply', post(1, { id: 1, body: 'Thanks, but…' }))).status, 200);
  assert.deepEqual((await thread()).map(t => [t.staff, t.body]), [[true, 'The old answer'], [false, 'Thanks, but…']]);
  const kept = (await thread())[0];
  assert.equal(kept.username, 'user-9');
  assert.equal(kept.ts, '2020-01-01 00:00:00');

  // A new staff reply overwrites last_reply; the old answer is not lost with it.
  assert.equal((await f.request('/api/admin/message', post(9, { id: 1, action: 'reply', body: 'New answer' }))).status, 200);
  assert.deepEqual((await thread()).map(t => t.body), ['The old answer', 'Thanks, but…', 'New answer']);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM modmail_replies WHERE is_staff=1').get().n, 2);
});

test('modmail: a thread the member answered before the fix still shows the old answer in its place', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  await f.request('/api/contact', post(1, { category: 'bug', body: 'first message here' }));
  f.db.prepare(`UPDATE messages SET last_reply='The old answer', replied_at='2020-01-01 00:00:00', replied_by='user-9' WHERE id=1`).run();
  f.db.prepare(`INSERT INTO modmail_replies(message_id, ts, user_id, is_staff, body) VALUES(1, '2020-02-01 00:00:00', 1, 0, 'later')`).run();
  const replies = (await (await f.request('/api/admin/message-thread?id=1', as(9))).json()).replies;
  assert.deepEqual(replies.map(t => t.body), ['The old answer', 'later']);
});

test('modmail: both sides share the reply ceiling, and the read keeps the newest', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  await f.request('/api/contact', post(1, { category: 'bug', body: 'first message here' }));
  const ins = f.db.prepare("INSERT INTO modmail_replies(message_id, user_id, is_staff, body) VALUES(1, 1, 0, ?)");
  for (let i = 0; i < 205; i++) ins.run('turn ' + i);
  let r = await f.request('/api/admin/message', post(9, { id: 1, action: 'reply', body: 'one more' }));
  assert.equal(r.status, 400);
  r = await f.request('/api/contact/reply', post(1, { id: 1, body: 'one more' }));
  assert.equal(r.status, 400);
  const replies = (await (await f.request('/api/contact/thread?id=1', as(1))).json()).replies;
  assert.equal(replies.length, 200);
  assert.equal(replies[0].body, 'turn 5');
  assert.equal(replies[199].body, 'turn 204');
});

test('modmail: an image on its own opens a conversation', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  const img = '/assets/attachments/202610/1-abcdef.png';
  let r = await f.request('/api/contact', post(1, { category: 'bug', body: '', images: [img] }));
  assert.equal(r.status, 200);
  r = await f.request('/api/contact', post(1, { category: 'bug', body: 'hi' }));
  assert.equal(r.status, 400);
});

test('rate limits on conversations are kept per account, not per connection', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  await f.request('/api/contact', post(1, { category: 'bug', body: 'first message here' }));
  const keys = f.db.prepare("SELECT key FROM rate_limits").all().map(r => r.key);
  assert.ok(keys.includes('rl:contact:u1'), keys.join());
});

test('comment report counts ignore reports whose comment is gone', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('characters', 'c1', { slug: 'c1', name: 'C1', team: 'townsfolk' });
  // Creates the comment tables.
  assert.equal((await f.request('/api/comments?type=character&slug=c1')).status, 200);
  f.db.prepare("INSERT INTO comments(id, entity_type, slug, user_id, body) VALUES(1,'character','c1',1,'hi')").run();
  f.db.prepare("INSERT INTO comment_reports(comment_id, reporter_id) VALUES(1, 2), (77, 2)").run();
  const counts = await (await f.request('/api/admin/queue-counts', as(9))).json();
  assert.equal(counts.reportedComments, 1);
  const queue = await (await f.request('/api/admin/comments', as(9))).json();
  assert.equal(queue.openReports, 1);
});

test('comments: a busy page returns its newest comments, with their threads and pins', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('characters', 'busy', { slug: 'busy', name: 'Busy', team: 'townsfolk' });
  await f.request('/api/comments?type=character&slug=busy');
  const ins = f.db.prepare("INSERT INTO comments(id, entity_type, slug, user_id, body, parent_id, pinned) VALUES(?,'character','busy',1,?,?,?)");
  ins.run(1, 'opening, pinned', null, 1);
  ins.run(2, 'old thread', null, 0);
  for (let i = 3; i <= 600; i++) ins.run(i, 'c' + i, null, 0);
  ins.run(601, 'late reply to an old thread', 2, 0);
  const { comments } = await (await f.request('/api/comments?type=character&slug=busy')).json();
  const ids = comments.map(c => c.id);
  assert.ok(ids.includes(601), 'newest is returned');
  assert.ok(ids.includes(600));
  assert.ok(ids.includes(2), 'the reply brings its thread opener');
  assert.equal(ids[0], 1, 'the pin is first');
  assert.ok(!ids.includes(3), 'the oldest unpinned comments are the ones trimmed');
});

test('suggestion answers respect the suggester\'s block list', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  f.insert('characters', 'pg', { slug: 'pg', name: 'Pg', team: 'townsfolk', publicEdit: 'suggest' });
  f.db.prepare("UPDATE characters SET owner_id=1 WHERE slug='pg'").run();
  // Creates the suggestions table.
  assert.equal((await f.request('/api/suggestion', post(1, { id: 999, action: 'decline' }))).status, 404);
  f.db.prepare("INSERT INTO suggestions(id, entity_type, slug, user_id, username, data) VALUES(1,'character','pg',2,'user-2','{}')").run();
  f.db.prepare("INSERT INTO suggestions(id, entity_type, slug, user_id, username, data) VALUES(2,'character','pg',2,'user-2','{}')").run();
  // Not blocked: told.
  assert.equal((await f.request('/api/suggestion', post(1, { id: 1, action: 'decline' }))).status, 200);
  await Promise.all(f.background);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dms WHERE recipient_id=2').get().n, 1);
  // Blocked: not.
  f.db.prepare('INSERT INTO dm_blocks(user_id, blocked_id) VALUES(2, 1)').run();
  assert.equal((await f.request('/api/suggestion', post(1, { id: 2, action: 'decline' }))).status, 200);
  await Promise.all(f.background);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM dms WHERE recipient_id=2').get().n, 1);
});

test('a DM report unlocks the messages up to the report, not the conversation after it', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  // Creates the DM tables.
  await f.request('/api/messages/thread?with=user-2', as(1));
  const dm = f.db.prepare('INSERT INTO dms(ts, sender_id, recipient_id, body) VALUES(?,?,?,?)');
  dm.run('2026-01-01 00:00:00', 2, 1, 'rude');
  f.db.prepare("INSERT INTO dm_reports(ts, reporter_id, reported_id) VALUES('2026-01-02 00:00:00', 1, 2)").run();
  dm.run('2026-03-01 00:00:00', 1, 2, 'made up since');
  const read = async () => (await (await f.request('/api/admin/dm-thread?a=user-1&b=user-2', as(9))).json()).messages.map(m => m.body);
  assert.deepEqual(await read(), ['rude']);
  // Reporting again brings what was said since into the report.
  assert.equal((await f.request('/api/messages/report', post(1, { with: 'user-2' }))).status, 200);
  assert.deepEqual(await read(), ['rude', 'made up since']);
});

test('an attachment has to be the image it says it is', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  users(f);
  const stored = [];
  f.env.ART = { async put(key, bytes, opts) { stored.push(key); return { etag: 'e' }; } };
  const send = (type, buf) => f.request('/api/attachment', post(1, { data: 'data:' + type + ';base64,' + buf.toString('base64') }));
  let r = await send('image/png', Buffer.from('<html><script>alert(1)</script></html>'));
  assert.equal(r.status, 400);
  r = await send('image/jpeg', PNG);
  assert.equal(r.status, 400);
  r = await send('image/png', PNG);
  assert.equal(r.status, 200);
  assert.equal(stored.length, 1);
  assert.match(stored[0], /^attachments\/\d{6}\/1-[a-z0-9]+\.png$/);
});
