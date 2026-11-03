// The browser-side editors: two widgets driven through a tiny stand-in DOM
// (approved-editors.js, special-editor.js).
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

test('special editor: every name and type the official schema lists is offered and kept', async () => {
  // botc-release script-schema.json, items -> special -> name / type enums.
  const NAMES = ['grimoire', 'pointing', 'ghost-votes', 'distribute-roles', 'bag-disabled', 'bag-duplicate',
    'evil-duplicate', 'good-duplicate', 'multiplier', 'hidden', 'replace-character', 'player', 'card',
    'open-eyes', 'public'];
  const TYPES = ['selection', 'ability', 'signal', 'vote', 'reveal', 'player', 'reminder'];
  const SE = (await load('assets/special-editor.js')).window.SpecialEditor;
  assert.deepEqual(NAMES.filter(n => !SE.NAMES.some(x => x[0] === n)), []);
  assert.deepEqual(TYPES.filter(t => !SE.TYPES.some(x => x[0] === t)), []);
  const R = (await import('node:module')).createRequire(import.meta.url)('../../assets/render.js');
  assert.deepEqual(plain(R.sanitizeSpecial(TYPES.map(type => ({ type, name: 'good-duplicate' })))).map(s => s.type), TYPES);
  // A value is a number or a short text, as the schema allows; an object never.
  assert.deepEqual(plain(R.sanitizeSpecial([
    { type: 'ability', name: 'card', value: 'You are the Demon' },
    { type: 'ability', name: 'multiplier', value: 3 },
    { type: 'ability', name: 'card', value: { x: 1 } }
  ])).map(s => s.value), ['You are the Demon', 3, undefined]);
});
