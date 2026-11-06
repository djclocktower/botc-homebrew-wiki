import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

test('"Icon from" survives the save and reaches the page', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1' });
  const r = await f.request('/api/character', {
    method: 'POST',
    headers: { Cookie: 'botc_session=user-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'ug', name: 'Ug', team: 'loric', ability: 'Big words.', art: 'art/ug.png',
      status: 'published', iconBy: 'Somewhere', iconByLabel: 'from' })
  });
  assert.equal(r.status, 200, await r.text());
  const row = f.db.prepare("SELECT data, url_slug FROM characters WHERE slug='ug'").get();
  assert.equal(JSON.parse(row.data).iconByLabel, 'from');
  assert.match(await (await f.request('/c/' + row.url_slug)).text(), /Icon from:/);
});
