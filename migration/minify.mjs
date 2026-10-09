// Dependency-free minifiers for the immutable build (migration/build-assets.mjs).
//
// Both are deliberately CONSERVATIVE: they remove comments and whitespace and
// nothing else. No renaming, no rewriting of values, and never a change to the
// inside of a string, a template literal, a regex or a url(): the site's text
// overrides (site.js) match wording that comes out of string literals, so a
// string's bytes must survive exactly.
//
// The JS side is a real tokenizer, not a regex, and it KEEPS line breaks
// wherever one could matter to automatic semicolon insertion. When it cannot
// be sure what a `/` is, it gives up on that file (minifyJS returns null) and
// the build ships the original. The build then re-tokenizes the output and
// compiles it, so a minifier bug fails the build instead of the site.
//
// Deterministic by construction: same input, same output, on any Node.

/* ======================================================================
   JavaScript
   ====================================================================== */

const KEYWORDS_BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else']);
// A `/` after one of these could be either; refuse rather than guess.
const AMBIGUOUS_WORDS = new Set(['of', 'yield', 'await', 'let', 'async', 'get', 'set', 'static']);
const PUNCTUATORS = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '%=', '&=',
  '|=', '^=', '<<', '>>', '**'];
// After one of these, a line break is never where a statement could end, so
// dropping it cannot change what automatic semicolon insertion does.
const NO_ASI_AFTER = new Set(['{', '(', '[', ',', ';', ':', '?', '=', '==', '===', '!=', '!==', '<',
  '>', '<=', '>=', '+', '-', '*', '/', '%', '**', '&', '|', '^', '&&', '||', '??', '!', '~', '.',
  '?.', '=>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '&&=',
  '||=', '??=', '<<', '>>', '>>>', '...']);
// Nor before one of these: each can only continue what came before it.
const NO_ASI_BEFORE = new Set([')', ']', '}', ',', ';', '.', '?.', ':']);

const isLineTerm = c => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
const isSpace = c => c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\u00a0' ||
  c === '\ufeff' || (c > '\u007f' && /\s/.test(c) && !isLineTerm(c));
const isIdStart = c => /[A-Za-z_$\\#]/.test(c) || c > '\u007f';
const isIdPart = c => /[A-Za-z0-9_$\\]/.test(c) || (c > '\u007f' && !isSpace(c) && !isLineTerm(c));
const isDigit = c => c >= '0' && c <= '9';

class Unsure extends Error {}

// Returns [{type, value, nl}] where type is ws | comment | str | tpl | regex |
// name | num | punc. `nl` marks whitespace or a comment holding a line break.
export function tokenizeJS(src) {
  const out = [];
  const braces = [];        // '{' for a block/object, 'tpl' for a ${ } inside a template
  const parens = [];        // the significant token that preceded each '('
  let i = 0, prev = null;   // prev: last significant token
  const push = (type, value, extra) => {
    const token = { type, value, ...extra };
    out.push(token);
    if (type !== 'ws' && type !== 'comment') prev = token;
    return token;
  };
  // Reads template characters from i (just after ` or }) to the closing ` or ${.
  const templateChunk = start => {
    let j = i;
    for (;;) {
      if (j >= src.length) throw new Unsure('unterminated template');
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '`') { j++; break; }
      if (c === '$' && src[j + 1] === '{') { j += 2; braces.push('tpl'); break; }
      j++;
    }
    const value = src.slice(start, j);
    i = j;
    push('tpl', value, { ends: value.endsWith('`') });
  };
  const regexAllowed = () => {
    if (!prev) return true;
    const { type, value } = prev;
    if (type === 'num' || type === 'str' || type === 'regex') return false;
    if (type === 'tpl') return !prev.ends;   // after `${` an expression starts
    if (type === 'name') {
      if (KEYWORDS_BEFORE_EXPR.has(value)) return true;
      if (AMBIGUOUS_WORDS.has(value)) throw new Unsure('`/` after ' + value);
      return false;
    }
    // punctuator
    if (value === ']') return false;
    if (value === ')') {
      const opener = prev.opener;
      return !!(opener && opener.type === 'name' && /^(?:if|while|for|with)$/.test(opener.value));
    }
    if (value === '}' || value === '++' || value === '--') throw new Unsure('`/` after ' + value);
    return true;
  };
  while (i < src.length) {
    const c = src[i];
    const start = i;
    if (isLineTerm(c) || isSpace(c)) {
      let nl = false;
      while (i < src.length && (isLineTerm(src[i]) || isSpace(src[i]))) { if (isLineTerm(src[i])) nl = true; i++; }
      push('ws', src.slice(start, i), { nl });
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && !isLineTerm(src[i])) i++;
      push('comment', src.slice(start, i), { nl: false });
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Unsure('unterminated comment');
      i = end + 2;
      const value = src.slice(start, i);
      push('comment', value, { nl: /[\n\r\u2028\u2029]/.test(value) });
      continue;
    }
    // HTML-like comments are legal in classic scripts; nothing here uses them.
    if ((c === '<' && src.startsWith('<!--', i)) || (c === '-' && src.startsWith('-->', i))) throw new Unsure('HTML-like comment');
    if (c === '"' || c === "'") {
      i++;
      for (;;) {
        if (i >= src.length) throw new Unsure('unterminated string');
        const d = src[i];
        if (d === '\\') { i += src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2; continue; }
        if (d === c) { i++; break; }
        if (d === '\n' || d === '\r') throw new Unsure('line break in string');
        i++;
      }
      push('str', src.slice(start, i));
      continue;
    }
    if (c === '`') { i++; templateChunk(start); continue; }
    if (c === '}' && braces[braces.length - 1] === 'tpl') { braces.pop(); i++; templateChunk(start); continue; }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] || ''))) {
      const m = /^(?:0[xXoObB][0-9a-fA-F_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(src.slice(i, i + 400));
      i += m[0].length;
      if (i < src.length && isIdPart(src[i])) throw new Unsure('identifier straight after a number');
      push('num', src.slice(start, i));
      continue;
    }
    if (isIdStart(c)) {
      i++;
      while (i < src.length && isIdPart(src[i])) i++;
      push('name', src.slice(start, i));
      continue;
    }
    if (c === '/') {
      if (regexAllowed()) {
        i++;
        let inClass = false;
        for (;;) {
          if (i >= src.length || isLineTerm(src[i])) throw new Unsure('unterminated regex');
          const d = src[i];
          if (d === '\\') { i += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { i++; break; }
          i++;
        }
        while (i < src.length && isIdPart(src[i])) i++;
        push('regex', src.slice(start, i));
        continue;
      }
      const value = src[i + 1] === '=' ? '/=' : '/';
      i += value.length;
      push('punc', value);
      continue;
    }
    let value = c;
    for (const p of PUNCTUATORS) if (src.startsWith(p, i)) { value = p; break; }
    // `?.5` is a conditional followed by a number, not optional chaining.
    if (value === '?.' && isDigit(src[i + 2] || '')) value = '?';
    i += value.length;
    if (value === '{') braces.push('{');
    if (value === '}') braces.pop();
    if (value === '(') { parens.push(prev); push('punc', value); continue; }
    if (value === ')') { push('punc', value, { opener: parens.pop() }); continue; }
    if (/[A-Za-z0-9_$\s'"`]/.test(value)) throw new Unsure('unexpected character');
    push('punc', value);
  }
  if (braces.length) throw new Unsure('unbalanced braces');
  return out;
}

const wordy = c => /[A-Za-z0-9_$\\#]/.test(c) || c > '\u007f';
// Would writing `a` straight after `b` make different tokens?
function needsSpace(prevToken, next) {
  const a = prevToken.value[prevToken.value.length - 1], b = next.value[0];
  if (wordy(a) && wordy(b)) return true;
  if (prevToken.type === 'num' && b === '.') return true;
  if (prevToken.type === 'regex' && wordy(b)) return true;   // or `in` would read as flags
  if ((a === '+' && b === '+') || (a === '-' && b === '-')) return true;
  if (a === '/' && (b === '/' || b === '*')) return true;
  if ((a === '<' && b === '!') || (a === '-' && b === '>')) return true;
  if ((a === '?' && b === '.') || (a === '.' && /[0-9.]/.test(b))) return true;
  return false;
}

// Minified source, or null when the tokenizer was not sure of the file.
export function minifyJS(src, onSkip) {
  let tokens;
  try { tokens = tokenizeJS(src); } catch (error) { if (error instanceof Unsure) { if (onSkip) onSkip(error.message); return null; } throw error; }
  let out = '', last = null, gap = '';  // gap: '', ' ' or '\n' since `last`
  for (const t of tokens) {
    if (t.type === 'ws' || t.type === 'comment') {
      if (t.nl) gap = '\n';
      else if (!gap) gap = ' ';
      continue;
    }
    if (last) {
      let sep = gap;
      if (sep === '\n' && ((last.type === 'punc' && NO_ASI_AFTER.has(last.value)) ||
        (t.type === 'punc' && NO_ASI_BEFORE.has(t.value)))) sep = ' ';
      if (sep === ' ' && !needsSpace(last, t)) sep = '';
      out += sep;
    }
    out += t.value;
    last = t; gap = '';
  }
  return out + (out ? '\n' : '');
}

// The significant tokens, for comparing a file with its minified copy.
export function significantJS(src) {
  return tokenizeJS(src).filter(t => t.type !== 'ws' && t.type !== 'comment').map(t => t.value);
}

/* ======================================================================
   CSS
   ====================================================================== */

// [{type, value}] with type ws | comment | str | url | word | punc.
export function tokenizeCSS(src) {
  const out = [];
  let i = 0;
  const wordChar = c => c && !/[\s{}();:,>~+!*/\\'"[\]=|^$]/.test(c);
  while (i < src.length) {
    const c = src[i], start = i;
    if (/\s/.test(c)) { while (i < src.length && /\s/.test(src[i])) i++; out.push({ type: 'ws', value: src.slice(start, i) }); continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Unsure('Unterminated CSS comment');
      i = end + 2; out.push({ type: 'comment', value: src.slice(start, i) }); continue;
    }
    if (c === '"' || c === "'") {
      i++;
      for (;;) {
        if (i >= src.length) throw new Unsure('Unterminated CSS string');
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        if (src[i] === '\n') throw new Unsure('Line break in CSS string at line ' + src.slice(0, i).split('\n').length);
        i++;
      }
      out.push({ type: 'str', value: src.slice(start, i) }); continue;
    }
    // An unquoted url( ... ) is one token, raw: comments and quotes inside
    // are part of the address.
    const u = /^url\((?!\s*['"])/i.exec(src.slice(i, i + 64));
    if (u && (i === 0 || !wordChar(src[i - 1]))) {
      const end = src.indexOf(')', i);
      if (end < 0) throw new Unsure('Unterminated CSS url(');
      i = end + 1; out.push({ type: 'url', value: src.slice(start, i) }); continue;
    }
    if (c === '\\' || wordChar(c)) {
      while (i < src.length) {
        if (src[i] === '\\') {
          // An escape; a hex one may swallow one following whitespace.
          i++;
          const hex = /^[0-9a-fA-F]{1,6}/.exec(src.slice(i, i + 6));
          if (hex) { i += hex[0].length; if (/\s/.test(src[i] || '')) i++; }
          else i++;
          continue;
        }
        if (!wordChar(src[i])) break;
        i++;
      }
      out.push({ type: 'word', value: src.slice(start, i) }); continue;
    }
    i++; out.push({ type: 'punc', value: c });
  }
  return out;
}

export function minifyCSS(src, onSkip) {
  let tokens;
  try { tokens = tokenizeCSS(src); } catch (error) { if (error instanceof Unsure) { if (onSkip) onSkip(error.message); return null; } throw error; }
  // Mark every token with what kind of segment it sits in: a prelude (a
  // selector or an at-rule, ended by `{`) or a declaration (ended by ; or }).
  const sig = tokens.map((t, k) => k).filter(k => tokens[k].type !== 'ws' && tokens[k].type !== 'comment');
  const kind = new Array(tokens.length).fill('decl');
  const colonOf = new Array(tokens.length).fill(false);  // the property's own colon
  const depthAt = new Array(tokens.length).fill(0);      // parentheses open around it
  let segStart = 0, depth = 0;
  for (let n = 0; n <= sig.length; n++) {
    const k = sig[n], v = k == null ? null : tokens[k].value, type = k == null ? null : tokens[k].type;
    if (type === 'punc' && v === '(') depth++;
    if (type === 'punc' && v === ')') depth = Math.max(0, depth - 1);
    if (k != null) depthAt[k] = depth;
    if (k == null || (type === 'punc' && depth === 0 && (v === '{' || v === '}' || v === ';'))) {
      const segKind = k != null && v === '{' ? 'prelude' : 'decl';
      const from = segStart === 0 ? 0 : sig[segStart - 1] + 1, to = k == null ? tokens.length : k;
      for (let x = from; x < to; x++) kind[x] = segKind;
      if (segKind === 'decl') {
        for (let m = segStart; m < n; m++) if (tokens[sig[m]].type === 'punc' && tokens[sig[m]].value === ':') { colonOf[sig[m]] = true; break; }
      }
      segStart = n + 1;
    }
  }
  // Can the whitespace between tokens a and b go, given where it is?
  const dropBetween = (ai, bi) => {
    const a = tokens[ai], b = tokens[bi];
    const av = a.type === 'punc' ? a.value : null, bv = b.type === 'punc' ? b.value : null;
    // `--x: ;` is an empty custom property; older engines need the space.
    if (av === ':' && (bv === ';' || bv === '}')) return false;
    if (av === '{' || av === '}' || av === ';' || av === ',' || av === '(') return true;
    if (bv === '{' || bv === '}' || bv === ';' || bv === ',' || bv === ')' || bv === '!') return true;
    if (kind[ai] === 'prelude') {
      if (av === '>' || av === '~' || bv === '>' || bv === '~') return true;
      // `a + b` is a combinator in a selector; inside :nth-child() it is maths.
      if ((av === '+' || bv === '+') && depthAt[ai] === 0 && depthAt[bi] === 0) return true;
      return false;
    }
    // In a declaration: around the property's own colon.
    if ((av === ':' && colonOf[ai]) || (bv === ':' && colonOf[bi])) return true;
    return false;
  };
  let out = '', lastIdx = -1, gap = false, commentGap = false;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'ws') { gap = true; continue; }
    if (t.type === 'comment') { commentGap = true; continue; }
    if (lastIdx >= 0) {
      const a = tokens[lastIdx];
      if (gap) {
        if (!dropBetween(lastIdx, k)) out += ' ';
      } else if (commentGap) {
        // A comment between two tokens with no space still separates them.
        const lc = a.value[a.value.length - 1], fc = t.value[0];
        if (/[\w\-\\%.#@\u0080-\uffff]/.test(lc) && /[\w\-\\%.#@\u0080-\uffff(]/.test(fc)) out += '/**/';
      }
    }
    // `;}` -> `}`: the last declaration needs no terminator.
    if (t.type === 'punc' && t.value === '}' && out.endsWith(';') && lastIdx >= 0 && tokens[lastIdx].value === ';') out = out.slice(0, -1);
    out += t.value;
    lastIdx = k; gap = false; commentGap = false;
  }
  return out + (out ? '\n' : '');
}
