// The browser-side editors and importers: the parts of them that run without
// a page (import-merge.js, bloodstar.js) and two widgets driven through a
// tiny stand-in DOM (approved-editors.js, special-editor.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));
async function load(path, extra = {}) {
  const context = vm.createContext({ window: {}, ...extra });
  vm.runInContext(await read(path), context);
  return context;
}

const page = {
  slug: 'witch', status: 'published', updatedAt: '2026-10-01 10:00:00',
  data: {
    slug: 'witch', name: 'Witch', team: 'minion', ability: 'Old.', tags: 'Information, Kill',
    lede: 'Typed on the wiki.', summaryBullets: [], howToRun: ['Mine.'], customBoxes: [],
    firstNight: 30, firstNightReminder: 'Wake the Witch', otherNight: 20, reminders: ['Cursed'],
    jinxes: [{ id: 'imp', reason: 'kept' }], artAlt: 'art/witch-alt.png', token: 'art/witch-token.png'
  }
};

test('import-merge: a mechanic the import does not carry is the page\'s, not blanked', async () => {
  const M = (await load('assets/import-merge.js')).window.ImportMerge;
  // Bloodstar with "mechanics" unticked: no night order, reminders or jinxes in the object.
  const out = M.merge(page, { slug: 'witch', name: 'Witch', team: 'minion', ability: 'New.' }, {});
  assert.equal(out.ability, 'New.');
  assert.equal(out.firstNight, 30); assert.equal(out.firstNightReminder, 'Wake the Witch');
  assert.deepEqual(plain(out.reminders), ['Cursed']); assert.deepEqual(plain(out.jinxes), [{ id: 'imp', reason: 'kept' }]);
  // One it does carry still wins, empty or not.
  assert.deepEqual(plain(M.merge(page, { slug: 'witch', reminders: [] }, {}).reminders), []);
  // And the page's own state stays: published, its token, its second icon.
  assert.equal(out.status, 'published'); assert.equal(out.token, 'art/witch-token.png'); assert.equal(out.artAlt, 'art/witch-alt.png');
});

test('import-merge: almanac prose only fills what the page has none of, and tags are added', async () => {
  const M = (await load('assets/import-merge.js')).window.ImportMerge;
  const out = M.merge(page, {
    slug: 'witch', lede: 'From Bloodstar.', summaryBullets: ['A bullet.'], howToRun: ['Theirs.'],
    customBoxes: [{ title: 'Credit', content: 'X' }], tags: 'information, Misinformation'
  }, {});
  assert.equal(out.lede, 'Typed on the wiki.');
  assert.deepEqual(plain(out.howToRun), ['Mine.']);
  assert.deepEqual(plain(out.summaryBullets), ['A bullet.']);
  assert.deepEqual(plain(out.customBoxes), [{ title: 'Credit', content: 'X' }]);
  assert.equal(out.tags, 'Information, Kill, Misinformation');
  // A file with no tags leaves the page's exactly as they were.
  assert.equal(M.merge(page, { slug: 'witch' }, {}).tags, 'Information, Kill');
});

test('import-merge: a re-import lands on your own page of that name, not on the next free address', async () => {
  const M = (await load('assets/import-merge.js')).window.ImportMerge;
  const own = M.ownPages([
    { slug: 'witch-odyssey-2', name: 'Witch', created_at: '2026-09-02 00:00:00' },
    { slug: 'witch-odyssey', name: 'Witch', created_at: '2026-09-01 00:00:00' },
    { slug: 'imp-x', name: 'Imp', created_at: '2026-09-01 00:00:00' }
  ]);
  assert.deepEqual(plain(own.witch), ['witch-odyssey', 'witch-odyssey-2']);
  // Somebody else holds /witch: the first run's page, then the second's.
  const used = {};
  used[M.reuseOwn(own, 'Witch', used)] = 1;
  assert.deepEqual(Object.keys(used), ['witch-odyssey']);
  assert.equal(M.reuseOwn(own, 'WITCH', used), 'witch-odyssey-2');
  used['witch-odyssey-2'] = 1;
  assert.equal(M.reuseOwn(own, 'Witch', used), '', 'nothing of yours left: a new page');
  assert.equal(M.reuseOwn(own, 'Nobody', {}), '');
  assert.deepEqual(plain(M.ownPages(null)), {});
});

test('bloodstar: a traveller\'s third icon is carried like the second', async () => {
  const BI = (await load('assets/bloodstar.js')).window.BloodstarImport;
  const entry = { id: 'x', name: 'Busker', team: 'traveller', ability: 'A.',
    image: 'https://bloodstar.xyz/a.png', imageAlt: 'https://bloodstar.xyz/b.png', imageAlt2: 'https://bloodstar.xyz/c.png' };
  const opts = BI.defaultOptions();
  assert.equal(BI.artAlt2Key('busker'), 'art/busker-alt2.png');
  const copied = BI.characterPayload(entry, opts, 'busker', BI.artKey('busker'), [], BI.artAltKey('busker'), BI.artAlt2Key('busker'));
  assert.equal(copied.artAlt2, 'art/busker-alt2.png');
  assert.equal(copied.imageAlt2, 'https://botchomebrew.wiki/assets/art/busker-alt2.png');
  const linked = BI.characterPayload(entry, opts, 'busker', '', [], '', '');
  assert.equal(linked.imageAlt2, 'https://bloodstar.xyz/c.png');
  assert.equal(linked.artAlt2, undefined);
  assert.equal(opts.replaceArt, false);
});

// ── a stand-in DOM, just enough for the two widgets ──
function stub(extra = {}) {
  const listeners = {};
  return Object.assign({
    hidden: false, value: '', disabled: false, attrs: {},
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t, ev) { (listeners[t] || []).forEach(f => f(ev)); },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    focus() {}, classList: { add() {} }
  }, extra);
}

test('approved editors: loading a list is not a change, so it cannot wipe the stored one', async () => {
  const parts = { '.ae-chips': stub(), '.ae-input': stub(), '.ae-add-btn': stub(), '.ae-msg': stub() };
  const container = stub({ querySelector: sel => parts[sel] });
  const AE = (await load('assets/approved-editors.js')).window.ApprovedEditors;
  const calls = [];
  const ui = AE.mount(container, { onChange: list => calls.push(plain(list)) });
  assert.deepEqual(calls, [], 'the first draw is not the owner emptying the list');
  ui.set([{ id: 3, username: 'alice' }, { id: 4, username: 'bob' }]);
  assert.deepEqual(calls, [], 'set() is a load');
  assert.deepEqual(plain(ui.get()).map(e => e.username), ['alice', 'bob']);
  // A removal made here is a change.
  parts['.ae-chips'].fire('click', { target: { closest: () => ({ getAttribute: () => '0' }) } });
  assert.deepEqual(calls, [[{ id: 4, username: 'bob' }]]);
});

test('special editor: a property\'s `global` survives the editor', async () => {
  // Rows are parsed back out of the markup the widget writes, so what the
  // test reads is what a browser would show.
  function row() {
    let html = '';
    const r = stub({ className: '', remove() {} });
    Object.defineProperty(r, 'innerHTML', {
      set(h) { html = h; },
      get() { return html; }
    });
    r.querySelector = sel => {
      const cls = sel.slice(1);
      const m = html.match(new RegExp('<(select|input|button) class="' + cls + '"[^>]*>([\\s\\S]*?)(</select>|$)'));
      if (!m) return stub();
      if (m[1] === 'select') {
        const opt = m[2].match(/<option value="([^"]*)" selected>/) || m[2].match(/<option value="([^"]*)"/);
        return stub({ value: opt ? opt[1] : '' });
      }
      const v = m[0].match(/value="([^"]*)"/);
      return stub({ value: v ? v[1] : '' });
    };
    return r;
  }
  const rows = [];
  const list = stub({
    appendChild(c) { rows.push(c); return c; },
    querySelectorAll: () => rows.filter(r => r.className === 'special-row')
  });
  Object.defineProperty(list, 'innerHTML', { set() { rows.length = 0; } });
  const document = {
    getElementById: () => null,
    createElement: tag => tag === 'div' ? row() : stub(),
    body: { appendChild() {} }
  };
  const SE = (await load('assets/special-editor.js', { document })).window.SpecialEditor;
  const ui = SE.mount(list, null, {});
  ui.set([
    { type: 'signal', name: 'grimoire', time: 'night', global: 'townsfolk' },
    { type: 'selection', name: 'bag-disabled' }
  ]);
  assert.deepEqual(plain(ui.gather()), [
    { type: 'signal', name: 'grimoire', time: 'night', global: 'townsfolk' },
    { type: 'selection', name: 'bag-disabled' }
  ]);
});
