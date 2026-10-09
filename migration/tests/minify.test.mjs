// node --test migration/tests/minify.test.mjs
// The build's own minifiers (migration/minify.mjs): what they may remove, and
// everything they must leave exactly as written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { minifyCSS, minifyJS, significantJS } from '../minify.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const css = s => minifyCSS(s).trimEnd();
const js = s => { const out = minifyJS(s); return out == null ? null : out.trimEnd(); };

test('CSS: comments and whitespace go, strings, url() and escapes stay byte for byte', () => {
  assert.equal(css('/* head */\na  >  b ,\n c + d ~ e {\n  color : red ;\n  margin: 0 auto ;\n}\n'),
    'a>b,c+d~e{color:red;margin:0 auto}');
  // A brace, a semicolon or a comment inside a string is text.
  assert.equal(css('a::before { content: "{ ; }  /* not a comment */" ; }'),
    'a::before{content:"{ ; }  /* not a comment */"}');
  assert.equal(css(".i::before { content: '\\2713\\00a0'; }"), ".i::before{content:'\\2713\\00a0'}");
  // url(): unquoted is raw (spaces, slashes, a comment-looking run); quoted is a string.
  assert.equal(css('a { background: url( img/a b.png ) no-repeat; }'), 'a{background:url( img/a b.png ) no-repeat}');
  assert.equal(css('a { background: url(x/*y*/z.png); }'), 'a{background:url(x/*y*/z.png)}');
  const svg = "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 24 24'%3E%3Cpath d='M1 2 L3 4'/%3E%3C/svg%3E\")";
  assert.equal(css('.m { mask: ' + svg + ' center / contain; }'), '.m{mask:' + svg + ' center / contain}');
  assert.equal(css("a { background: url( 'x y.png' ); }"), "a{background:url('x y.png')}");
});

test('CSS: maths, selectors and at-rules keep the spaces that carry meaning', () => {
  // calc() needs its spaces around + and -; * and / keep theirs too.
  assert.equal(css('a { width: calc(100% - 2 * var(--gap) + 1px); top: calc( 1px + 2px ); }'),
    'a{width:calc(100% - 2 * var(--gap) + 1px);top:calc(1px + 2px)}');
  assert.equal(css('a { margin: -1px -2px; grid-area: 1 / 2 / 3; }'), 'a{margin:-1px -2px;grid-area:1 / 2 / 3}');
  // `a :hover` (any hovered descendant) is not `a:hover`.
  assert.equal(css('a :hover, b:not( .c ) { x: y }'), 'a :hover,b:not(.c){x:y}');
  assert.equal(css('li:nth-child(2n + 1) { x: y }'), 'li:nth-child(2n + 1){x:y}');
  // `and (` must not become the function `and(`.
  assert.equal(css('@media screen and (max-width: 600px) {\n  a { b: c }\n}'), '@media screen and (max-width: 600px){a{b:c}}');
  assert.equal(css('@supports not (display: grid) { a { b: c } }'), '@supports not (display: grid){a{b:c}}');
  assert.equal(css('a { color: red !important; }'), 'a{color:red!important}');
  // Custom properties: inner whitespace collapses, an empty value keeps its space.
  assert.equal(css(':root { --x: ; --font:  "A B" ,  serif ; --pad: 1px  2px; }'), ':root{--x: ;--font:"A B",serif;--pad:1px 2px}');
  // A comment between two words still separates them; between punctuation it just goes.
  assert.equal(css('.a/**/.b { x: y }'), '.a/**/.b{x:y}');
  assert.equal(css('a{x:y}/* gap */b{x:y}'), 'a{x:y}b{x:y}');
  assert.equal(css('.icon\\31 23 { x: y }'), '.icon\\31 23{x:y}');
});

test('CSS the minifier cannot read exactly is shipped as written', () => {
  const skipped = [];
  // An apostrophe stranded outside a comment opens a "bad string" in a browser.
  assert.equal(minifyCSS("/* a */ b */ it's\n a { x: y }", why => skipped.push(why)), null);
  assert.equal(minifyCSS('a { x: y } /* never closed'), null);
  assert.equal(skipped.length, 1);
});

test('JS: regex literals and division are told apart', () => {
  const src = 'var a = b / c / d;\nvar e = /re\\/[/]x/g.test(s);\nif (x) /y\\//.test(z);\nvar f = (1) / 2;\nreturn /=a/;';
  const out = js('function q(){' + src + '}');
  assert.ok(out.includes('/re\\/[/]x/g.test(s)') && out.includes('/y\\//.test(z)') && out.includes('/=a/'));
  assert.ok(out.includes('b/c/d') && out.includes('(1)/2'));
  assert.deepEqual(significantJS(out), significantJS('function q(){' + src + '}'));
  // `}` then `/` could be either; the file is left alone rather than guessed at.
  const skipped = [];
  assert.equal(minifyJS('if (a) {}\n/x/.test(y)', why => skipped.push(why)), null);
  assert.match(skipped[0], /after \}/);
  assert.equal(minifyJS('a++ / 2'), null);
});

test('JS: strings, templates and comment-like text inside them are untouched', () => {
  const tpl = 'var t = `a ${ { b: `c ${ d } // e` }.b } /* f */ ${ "}" }\n  g`;';
  // Code inside ${ } is code; the template's own text is kept exactly.
  assert.equal(js(tpl), 'var t=`a ${{b:`c ${d} // e`}.b} /* f */ ${"}"}\n  g`;');
  assert.equal(js("var u = 'http://x/*y*/' + \"  two  spaces  \" + 'it\\'s';"),
    "var u='http://x/*y*/'+\"  two  spaces  \"+'it\\'s';");
  assert.equal(js('var r = /\\/\\/ not a comment/; // a comment\nvar s = 1; /* gone */'),
    'var r=/\\/\\/ not a comment/;var s=1;');
  // `</script>` in a string stays, byte for byte (these files are never inlined).
  assert.equal(js('var h = "</script>";'), 'var h="</script>";');
});

test('JS: line breaks that automatic semicolon insertion depends on are kept', () => {
  assert.equal(js('a\n++b'), 'a\n++b');
  assert.equal(js('function f() {\n  return\n  x;\n}'), 'function f(){return\nx;}');
  assert.equal(js('let a = 1\nlet b = 2\n(c)'), 'let a=1\nlet b=2\n(c)');
  assert.equal(js('x = y\n  .z()\n  .w()'), 'x=y.z().w()');
  assert.equal(js('var o = {\n  a: 1,\n  b: [\n    2\n  ]\n};'), 'var o={a:1,b:[2]};');
  // Tokens that would merge keep a space between them.
  assert.equal(js('a + +b; c - -d; e + ++f; g - --h;'), 'a+ +b;c- -d;e+ ++f;g- --h;');
  assert.equal(js('x = 1 .toString(); y = a in b; z = typeof q;'), 'x=1 .toString();y=a in b;z=typeof q;');
  assert.equal(js('if (/a/g in o) p();'), 'if(/a/g in o)p();');
  // `a?.5` would be a conditional too, but the space is kept rather than relied on.
  assert.equal(js('var c = a ? .5 : 1;'), 'var c=a? .5:1;');
});

// Every real asset: same token stream, still compiles, same syntax tree.
test('every assets/*.js minifies to the same program', async t => {
  const files = (await readdir(resolve(root, 'assets'))).filter(f => f.endsWith('.js')).sort();
  const pairs = [];
  for (const file of files) {
    const src = await readFile(resolve(root, 'assets', file), 'utf8');
    try { new vm.Script(src); } catch { continue; }
    const out = minifyJS(src);
    if (out == null) continue;
    assert.equal(minifyJS(src), out, file + ' is deterministic');
    assert.deepEqual(significantJS(out), significantJS(src), file);
    assert.doesNotThrow(() => new vm.Script(out, { filename: file }), file);
    assert.ok(out.length < src.length, file);
    pairs.push([file, src, out]);
  }
  assert.ok(pairs.length > 40);
  // Node carries a copy of acorn for its own REPL; when it can be reached, the
  // syntax trees (positions aside) must be identical.
  const script = `
    const acorn = require('internal/deps/acorn/acorn/dist/acorn');
    const pairs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const strip = n => JSON.stringify(n, (k, v) => k === 'start' || k === 'end' ? undefined : v);
    const bad = pairs.filter(([f, a, b]) => strip(acorn.parse(a, { ecmaVersion: 'latest' })) !== strip(acorn.parse(b, { ecmaVersion: 'latest' })));
    console.log(JSON.stringify(bad.map(p => p[0])));`;
  let different;
  try {
    different = JSON.parse(execFileSync(process.execPath, ['--expose-internals', '-e', script],
      { input: JSON.stringify(pairs), stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString());
  } catch { t.skip('no acorn in this Node'); return; }
  assert.deepEqual(different, []);
});

test('every assets/*.css minifies, keeping every string and url() it had', async () => {
  for (const file of (await readdir(resolve(root, 'assets'))).filter(f => f.endsWith('.css'))) {
    const src = await readFile(resolve(root, 'assets', file), 'utf8');
    const out = minifyCSS(src);
    if (out == null) continue;
    assert.equal(minifyCSS(src), out);
    assert.ok(out.length < src.length, file);
    const literals = s => (s.replace(/\/\*[\s\S]*?\*\//g, '').match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\([^)'"]*\)/g) || []);
    assert.deepEqual(literals(out), literals(src), file);
  }
});
