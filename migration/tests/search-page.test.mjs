import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function pageFixture(url = '/search') {
  const html = await read('search.html'), nodes = new Map(), events = new Map(), frames = new Map();
  let nextFrame = 0;
  class Element {
    constructor() { this.value = ''; this.hidden = false; this.innerHTML = ''; this.textContent = ''; this.dataset = {}; this.attributes = {}; this.events = new Map(); this.classList = { toggle() {} }; }
    addEventListener(name, callback) { this.events.set(name, callback); }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelector() { return this.span; }
    scrollIntoView() {}
    dispatch(name, event = {}) { return this.events.get(name)?.call(this, { preventDefault() {}, ...event }); }
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Element());
  const types = [...html.matchAll(/data-type="([^"]+)"/g)].map(match => {
    const node = new Element(); node.dataset.type = match[1]; node.span = new Element(); return node;
  });
  nodes.get('search-types').querySelectorAll = () => types;
  const location = { pathname: '', search: '' };
  function navigate(url) { const next = new URL(url, 'https://wiki.test'); location.pathname = next.pathname; location.search = next.search; }
  navigate(url);
  const history = { entries: [], pushState(_, __, url) { this.entries.push(url); navigate(url); }, replaceState(_, __, url) { navigate(url); } };
  const docs = Array.from({ length: 72 }, (_, i) => ({ title: 'Oracle ' + i, type: 'character', team: 'loric', creators: ['Jøhn'], url: '/c/oracle-' + i }));
  const requests = [];
  const context = vm.createContext({ URLSearchParams, location, history,
    document: { getElementById: id => nodes.get(id), title: '' },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); queueMicrotask(() => { if (frames.has(id)) { frames.delete(id); callback(); } }); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    window: { addEventListener(name, cb) { events.set(name, cb); } }
  });
  vm.runInContext(await read('assets/search-engine.js'), context);
  const index = new context.BotcSearchEngine.Index(docs);
  context.window.BotcSearch = {
    warm: async () => ({ facets: index.facets }), escape: text => String(text).replaceAll('"', '&quot;'),
    resultHTML: doc => doc.title,
    search: async options => { requests.push({ ...options }); return index.search(options); }
  };
  vm.runInContext(await read('assets/search-page.js'), context);
  await flush();
  return { nodes, types, requests, location, history, context,
    back(url) { navigate(url); events.get('popstate')(); },
    clickType(type) { types.find(x => x.dataset.type === type).dispatch('click'); } };
}

test('results page restores URL filters, pagination and browser history', async () => {
  const f = await pageFixture('/search?q=orcale&type=character&team=loric&creator=John&page=2');
  assert.equal(f.nodes.get('wiki-query').value, 'orcale');
  assert.equal(f.nodes.get('search-team').value, 'loric');
  assert.equal(f.nodes.get('search-status-text').textContent, '72 results');
  assert.match(f.nodes.get('search-pagination').innerHTML, /Page 2 of 3/);
  const first = f.location.pathname + f.location.search;
  f.nodes.get('search-reset').dispatch('click'); await flush();
  assert.equal(new URLSearchParams(f.location.search).has('team'), false);
  assert.equal(f.nodes.get('wiki-query').value, 'orcale');
  f.back(first); await flush();
  assert.equal(f.nodes.get('search-team').value, 'loric');
  assert.match(f.nodes.get('search-pagination').innerHTML, /Page 2 of 3/);
});

test('all characters is always selectable and all other entity filters stay available', async () => {
  const f = await pageFixture();
  assert.equal(f.types.length, 10);
  f.clickType('character'); await flush();
  assert.equal(new URLSearchParams(f.location.search).get('type'), 'character');
  assert.equal(f.nodes.get('search-status-text').textContent, '72 results');
  f.nodes.get('search-team').value = 'loric'; f.nodes.get('search-team').dispatch('change'); await flush();
  f.clickType('script'); await flush();
  assert.equal(f.nodes.get('search-team').value, '');
  assert.match(f.nodes.get('search-results').innerHTML, /No results/);
  f.clickType('character'); await flush();
  assert.equal(f.nodes.get('search-status-text').textContent, '72 results');
});

test('query races, retry and pagination links preserve query state', async () => {
  const f = await pageFixture();
  let resolve;
  f.context.window.BotcSearch.search = () => new Promise(r => { resolve = r; });
  f.nodes.get('wiki-query').value = 'old'; f.nodes.get('wiki-query').dispatch('input'); await flush();
  const late = resolve;
  f.nodes.get('wiki-query').value = 'new'; f.nodes.get('wiki-query').dispatch('input'); await flush();
  late({ page: 1, total: 1, counts: {}, results: [{ title: 'STALE' }], pages: 1 }); await flush();
  assert.doesNotMatch(f.nodes.get('search-results').innerHTML, /STALE/);
  resolve({ page: 1, total: 0, counts: {}, results: [], pages: 0 }); await flush();
  assert.match(f.nodes.get('search-results').innerHTML, /No results/);
  f.context.window.BotcSearch.search = async () => { throw new Error('offline'); };
  f.nodes.get('search-retry').dispatch('click'); await flush();
  assert.equal(f.nodes.get('search-error').hidden, false);
  f.context.window.BotcSearch.search = async () => ({ page: 1, total: 1, counts: {}, results: [{ title: 'Recovered' }], pages: 1 });
  f.nodes.get('search-retry').dispatch('click'); await flush();
  assert.equal(f.nodes.get('search-error').hidden, true);
  assert.equal(f.nodes.get('search-results').innerHTML, 'Recovered');
});
