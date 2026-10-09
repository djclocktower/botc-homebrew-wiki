import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);

const adminPost = body => ({
  method: 'POST',
  headers: { Cookie: 'botc_session=admin', 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('site-text: a short site-wide phrase needs a confirmation, one character never goes', async t => {
  const f = await fixture();
  t.after(() => f.finish());
  f.db.prepare("INSERT INTO users(id,username,password_hash,is_admin) VALUES(1,'admin','',1)").run();
  f.state.sessions.set('sess:admin', { userId: 1, username: 'admin', isAdmin: true });
  const rows = () => f.db.prepare('SELECT scope, original, replacement FROM site_text ORDER BY original').all()
    .map(r => ({ ...r }));

  // "Each night" made site-wide from the list, with nobody asked: refused.
  let r = await f.request('/api/admin/site-text', adminPost({ scope: '*', original: 'Each night', replacement: 'Every night' }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).needsConfirm, true);
  assert.deepEqual(rows(), []);

  // Confirmed, it saves.
  r = await f.request('/api/admin/site-text', adminPost({ scope: '*', original: 'Each night', replacement: 'Every night', confirmShort: true }));
  assert.equal(r.status, 200);
  assert.deepEqual(rows(), [{ scope: '*', original: 'Each night', replacement: 'Every night' }]);

  // Scoped to one page, a short label needs no confirmation.
  r = await f.request('/api/admin/site-text', adminPost({ scope: '/scripts', original: 'Go', replacement: 'Open' }));
  assert.equal(r.status, 200);

  // A whole sentence of the site's own prose is safe on its own.
  r = await f.request('/api/admin/site-text', adminPost({ scope: '*', original: 'Nothing sent yet, so nothing to show.', replacement: 'Nothing yet.' }));
  assert.equal(r.status, 200);

  // A single character is never rewritten everywhere, confirmed or not.
  r = await f.request('/api/admin/site-text', adminPost({ scope: '*', original: 'a', replacement: 'b', confirmShort: true }));
  assert.equal(r.status, 400);

  // Reverting is always allowed, short or not.
  r = await f.request('/api/admin/site-text', adminPost({ scope: '*', original: 'Each night', action: 'revert' }));
  assert.equal(r.status, 200);
  assert.equal(rows().some(x => x.original === 'Each night'), false);
});

test('text-scan: built script names map back to their source files', () => {
  const T = require(new URL('assets/text-scan.js', root).pathname);
  assert.equal(T.assetPath('assets/immutable/site.0123456789abcdef0123.js'), 'assets/site.js');
  assert.equal(T.assetPath('/assets/immutable/render-page.0123456789abcdef0123.js?v=2'), 'assets/render-page.js');
  assert.equal(T.assetPath('../assets/card-filters.js'), 'assets/card-filters.js');
  // Subfolders count; sealed third-party payloads and other sites do not.
  assert.equal(T.assetPath('assets/iconforge/app.js'), 'assets/iconforge/app.js');
  assert.equal(T.assetPath('assets/iconforge/vendor/imgly.js'), null);
  assert.equal(T.assetPath('https://cdn.example.com/x.js'), null);
  assert.equal(T.assetPath('assets/immutable/not-hashed.js'), null);
});

/* The override block in site.js, run in a sandbox with just enough of a
   browser to boot. No DOM: what is asserted is the rule, not a page. */
async function siteTextBlock() {
  const src = await readFile(new URL('assets/site.js', root), 'utf8');
  const start = src.indexOf('(function () {\n  var KEY = \'botc_site_text\';');
  const end = src.indexOf('})();', start) + 5;
  assert.ok(start >= 0 && end > start, 'system-text block found');
  const block = src.slice(start, end);
  const sandbox = {
    window: {},
    location: { pathname: '/' },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { title: '', body: null, querySelector() { return null; } },
    fetch: () => new Promise(() => {}),
    NodeFilter: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(block, sandbox);
  // replaceBounded is private; lifted out of the same source to test it alone.
  const fn = block.match(/var WORDCH = [^\n]+\n\s*function replaceBounded[\s\S]*?\n {2}\}\n/);
  assert.ok(fn, 'replaceBounded found');
  vm.runInContext(fn[0] + 'this.replaceBounded = replaceBounded;', sandbox);
  return sandbox;
}

test('site.js: overrides skip what people wrote and only match whole words', async () => {
  const sb = await siteTextBlock();
  const el = (...classes) => ({
    nodeType: 1,
    closest(sel) { return sel.split(',').some(s => classes.includes(s.trim())) ? this : null; }
  });
  const skip = sb.window.SiteText.skip;
  // Somebody's writing: a comment, a card's ability, a wiki page body, a DM.
  for (const c of ['.cmt-body', '.char-card-ability', '.wiki-body', '.bubble', '.callout', '.ex', '.sv-tagline', '[data-user-content]']) {
    assert.equal(skip(el(c)), true, c + ' is skipped');
  }
  // The site's own wording around it is not.
  assert.equal(skip(el('.gen-sech')), false);
  assert.equal(skip(el('.nav-dropdown')), false);
  // A text node is judged by its parent.
  assert.equal(skip({ nodeType: 3, parentNode: el('.cmt-body') }), true);

  const rb = sb.replaceBounded;
  assert.equal(rb('Go to Good things', 'Go', 'Open'), 'Open to Good things');
  assert.equal(rb('Each night, Each nightly', 'Each night', 'Every night'), 'Every night, Each nightly');
  assert.equal(rb('Scripts and Script', 'Script', 'Grimoire'), 'Scripts and Grimoire');
  // An edge that is not a letter places no limit on that side.
  assert.equal(rb('x(see)y', '(see)', '[look]'), 'x[look]y');
});
