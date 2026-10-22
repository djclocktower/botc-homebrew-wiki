import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixture } from './worker-fixture.mjs';

/* "Other": the wiki's own character type. Its page-only name is kept only
   for an Other character, shown on its page, and it exports as Loric. */

const require = createRequire(import.meta.url);
const Render = require('../../assets/render.js');

test('an Other character keeps its type name, shows it, and exports as Loric', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash) VALUES(1,'user-1','')").run();
  f.state.sessions.set('sess:user-1', { userId: 1, username: 'user-1' });
  const save = body => f.request('/api/character', {
    method: 'POST',
    headers: { Cookie: 'botc_session=user-1', 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ status: 'draft' }, body))
  });
  const data = slug => JSON.parse(f.db.prepare('SELECT data FROM characters WHERE slug=?').get(slug).data);

  assert.equal((await save({ slug: 'wolf', name: 'Wolf', team: 'other', typeName: '  Lycan  ' })).status, 200);
  assert.equal(data('wolf').team, 'other');
  assert.equal(data('wolf').typeName, 'Lycan');
  // Any other team drops it.
  assert.equal((await save({ slug: 'cat', name: 'Cat', team: 'minion', typeName: 'Lycan' })).status, 200);
  assert.equal(data('cat').typeName, undefined);

  const d = { name: 'Wolf', team: 'other', typeName: 'Lycan', ability: 'Howl.' };
  const html = Render.renderCharacter(d, '', '');
  assert.match(html, />Lycan</);
  assert.match(html, /type-note/);
  assert.equal(Render.buildSchema(d).team, 'loric');
  assert.equal(Render.buildSchema({ name: 'Imp', team: 'demon', ability: 'x' }).team, 'demon');
});
