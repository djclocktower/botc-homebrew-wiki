import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

// A jinx nobody marked good or evil follows its character: a Minion's is evil.
test('an unmarked jinx on a Minion is shown as evil; a marked one keeps its side', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1' });
  const r = await f.request('/api/character', {
    method: 'POST',
    headers: { Cookie: 'botc_session=user-1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'wall', name: 'Wall', team: 'minion', ability: 'Words.', art: 'art/wall.png',
      status: 'published', jinxes: [{ name: 'Imp', text: 'Unmarked.' }, { name: 'Spy', align: 'good', text: 'Marked.' }] })
  });
  assert.equal(r.status, 200, await r.text());
  const row = f.db.prepare("SELECT data, url_slug FROM characters WHERE slug='wall'").get();
  assert.equal(JSON.parse(row.data).jinxes[0].align, undefined);
  const html = await (await f.request('/c/' + row.url_slug)).text();
  assert.match(html, /class="jname evil"[^>]*>Imp</);
  assert.match(html, /class="jname good"[^>]*>Spy</);
});
