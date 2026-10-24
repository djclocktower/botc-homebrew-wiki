import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './worker-fixture.mjs';

test('an uncaught error is a retry page or a JSON error, never Cloudflare\'s bare 1101', async () => {
  const f = await fixture();
  const realPrepare = f.env.DB.prepare;
  f.env.DB.prepare = () => { throw new Error('boom'); };
  const origError = console.error; const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await assert.rejects(f.request('/c/some-set/someone'), /boom/);
    const page = await f.safeRequest('/c/some-set/someone');
    assert.equal(page.status, 500);
    assert.match(page.headers.get('Content-Type'), /text\/html/);
    assert.equal(page.headers.get('Cache-Control'), 'no-store');
    assert.match(await page.text(), /Try again/);
    const api = await f.safeRequest('/api/news?limit=3');
    assert.equal(api.status, 500);
    assert.ok((await api.json()).error);
    assert.ok(logged.some(l => l.includes('/c/some-set/someone')));
  } finally {
    console.error = origError;
    f.env.DB.prepare = realPrepare;
    await f.finish();
  }
});
