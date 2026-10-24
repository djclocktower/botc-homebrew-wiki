import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

const post = (id, body) => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=user-' + id, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('a character keeps every jinx and a second almanac version; a guest cannot rewrite its ability', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  for (const id of [1, 2]) {
    f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'')").run(id, 'user-' + id);
    f.state.sessions.set('sess:user-' + id, { userId: id, username: 'user-' + id });
  }
  const jinxes = Array.from({ length: 90 }, (_, i) => ({ name: 'Other ' + i, text: 'Rule ' + i }));
  const page = {
    slug: 'ug', name: 'Ug', team: 'loric', ability: 'Big words.', art: 'art/ug.png',
    publicEdit: 'all-but-ability', status: 'published', jinxes,
    almanacAlt: { label: 'Big Word Mode', altLabel: 'Ug Mode', ability: 'Me go Ug.', summaryBullets: ['Ug.', ''], junk: 'x' }
  };
  const r = await f.request('/api/character', post(1, page));
  assert.equal(r.status, 200, await r.text());
  const stored = () => JSON.parse(f.db.prepare("SELECT data FROM characters WHERE slug='ug'").get().data);
  let d = stored();
  assert.equal(d.jinxes.length, 90);
  assert.deepEqual(d.almanacAlt, { label: 'Big Word Mode', altLabel: 'Ug Mode', ability: 'Me go Ug.', summaryBullets: ['Ug.'] });

  // An 'all-but-ability' guest keeps the second version's ability as stored.
  const g = await f.request('/api/character', post(2, { ...page, almanacAlt: { ...page.almanacAlt, ability: 'Hacked.' } }));
  assert.equal(g.status, 200, await g.text());
  assert.equal(stored().almanacAlt.ability, 'Me go Ug.');

  // The page draws the switch and both versions.
  const row = f.db.prepare("SELECT status, url_slug FROM characters WHERE slug='ug'").get();
  assert.equal(row.status, 'published');
  const page2 = await (await f.request('/c/' + row.url_slug)).text();
  assert.match(page2, /class="alm-switch"/);
  assert.match(page2, /Me go Ug\./);

  // Switching it off (null) removes it.
  await f.request('/api/character', post(1, { ...page, almanacAlt: null }));
  assert.equal(stored().almanacAlt, undefined);
});
