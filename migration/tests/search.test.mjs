import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';
import { contentDocument, completeIndex } from '../../worker/search-index.js';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../../assets/search-engine.js', import.meta.url), 'utf8'), context);
const { Index, normalize } = context.BotcSearchEngine;
const char = (title, fields = {}) => ({ type: 'character', title, url: '/c/' + title, ...fields });

test('accents, non-decomposing letters, punctuation and non-Latin text are searchable', () => {
  assert.equal(normalize('Öōø Łódź Straße Æther Œuvre'), 'ooo lodz strasse aether oeuvre');
  const index = new Index([char('Örāclø'), char('太一'), char('The Clock-maker')]);
  assert.equal(index.search({ q: 'oraclo' }).results[0].title, 'Örāclø');
  assert.equal(index.search({ q: '太一' }).total, 1);
  assert.equal(index.search({ q: 'clock maker' }).total, 1);
});

test('typos, transpositions and multiword queries rank names above body matches', () => {
  const index = new Index([char('First', { summary: 'Oracle' }), char('Oracle'), char('Abcd'),
    char('Fortune Teller', { creator: 'Jeff', tags: ['Info'] })]);
  assert.equal(index.search({ q: 'Oracle' }).results[0].title, 'Oracle');
  for (const q of ['Orcale', 'Orcle', 'Oraccle', 'Oraclex']) assert.equal(index.search({ q }).results[0].title, 'Oracle');
  assert.equal(index.search({ q: 'acbd' }).results[0].title, 'Abcd');
  assert.equal(index.search({ q: 'jeff fortuen' }).results[0].title, 'Fortune Teller');
  assert.equal(index.search({ q: 'Oracle missingword' }).total, 0);
});

test('all characters includes every team and filters combine before pagination', () => {
  const docs = Array.from({ length: 73 }, (_, i) => char('Role ' + String(i).padStart(2, '0'), {
    team: i % 2 ? 'loric' : 'townsfolk', creators: ['Jøhn'], tags: ['Info'], sets: ['The Set'], curata: i % 2 === 0
  })).concat({ type: 'script', title: 'Role Script', url: '/s/role' });
  const index = new Index(docs);
  assert.equal(index.search({ type: 'character' }).total, 73);
  assert.equal(index.search({ q: 'role', type: 'character', page: 3 }).results.length, 13);
  const result = index.search({ type: 'character', team: 'townsfolk', creator: 'john', tag: 'info', set: 'the set', status: 'curata' });
  assert.equal(result.total, 37);
  assert.equal(index.search({ q: 'role', type: 'script' }).counts.character, 73);
  assert.equal(index.search({ page: 999 }).page, 3);
});

test('public projection keeps canonical routes and signed remote image URLs', () => {
  const doc = contentDocument('character', { slug: 'oracle', page: 'c/set/oracle', name: 'Oracle',
    art: 'https://example.com/image.png?signature=keep', v: 'new', editors: [42], creator: 'Jeff, Jane' });
  assert.equal(doc.url, '/c/set/oracle');
  assert.equal(doc.image, 'https://example.com/image.png?signature=keep');
  assert.deepEqual(doc.creators, ['Jeff', 'Jane']);
  assert.ok(!('editors' in doc));
  assert.equal(contentDocument('collection', { slug: 'Old Name', id: 'the-set', displayName: 'The Set' }).url, '/collection/the-set');
  const punctuation = completeIndex([contentDocument('character', { slug: 'x', name: 'Role', creator: 'dj_dj_dj', tags: 'no_ability' })], []);
  assert.ok(punctuation.documents.some(x => x.url === '/author?a=dj_dj_dj'));
  assert.ok(punctuation.documents.some(x => x.url === '/tag?t=no_ability'));
  const account = completeIndex([], [{ username: 'jeff', avatar_url: '/assets/avatars/1.webp?v=123' }]);
  assert.equal(account.documents.find(x => x.type === 'user').image, '/assets/avatars/1.webp?v=123');
});

test('index includes every public entity and excludes drafts, hidden parents and account secrets', async () => {
  const f = await fixture();
  f.insert('characters', 'oracle', { name: 'Öracle', creator: 'Jeff', tags: 'Info', team: 'loric', editors: [444] });
  f.insert('characters', 'hidden', { name: 'DRAFT_SECRET' }, 'draft');
  f.insert('scripts', 'live', { name: 'Live Script', author: 'Jane' });
  f.insert('scripts', 'draft', { name: 'DRAFT_PARENT' }, 'draft');
  f.insert('collections', 'Legacy Collection', { displayName: 'Collection', id: 'collection' });
  await f.hooks.ensurePagesTable(f.env);
  for (const [slug, parent, status] of [['guide', 'live', 'published'], ['private-page', 'live', 'draft'], ['hidden-parent', 'draft', 'published'], ['orphan', 'missing', 'published']]) {
    f.db.prepare('INSERT INTO pages(slug,title,parent_type,parent_slug,status,data) VALUES(?,?,?,?,?,?)')
      .run(slug, slug, 'script', parent, status, JSON.stringify({ title: slug, body: 'Published glossary rules', editors: [444] }));
  }
  f.db.prepare('INSERT INTO users(username,password_hash,email,display_name,bio,discord_id) VALUES(?,?,?,?,?,?)')
    .run('jeff', 'PASSWORD_SECRET', 'EMAIL_SECRET', 'Jeff', 'BIO_SECRET', 'DISCORD_SECRET');
  // Bootstrap auto-created news table, then invalidate after writing content.
  await f.request('/api/news');
  f.db.prepare('INSERT INTO news(slug,title,status,data) VALUES(?,?,?,?)').run('update', 'Wiki Update', 'published', '{"body":"Hello"}');
  f.db.prepare('INSERT INTO news(slug,title,status,data) VALUES(?,?,?,?)').run('draft-news', 'NEWS_SECRET', 'draft', '{}');
  const response = await f.request('/api/search-index?drafts=1');
  assert.equal(response.status, 200);
  const text = await response.text(), { documents } = JSON.parse(text);
  assert.deepEqual(new Set(documents.map(x => x.type)), new Set(['character', 'script', 'collection', 'page', 'news', 'user', 'creator', 'tag', 'tool']));
  assert.equal(documents.find(x => x.type === 'character').url, '/c/test-set/oracle');
  assert.equal(documents.find(x => x.type === 'script').url, '/s/live');
  assert.equal(documents.find(x => x.type === 'collection').url, '/collection/collection');
  assert.ok(documents.some(x => x.url === '/p/guide'));
  assert.doesNotMatch(text, /SECRET|private-page|hidden-parent|orphan|editors|444/);
  const calls = f.calls.length;
  assert.equal((await f.request('/api/search-index', { headers: { 'If-None-Match': response.headers.get('ETag') } })).status, 304);
  assert.equal(f.calls.length, calls);
  f.db.prepare("UPDATE characters SET status='draft' WHERE slug='oracle'").run();
  await f.hooks.bumpContentVersion(f.env, 'character');
  assert.doesNotMatch(await (await f.request('/api/search-index')).text(), /Öracle/);
  await f.finish();
});

test('simultaneous index requests coalesce and failed builds retry', async () => {
  const f = await fixture();
  f.insert('characters', 'oracle', { name: 'Oracle' });
  let fail = true;
  f.state.intercept = ({ sql, value }) => { if (fail && sql.includes('SELECT username, display_name, avatar_url FROM users')) throw new Error('unavailable'); return value; };
  const failed = await f.request('/api/search-index');
  assert.equal(failed.status, 503);
  assert.match(failed.headers.get('Cache-Control'), /no-store/);
  fail = false;
  const count = f.calls.filter(x => x.sql.includes('SELECT username, display_name, avatar_url FROM users')).length;
  const responses = await Promise.all(Array.from({ length: 16 }, () => f.request('/api/search-index')));
  assert.ok(responses.every(x => x.status === 200));
  assert.equal(f.calls.filter(x => x.sql.includes('SELECT username, display_name, avatar_url FROM users')).length - count, 1);
  await f.finish();
});

test('local benchmark: 10,000 documents, bounded result rendering', t => {
  const docs = Array.from({ length: 10000 }, (_, i) => char('Oracle ' + i, {
    summary: 'Each night choose a player. You learn their character.', creator: 'Creator ' + (i % 200), team: 'townsfolk'
  }));
  const start = performance.now(), index = new Index(docs), built = performance.now();
  const times = [];
  for (const q of ['oracle', 'orcale', 'night player', 'creator 35', 'no-match-at-all']) {
    const before = performance.now(), result = index.search({ q });
    times.push(performance.now() - before);
    assert.ok(result.results.length <= 30);
  }
  t.diagnostic('10,000 synthetic documents: build ' + (built - start).toFixed(1) + 'ms; queries ' + times.map(x => x.toFixed(1)).join(', ') + 'ms (local Node, not a deployed browser).');
});
