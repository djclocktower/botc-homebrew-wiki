import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixture } from './worker-fixture.mjs';

const require = createRequire(import.meta.url);
const CardActions = require('../../assets/card-actions.js');
const PageRender = require('../../assets/render-page.js');

test('card quick actions: a slot for every saveable character, none for drafts or official ones', () => {
  assert.equal(CardActions.slotHTML({ slug: 'abbot' }), '<span class="cq" data-cq-slug="abbot"></span>');
  assert.equal(CardActions.slotHTML({ slug: 'a"b<c' }), '<span class="cq" data-cq-slug="a&quot;b&lt;c"></span>');
  assert.equal(CardActions.slotHTML({ slug: 'drafty', status: 'draft' }), '');
  assert.equal(CardActions.slotHTML({ slug: 'off-imp' }), '');
  assert.equal(CardActions.slotHTML({ slug: 'imp', official: true }), '');
  assert.equal(CardActions.slotHTML({ name: 'No slug' }), '');
  assert.equal(CardActions.slotHTML(null), '');
  // The glyphs the info card draws with are the ones the cards draw with.
  assert.match(CardActions.glyph('script'), /class="tog-ico"[\s\S]*d="M7 3h7/);
  assert.match(CardActions.glyph('token'), /class="tog-ico"/);
});

test('card quick actions: roster cards put the slot under the icon, drafts get none', () => {
  PageRender.setCardActions(CardActions);
  try {
    const html = PageRender.renderRosterCards([
      { slug: 'pub', name: 'Pub', team: 'townsfolk', art: 'art/pub.png' },
      { slug: 'dft', name: 'Dft', team: 'minion', status: 'draft' }
    ], '');
    assert.match(html, /<span class="card-side"><img[^>]*class="char-card-thumb"[^>]*><span class="cq" data-cq-slug="pub"><\/span><\/span>/);
    assert.doesNotMatch(html, /data-cq-slug="dft"/);
  } finally {
    PageRender.setCardActions(null);
  }
});

test('card quick actions: the server-rendered pages print the slots and load card-actions.js in order', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  for (const slug of ['a', 'b', 'c']) {
    f.insert('characters', slug, { slug, name: slug.toUpperCase(), team: 'townsfolk', art: 'art/demo.png', ability: 'Does a thing.' });
  }
  f.insert('scripts', 'demo', { slug: 'demo', name: 'Demo', characters: ['b', 'off-imp'] });
  f.insert('collections', 'coll', { id: 'coll-id', slug: 'coll', include: ['c'], displayName: 'Coll' });
  const order = html => (html.match(/<script src="[^"]*"/g) || [])
    .map(tag => tag.replace(/^.*assets\/(?:immutable\/)?([a-z-]+)\..*$/, '$1'));
  const before = (list, a, b) => list.indexOf(a) !== -1 && list.indexOf(a) < list.indexOf(b);
  const get = async path => (await f.request(path, { headers: { Accept: 'text/html' } })).text();

  const charHTML = await get('/c/test-set/a');
  // charpage.js draws the info card's Add to Script / Token glyphs from it.
  assert.ok(before(order(charHTML), 'card-actions', 'charpage'), 'character page order: ' + order(charHTML));

  const scriptHTML = await get('/s/demo');
  assert.ok(before(order(scriptHTML), 'favorites', 'card-actions'), 'script page order: ' + order(scriptHTML));
  assert.match(scriptHTML, /<span class="cq" data-cq-slug="b"><\/span>/);
  assert.doesNotMatch(scriptHTML, /data-cq-slug="off-imp"/);

  const collHTML = await get('/collection/coll-id');
  assert.ok(before(order(collHTML), 'favorites', 'card-actions') && before(order(collHTML), 'card-actions', 'card-filters'),
    'collection page order: ' + order(collHTML));
  assert.match(collHTML, /<span class="cq" data-cq-slug="c"><\/span>/);
});
