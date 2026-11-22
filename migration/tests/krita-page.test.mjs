import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

test('/krita/ serves R2 files cross-origin isolated, compressed files as stored, nothing outside krita/', async () => {
  const f = await fixture();
  const files = { 'krita/index.html': ['<p>k</p>'], 'krita/engine/k.wasm': ['w', 'br'], 'art/x.png': ['p'] };
  const obj = key => key in files && {
    body: files[key][0], size: files[key][0].length, httpEtag: '"e"',
    writeHttpMetadata(h) { if (files[key][1]) h.set('Content-Encoding', files[key][1]); }
  };
  f.env.ART = { async get(key) { return obj(key) || null; }, async head(key) { const o = obj(key); if (o) delete o.body; return o || null; } };
  try {
    const page = await f.safeRequest('/krita/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
    assert.equal(page.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(page.headers.get('Content-Type'), /text\/html/);
    const wasm = await f.safeRequest('/krita/engine/k.wasm');
    assert.equal(wasm.headers.get('Content-Type'), 'application/wasm');
    assert.equal(wasm.headers.get('Content-Encoding'), 'br');
    assert.equal((await f.safeRequest('/krita/engine/k.wasm', { method: 'HEAD' })).headers.get('Content-Length'), '1');
    const missing = await f.safeRequest('/krita/missing.js');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    assert.equal((await f.safeRequest('/krita/%2e%2e/art/x.png')).status, 404);
    assert.equal((await f.safeRequest('/krita')).status, 301);
    assert.equal((await f.safeRequest('/krita/', { method: 'POST' })).status, 405);
    assert.equal((await f.safeRequest('/tools')).headers.get('Cross-Origin-Embedder-Policy'), null);
  } finally { await f.finish(); }
});
