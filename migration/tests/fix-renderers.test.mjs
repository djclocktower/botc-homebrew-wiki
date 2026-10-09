import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fixture } from './worker-fixture.mjs';

/* The shared renderers (render-wiki.js, render.js, render-page.js,
   classify.js): adversarial input that used to run super-linear or blow the
   stack, registries keyed by names that collide with Object.prototype, and
   the official-schema export following what the page shows. */

const require = createRequire(import.meta.url);
const WikiRender = require('../../assets/render-wiki.js');
const Render = require('../../assets/render.js');
const PageRender = require('../../assets/render-page.js');
const Classify = require('../../assets/classify.js');
Render.init(WikiRender);
PageRender.init(Render);

// Generous, but far below what the old regexes took (seconds to tens of
// seconds on these inputs).
function fast(label, fn, ms = 1000) {
  const t0 = performance.now();
  const out = fn();
  const took = performance.now() - t0;
  assert.ok(took < ms, label + ' took ' + Math.round(took) + ' ms');
  return out;
}

test('autoSummary is linear on hostile bodies and strips every mark', () => {
  fast('60k newlines', () => WikiRender.autoSummary('\n'.repeat(60000) + 'hello'));
  fast('60k [', () => WikiRender.autoSummary('['.repeat(60000)));
  fast('60k [[', () => WikiRender.autoSummary('[['.repeat(30000)));
  fast('60k spaced lines', () => WikiRender.autoSummary(' \n'.repeat(30000) + '# x'));
  assert.equal(WikiRender.autoSummary('\n'.repeat(60000) + 'hello'), 'hello');
  assert.equal(
    WikiRender.autoSummary('# Head\n{{drop|T}}he {{red|Imp}} meets {{i|the}} [[Imp|demon]] and [a link](https://x.y).\n![pic](art/a.png|right)\n| a | b |'),
    'Head The Imp meets the demon and a link.');
  const long = WikiRender.autoSummary('word '.repeat(1000));
  assert.ok(long.length <= 200 && long.endsWith('…'));
});

test('quotes and callouts nest only so deep, and never take the page down', () => {
  const html = fast('3000 >', () => WikiRender.renderBody('>'.repeat(3000)));
  assert.ok((html.match(/<blockquote/g) || []).length <= 8);
  fast('3000 nested callouts', () => WikiRender.renderBody('::: note\n'.repeat(3000) + 'x'));
  // A custom box of them renders the box rather than throwing.
  assert.match(WikiRender.renderBoxes([{ title: 'T', content: '>>>>'.repeat(1000) }]), /custom-box/);
});

test('headings and trailing whitespace are linear', () => {
  const html = fast('30k spaces in a heading', () => WikiRender.renderBody('# a' + ' '.repeat(30000) + 'b ##'));
  assert.match(html, /<h2[^>]*id="sec-a-b"/);
  assert.match(WikiRender.renderBody('## Title ##'), />Title</);
  // The same shape through the character page's custom boxes and the
  // script page's prose (their own trailing trims).
  const pad = 'a' + ' '.repeat(60000) + 'b';
  fast('custom box', () => Render.renderCharacter({ name: 'X', ability: 'y', customBoxes: [{ title: 't', content: pad }] }, '', ''));
  fast('tok fallback', () => PageRender.renderScriptPage({ name: 'S', synopsis: '[['.repeat(30000) + '\n\n' + pad, characters: [] }, [], {}));
});

test('contents box ids are unique across nested blocks, and its text is plain', () => {
  const headings = [];
  const html = WikiRender.renderBody('[toc]\n# {{red|Imp}} rules\n::: note\n# {{red|Imp}} rules\n:::\n> # {{red|Imp}} rules', { headings });
  const ids = headings.map(h => h.id);
  assert.equal(new Set(ids).size, 3, ids.join(','));
  assert.ok(headings.every(h => h.text === 'Imp rules'));
  assert.ok(!/\{\{red/.test(html.slice(0, html.indexOf('</nav>'))));
});

test('a callout title is not lost when it names no kind', () => {
  assert.match(WikiRender.renderBody('::: Important rule\nx\n:::'), /wiki-callout-note"><div class="wiki-callout-head">Important rule</);
  assert.match(WikiRender.renderBody('::: tip Watch out\nx\n:::'), /wiki-callout-tip"><div class="wiki-callout-head">Watch out</);
  assert.match(WikiRender.renderBody('::: warning\nx\n:::'), /wiki-callout-head">Warning</);
});

test('table cells keep the pipes inside marks', () => {
  const html = WikiRender.renderBody('| {{red|Imp}} | [[Imp|the demon]] | ![](art/a.png|right) |\n| --- | --- | --- |\n| a | b | c |');
  assert.equal((html.match(/<th>/g) || []).length, 3);
  assert.match(html, /wiki-red">Imp</);
  assert.match(html, />the demon</);
  // Brackets that never close fall back to a plain split.
  const plain = WikiRender.renderBody('| [a | b |');
  assert.equal((plain.match(/<td>/g) || []).length, 2);
});

test('[[Name]] registries: prototype names, escaped text, accents and other scripts', () => {
  const key = WikiRender.linkKey;
  WikiRender.setOfficialNames({});
  WikiRender.setCharLinks({});
  // Nothing registered: a pill, never "function Object()".
  assert.equal(WikiRender.inlineFormat('[[Constructor]]'), '<span class="tok">Constructor</span>');
  assert.equal(WikiRender.inlineFormat('[[toString]]'), '<span class="tok">toString</span>');
  const links = {};
  links[key('Constructor')] = 'set/constructor';
  links[key('Tea & Crumpets')] = 'set/tea';
  links[key('Médium')] = 'set/medium';
  links[key('太一')] = 'set/taiyi';
  WikiRender.setCharLinks(links);
  assert.match(WikiRender.inlineFormat('[[Constructor]]'), /href="c\/set\/constructor"/);
  assert.match(WikiRender.inlineFormat('[[Tea & Crumpets]]'), /href="c\/set\/tea">Tea &amp; Crumpets</);
  assert.match(WikiRender.inlineFormat('[[Medium]]'), /href="c\/set\/medium"/);
  assert.match(WikiRender.inlineFormat('[[Médium]]'), /href="c\/set\/medium"/);
  assert.match(WikiRender.inlineFormat('[[太一]]'), /href="c\/set\/taiyi"/);
  // An empty key answers for nobody.
  WikiRender.setCharLinks({ '': 'set/nobody' });
  assert.equal(WikiRender.inlineFormat('[[É!]]'), '<span class="tok">É!</span>');
  assert.equal(WikiRender.inlineFormat('[[ ]]'), '<span class="tok"> </span>');
  WikiRender.setCharLinks({});
  // The official roster and reminder tokens are prototype-safe too.
  WikiRender.setOfficialNames({ imp: 'Imp' });
  assert.equal(WikiRender.inlineFormat('[[constructor]]'), '<span class="tok">constructor</span>');
  WikiRender.setReminderTokens(['Drunk']);
  assert.equal(WikiRender.inlineFormat('[[valueOf]]'), '<span class="tok">valueOf</span>');
  WikiRender.setReminderTokens(null);
  WikiRender.setOfficialNames({});
});

test('collections, rosters and the night order take a character called Constructor', () => {
  const ctor = { slug: 'constructor', name: 'Constructor', team: 'townsfolk', appearsIn: 'Set', firstNight: 5 };
  const other = { slug: 'other', name: 'Other', team: 'townsfolk', firstNight: 3 };
  assert.deepEqual(PageRender.resolveCollectionMembers({ match: ['set'] }, [ctor]).map(c => c.slug), ['constructor']);
  assert.deepEqual(PageRender.sortCollectionMembers({}, [ctor, other]).map(c => c.slug), ['constructor', 'other']);
  const night = PageRender.nightItems([ctor, other], { first: ['other'] });
  assert.deepEqual(night.first.map(it => it.c.slug), ['other', 'constructor']);
  const idx = Render.jinxCharIndex([ctor]);
  assert.equal(idx.byKey.constructor.slug, 'constructor');
  assert.equal(Render.findScriptJinxes([ctor, { ...other, jinxes: [{ name: 'Constructor', text: 'r' }] }]).length, 1);
});

test('jinx lookup keys fold accents the same on both sides', () => {
  const host = { slug: 'h', name: 'Host', page: 'c/my-set/host' };
  assert.deepEqual(Render.jinxLookupKeys({ name: 'Médium' }, host), ['mediummyset', 'medium']);
  // An id that says more than the name still goes first.
  assert.deepEqual(Render.jinxLookupKeys({ name: 'Warden', id: 'warden_potato_patch' }, host),
    ['wardenpotatopatch', 'wardenmyset', 'warden']);
  assert.equal(Render.normJinxId('Médium'), Render.slugId('Médium'));
});

test('the export: traveller art positions, the quote, and jinx ids', () => {
  const abs = p => Render.ART_ABS + p;
  // A traveller whose good art is the same file still exports three positions.
  let s = Render.buildSchema({ name: 'T', team: 'traveller', art: 'art/a.png', artAlt: 'art/a.png', artAlt2: 'art/e.png' });
  assert.deepEqual(s.image, [abs('art/a.png'), abs('art/a.png'), abs('art/e.png')]);
  s = Render.buildSchema({ name: 'T', team: 'traveler', art: 'art/a.png', artAlt2: 'art/e.png' });
  assert.deepEqual(s.image, [abs('art/a.png'), abs('art/a.png'), abs('art/e.png')]);
  s = Render.buildSchema({ name: 'T', team: 'traveller', art: 'art/a.png', artAlt: 'art/g.png' });
  assert.deepEqual(s.image, [abs('art/a.png'), abs('art/g.png')]);
  // Anyone else: at most [regular, flipped], de-duplicated.
  s = Render.buildSchema({ name: 'N', team: 'minion', art: 'art/a.png', artAlt: 'art/b.png', artAlt2: 'art/c.png' });
  assert.deepEqual(s.image, [abs('art/a.png'), abs('art/b.png')]);
  s = Render.buildSchema({ name: 'N', team: 'minion', art: 'art/a.png', artAlt: 'art/a.png' });
  assert.deepEqual(s.image, [abs('art/a.png')]);

  // The quote the page shows is the flavour the export carries.
  s = Render.buildSchema({ name: 'Q', quote: 'New {{red|line}}', flavor: 'Old line' });
  assert.equal(s.flavor, 'New line');

  // A jinx exports the id its target's own export carries.
  Render.setWikiChars(Render.jinxCharIndex([
    { slug: 'warden-2', name: 'Warden', jsonId: 'warden_potato' },
    { slug: 'gardener', name: 'Gardener' }
  ]).byKey);
  s = Render.buildSchema({ name: 'X', jinxes: [
    { slug: 'warden-2', name: 'Warden', text: 'a' },
    { id: 'kept_as_written', name: 'Whoever', text: 'b' },
    { name: 'Gardener', text: 'c' }
  ] });
  assert.deepEqual(s.jinxes.map(j => j.id), ['warden_potato', 'kept_as_written', 'gardener']);
  Render.setWikiChars(null);
});

test('the official wiki link of a name with & is escaped exactly once', () => {
  const html = Render.renderCharacter({ name: 'X', ability: 'y', related: [{ type: 'official', name: 'Tea & Crumpets' }] }, '', '');
  assert.match(html, /href="https:\/\/wiki\.bloodontheclocktower\.com\/Tea_&amp;_Crumpets"/);
  assert.ok(!html.includes('&amp;amp;'));
});

test('a script exports its logo, falling back to the header, absolute either way', () => {
  const meta = sc => JSON.parse(PageRender.buildPageExport('S', 'A', sc.logo || sc.header, [], sc))[0];
  assert.equal(meta({ logo: 'scripts/s-logo.png' }).logo, 'https://botchomebrew.wiki/assets/scripts/s-logo.png');
  assert.equal(meta({ logo: 'https://cdn.example/x.png', header: 'scripts/h.png' }).logo, 'https://cdn.example/x.png');
  assert.equal(meta({ header: 'scripts/h.png' }).logo, 'https://botchomebrew.wiki/assets/scripts/h.png');
  assert.equal(meta({}).logo, undefined);
  const page = PageRender.renderScriptPage({ name: 'S', slug: 's', logo: 'scripts/s-logo.png', characters: [] }, [], {});
  assert.ok(page.includes('https://botchomebrew.wiki/assets/scripts/s-logo.png'));
});

test('a stored classification is never trusted', async t => {
  assert.equal(Classify.classifyPage({ ability: 'x', classification: 'standard' }, 'character'), 'partial');
  const f = await fixture();
  t.after(() => f.finish());
  f.insert('characters', 'bare', { slug: 'bare', name: 'Bare', team: 'townsfolk', art: 'art/x.png', ability: 'Does a thing.', classification: 'standard' });
  for (const q of ['?fields=card', '?fields=grid', '']) {
    const rows = await (await f.request('/characters.json' + q)).json();
    assert.equal(rows.find(r => r.slug === 'bare').classification, 'partial', q);
  }
  // The script page's JSON names the logo of a logo-only script.
  f.insert('scripts', 'logo-only', { slug: 'logo-only', name: 'Logo Only', logo: 'scripts/logo-only-logo.png', characters: [] });
  const json = await (await f.request('/api/page-json?type=script&slug=logo-only')).json();
  assert.equal(json[0].logo, 'https://botchomebrew.wiki/assets/scripts/logo-only-logo.png');
});
