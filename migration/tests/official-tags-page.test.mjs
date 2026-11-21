import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const post = body => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-1', 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('official tags: login, known ids and tags only, last save wins', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1 });

  assert.equal((await f.request('/api/official-tags')).status, 401);
  assert.equal((await f.request('/api/official-tags', post({ id: 'not-a-role', tags: [] }))).status, 404);

  let r = await f.request('/api/official-tags', post({ id: 'imp', tags: ['single-kill', 'Made Up', 'Death', 'death'] }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tags, 'Death, Single-Kill');
  await f.request('/api/official-tags', post({ id: 'imp', tags: ['Death'] }));

  const got = await (await f.request('/api/official-tags', { headers: { Cookie: 'botc_session=user-1' } })).json();
  assert.equal(got.tags.imp.tags, 'Death');
  assert.equal(got.tags.imp.by, 'user-1');
});
