import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fixture } from './worker-fixture.mjs';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

/* /jinxes draws every character small — a map node, a panel head, a list
   row, a picker row — so the payload hands out the 192px WebP thumbnail every
   card on the wiki draws (thumb/{file}.webp, versioned by the row's `v`), never
   the full art. A remote `image` stays remote and a page with neither gets no
   icon at all: the map keeps its bare coloured ring rather than a favicon. */
test('/api/jinxes hands out versioned WebP thumbnails, never full art, and rolls its ETag with the format', async t => {
  const f = await fixture(); t.after(() => f.finish());
  f.insert('characters', 'alpha', {
    slug: 'alpha', name: 'Alpha', team: 'townsfolk', art: 'art/alpha.png', ability: 'x',
    jinxes: [{ slug: 'beta', name: 'Beta', text: 'Alpha and Beta' }, { id: 'imp', reason: 'Alpha and the Imp' },
      { slug: 'gamma', name: 'Gamma', text: 'Alpha and Gamma' }]
  });
  f.insert('characters', 'beta', { slug: 'beta', name: 'Beta', team: 'minion', image: 'https://example.com/beta.png', ability: 'x' });
  f.insert('characters', 'gamma', { slug: 'gamma', name: 'Gamma', team: 'demon', ability: 'x' });
  const response = await f.request('/api/jinxes');
  const body = await response.text(), data = JSON.parse(body);
  const node = id => data.nodes.find(n => n.id === id);
  assert.match(node('c:alpha').icon, /^https:\/\/botchomebrew\.wiki\/assets\/thumb\/alpha\.png\.webp\?v=[0-9a-z]+$/);
  assert.equal(node('c:beta').icon, 'https://example.com/beta.png');
  assert.equal(node('c:gamma').icon, '');
  // The official anchor keeps roles.json's own (already WebP) release image.
  assert.match(node('o:imp').icon, /^https:\/\/.+\.webp$/);
  assert.doesNotMatch(body, /\/assets\/art\//);
  assert.equal(data.edges.length, 3);
  const etag = response.headers.get('ETag');
  assert.match(etag, /^W\/"jinxes-v\d+-f\d+"$/);
  assert.equal((await f.request('/api/jinxes', { headers: { 'If-None-Match': etag } })).status, 304);
});

/* The picker in a bare DOM: a tiny element model is enough, because the
   control only ever creates, appends, attributes and listens. */
function element(tag) {
  let html = '';
  return {
    tag, children: [], attrs: {}, dataset: {}, listeners: {}, parentNode: null,
    hidden: false, textContent: '', value: '', className: '',
    offsetTop: 0, offsetHeight: 20, clientHeight: 200, scrollTop: 0,
    // Assigning innerHTML empties the element, as it does in a browser.
    get innerHTML() { return html; }, set innerHTML(v) { html = v; this.children = []; },
    classList: { set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      this.children.splice(i < 0 ? this.children.length : i, 0, c); c.parentNode = this; return c;
    },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    dispatchEvent(ev) { (this.listeners[ev.type] || []).forEach(fn => fn(ev)); return true; },
    fire(type, init) { return this.dispatchEvent({ type, preventDefault() {}, stopPropagation() {}, ...init }); }
  };
}
class Event { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } }

test('the jinx picker mounts over a caller-supplied list, groups it in order, and records the pick', async () => {
  const document = { createElement: element, activeElement: null };
  const context = vm.createContext({ window: {}, document, Event, setTimeout, URL });
  vm.runInContext(await read('assets/jinx-picker.js'), context);
  const form = element('div'), field = element('input');
  form.appendChild(field);
  document.activeElement = field;
  // No `fetch` in this context: a picker that reached for the whole roster
  // would fall over, so rows showing up at all proves the source was used.
  const mine = [
    { official: false, slug: 'zed', name: 'Zed', team: 'minion', icon: '/assets/thumb/zed.png.webp?v=1',
      group: 'Your characters', order: 0, meta: 'Minion' },
    { official: false, slug: 'amy', name: 'Amy', team: 'townsfolk', icon: '',
      group: 'Your drafts', order: 1, meta: 'Townsfolk · Draft' }
  ];
  context.window.mountJinxPicker(field, { source: () => mine, empty: 'None of yours' });
  await flush();
  const wrap = field.parentNode;
  assert.equal(wrap.className, 'jx-combo');
  const drop = wrap.children.find(c => c.className === 'jx-drop');
  assert.equal(field.getAttribute('role'), 'combobox');
  // The list arrived while the field had focus, so it opened by itself.
  assert.equal(drop.hidden, false);
  const shown = () => drop.children.map(c => c.className === 'jx-group' ? '[' + c.textContent + ']' : c.innerHTML.match(/jx-opt-name">([^<]+)/)[1]);
  // Published before drafts, whatever the alphabet says; each under its heading.
  assert.deepEqual(shown(), ['[Your characters]', 'Zed', '[Your drafts]', 'Amy']);
  assert.match(drop.children[1].innerHTML, /src="\/assets\/thumb\/zed\.png\.webp\?v=1"/);
  assert.match(drop.children[3].innerHTML, /<span class="jx-opt-ico"><\/span>/);
  assert.match(drop.children[3].innerHTML, /Townsfolk · Draft/);

  field.value = 'am'; field.fire('input');
  assert.deepEqual(shown(), ['[Your drafts]', 'Amy']);
  drop.children[1].fire('mousedown');
  assert.equal(field.value, 'Amy');
  assert.equal(field.dataset.slug, 'amy');
  assert.equal(field.dataset.team, 'townsfolk');
  assert.equal(field.dataset.id, undefined);
  assert.equal(drop.hidden, true);

  // Typing over a pick drops it: the text no longer describes what was picked.
  field.value = 'Amyx'; field.fire('input');
  assert.equal(field.dataset.slug, undefined);
  assert.match(drop.innerHTML, /None of yours/);

  // setJinxField restores one without the input handler wiping it.
  context.window.setJinxField(field, 'Zed', 'zed', '', 'minion');
  assert.equal(field.dataset.slug, 'zed');
  assert.equal(field.dataset.team, 'minion');
});

test('picker rows draw the versioned WebP thumbnail of art/, and only of art/', async () => {
  const context = vm.createContext({ window: {}, document: {}, URL });
  vm.runInContext(await read('assets/jinx-picker.js'), context);
  const icon = context.window.jinxCharIcon;
  assert.equal(icon({ art: 'art/witcher.png', v: 'k9z' }, '../'), '../assets/thumb/witcher.png.webp?v=k9z');
  assert.equal(icon({ art: 'art/witcher.png' }, '/'), '/assets/thumb/witcher.png.webp');
  assert.equal(icon({ art: 'collections/x.png', v: '1' }, '/'), '/assets/collections/x.png?v=1');
  assert.equal(icon({ image: 'https://example.com/a.png' }, '/'), 'https://example.com/a.png');
  assert.equal(icon({ image: ['https://example.com/b.png'] }, '/'), 'https://example.com/b.png');
  assert.equal(icon({}, '/'), '');
});
