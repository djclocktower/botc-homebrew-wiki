import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

// Outside tools (the official script tool above all) read the wiki's images
// cross-origin. Every answer from the image route has to say they may: the
// picture, a 304, a 404, a HEAD and a preflight.
function r2(f) {
  const objects = new Map([['art/witch.png', Buffer.from('png'.repeat(400))]]);
  f.env.ART = {
    async get(key, options) {
      const body = objects.get(key); if (!body) return null;
      const meta = { size: body.length, httpEtag: '"e1"', writeHttpMetadata(h) { h.set('Content-Type', 'image/png'); } };
      return options?.onlyIf?.get('If-None-Match') === meta.httpEtag ? meta : { ...meta, body };
    }
  };
}
function assertCors(res, what) {
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', what);
  assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin', what);
  assert.match(res.headers.get('Access-Control-Expose-Headers') || '', /ETag/, what);
}
const origin = { Origin: 'https://script.bloodontheclocktower.com' };

test('image route answers every cross-origin request with CORS headers', async t => {
  const f = await fixture(); t.after(() => f.finish()); r2(f);
  const get = await f.request('/assets/art/witch.png', { headers: origin });
  assert.equal(get.status, 200); assertCors(get, 'GET');
  assert.equal((await get.arrayBuffer()).byteLength, 1200);

  const versioned = await f.request('/assets/art/witch.png?v=abc', { headers: origin });
  assert.equal(versioned.status, 200); assertCors(versioned, 'versioned GET');
  await Promise.all(f.background);
  const hit = await f.request('/assets/art/witch.png?v=abc', { headers: origin });
  assertCors(hit, 'edge-cached GET');

  const notModified = await f.request('/assets/art/witch.png', { headers: { ...origin, 'If-None-Match': '"e1"' } });
  assert.equal(notModified.status, 304); assertCors(notModified, '304');

  const head = await f.request('/assets/art/witch.png', { method: 'HEAD', headers: origin });
  assert.equal(head.status, 200); assertCors(head, 'HEAD');
  assert.equal(head.headers.get('Content-Type'), 'image/png');
  assert.equal(head.body, null);

  const missing = await f.request('/assets/art/nobody.png', { headers: origin });
  assert.equal(missing.status, 404); assertCors(missing, '404');
  const missingThumb = await f.request('/assets/thumb/bad name', { headers: origin });
  assert.equal(missingThumb.status, 404); assertCors(missingThumb, 'thumb 404');

  const preflight = await f.request('/assets/art/witch.png', { method: 'OPTIONS', headers: {
    ...origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'cache-control' } });
  assert.equal(preflight.status, 204); assertCors(preflight, 'preflight');
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /GET/);
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'cache-control');
});

test('_headers gives committed files the same CORS set', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('../../_headers', import.meta.url), 'utf8');
  const block = text.split(/\n(?=\S)/).find(b => b.startsWith('/assets/*\n'));
  assert.match(block, /Access-Control-Allow-Origin: \*/);
  assert.match(block, /Cross-Origin-Resource-Policy: cross-origin/);
  assert.match(block, /Access-Control-Expose-Headers: ETag/);
});
