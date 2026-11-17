import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

test('/krita/ serves R2 files cross-origin isolated, and nothing outside krita/', async () => {
  const f = await fixture();
  const files = { 'krita/index.html': '<p>k</p>', 'krita/engine/k.wasm': 'w', 'art/x.png': 'p' };
  f.env.ART = { async get(key) { return key in files ? { body: files[key], httpEtag: '"e"' } : null; } };
  try {
    const page = await f.request('/krita/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
    assert.equal(page.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
    assert.match(page.headers.get('Content-Type'), /text\/html/);
    assert.equal((await f.request('/krita/engine/k.wasm')).headers.get('Content-Type'), 'application/wasm');
    assert.equal((await f.request('/krita/missing.js')).status, 404);
    assert.equal((await f.request('/krita/%2e%2e/art/x.png')).status, 404);
    assert.equal((await f.request('/krita')).status, 301);
  } finally { await f.finish(); }
});
