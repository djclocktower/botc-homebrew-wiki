/* Custom CSS: what a page's author typed into the "Custom CSS" box, made safe
   to print into <style> on their page. Browser + Worker (no DOM, no globals at
   top level), so the editors' live check and the page say the same thing.

   CustomCSS.clean(text) -> { css, warnings[] }

   Nothing is trusted, and the output is REBUILT from what was understood
   rather than filtered from what was typed. The rules, and the hole each one
   closes:

   - Every selector is rewritten to sit under `.ucss`, the wrapper around the
     page's own content (pageShell / profile.html). `body`, `html`, `:root`
     and `:scope` at the start of a selector MEAN that wrapper, so CSS written
     for a whole web page still lands. Nothing can select the site's top bar,
     the footer, the comments or the frame around the page. The frame
     (.ucss-frame in styles.css) uses paint containment, so a transform, a
     negative margin or position:fixed cannot draw outside the page area
     either.
   - Nested style rules are dropped: native nesting lets `&` stand anywhere
     in a selector (`.topbar:not(&)`), which would undo the scoping above.
     For the same reason `&` is refused in a top-level selector.
   - Only `url()` may fetch anything, and only an https:// address (never an
     /api/ path), a site path under /assets/, a #fragment or a data:image.
     image-set(), src(), image(), cross-fade(), element() and friends are
     refused outright: several take a bare string as an address, which a
     url() check would never see. @import is dropped.
   - A backslash outside a string is refused: CSS escapes would let
     `u\72 l(` spell url( past every check above. Inside strings they are
     kept (content: "\201C" is ordinary CSS).
   - Global at-rules are dropped (@import, @layer, @property, @counter-style,
     @page, @namespace, @scope, @font-feature-values …): each one names
     something site-wide, and @property in particular could re-type a
     custom property the whole site's stylesheet depends on.
   - @keyframes and @font-face names are global too, so they are prefixed
     (`u-name`) and every animation / font-family that uses one is rewritten
     to match. Without it, a page declaring @font-face 'Dumbledor2' would
     re-letter the site's own top bar for everyone reading it.
   - `<` never survives, in or out of strings, so the text can never close
     the <style> element it is printed into.

   What it keeps: every property and value otherwise, @media, @supports,
   @container, @starting-style (recursively scoped), :hover, ::before,
   animations, custom properties, filters, gradients, grid — the lot. */
(function () {
  'use strict';

  // Scoped under .ucss, but weighted like an id: :is() takes the specificity
  // of its strongest argument, and #ucss (which nothing carries) makes that
  // (1,0,0). A bare `.ucss h1` lost to the site's own theme rules
  // (`.theme-heading :is(... .script-title-fallback ...)`) and to things like
  // `.sv-section p`, so most of what an author typed simply did nothing.
  var ROOT = ':is(.ucss,#ucss)';
  var NAME_PREFIX = 'u-';
  var MAX_DEPTH = 6;
  var GROUP_AT = { media: 1, supports: 1, container: 1, 'starting-style': 1 };
  var BAD_FUNCS = {
    expression: 1, 'image-set': 1, '-webkit-image-set': 1, image: 1,
    'cross-fade': 1, '-webkit-cross-fade': 1, src: 1, element: 1,
    '-moz-element': 1, paint: 1, '-webkit-canvas': 1
  };
  var BAD_PROPS = { behavior: 1, '-ms-behavior': 1, '-moz-binding': 1 };
  var BAD = '\u0002';
  var PH_RE = /\u0001(\d+)\u0001/g;

  function isNameChar(c) { return /[A-Za-z0-9_\-]/.test(c) || c > '\u007f'; }
  function isNameStart(c) { return /[A-Za-z_\-]/.test(c) || c > '\u007f'; }

  /* A url()'s contents -> the address to print, or null. */
  function okUrl(u) {
    u = String(u || '').trim();
    if (!u) return null;
    if (/^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(u)) {
      if (/[\\\u0000-\u001f]/.test(u)) return null;
      // An SVG written out longhand: the characters a CSS string or the
      // data: URL itself would choke on, percent-encoded.
      return u.replace(/%(?![0-9a-f]{2})/gi, '%25').replace(/"/g, '%22')
        .replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23');
    }
    if (u.length > 2000 || /[\s"'()\\<>]/.test(u)) return null;
    if (/^#[A-Za-z][\w-]*$/.test(u)) return u;
    if (/^assets\//i.test(u)) u = '/' + u;
    if (/^\/assets\/[A-Za-z0-9._~\/-]+(\?[A-Za-z0-9=&._-]*)?$/.test(u)) {
      return (/\.\.|\/\//.test(u)) ? null : u;
    }
    var m = u.match(/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(\/[^\s]*)?$/i);
    if (!m) return null;
    // Never one of a site's API routes, whatever the host: a GET there can
    // still spend a reader's rate limit (the Discord sign-in start does).
    if (/^\/api(\/|$)/i.test(m[1] || '')) return null;
    return u;
  }

  /* Pass 1: comments out, strings and url()s replaced by numbered
     placeholders (so the structure parse never sees a ; or { inside one),
     and anything refused replaced by the BAD marker, which takes its whole
     declaration or selector down with it in pass 2. */
  function lex(src, out, warn) {
    var s = String(src || '').replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '');
    var res = '', i = 0, n = s.length;
    function readString(q, j) {
      var body = '', bad = false;
      while (j < n) {
        var c = s[j];
        if (c === '\\') {
          if (s[j + 1] === '\n') { j += 2; continue; }
          body += c + (s[j + 1] || ''); j += 2; continue;
        }
        if (c === q) return { body: body, end: j + 1, bad: false };
        if (c === '\n' || c === '\r' || c === '\f') { bad = true; break; }
        body += c; j++;
      }
      return { body: body, end: j, bad: true };
    }
    function place(text) { out.push(text); return '\u0001' + (out.length - 1) + '\u0001'; }
    while (i < n) {
      var c = s[i];
      if (c === '/' && s[i + 1] === '*') {
        var e = s.indexOf('*/', i + 2);
        i = e < 0 ? n : e + 2; res += ' '; continue;
      }
      if (c === '"' || c === "'") {
        var st = readString(c, i + 1);
        i = st.end;
        if (st.bad) { warn('An unfinished "quoted text" was removed.'); res += BAD; continue; }
        res += place(c + st.body.replace(/</g, '\\3c ') + c);
        continue;
      }
      if (c === '\\') {
        warn('Backslash escapes are only allowed inside quotes.');
        res += BAD; i += 2; continue;
      }
      if (c === '<') { warn('"<" is not allowed outside quotes.'); res += BAD; i++; continue; }
      if (isNameStart(c) && !(i > 0 && isNameChar(s[i - 1]))) {
        var j = i;
        while (j < n && isNameChar(s[j])) j++;
        var name = s.slice(i, j);
        if (s[j] === '(') {
          var lower = name.toLowerCase();
          if (lower === 'url') {
            var k = j + 1;
            while (k < n && /\s/.test(s[k])) k++;
            var raw = null, endAt = -1;
            if (s[k] === '"' || s[k] === "'") {
              var us = readString(s[k], k + 1);
              if (!us.bad && us.body.indexOf('\\') < 0) raw = us.body;
              k = us.end;
            } else {
              var close = s.indexOf(')', k);
              raw = close < 0 ? null : s.slice(k, close);
              k = close < 0 ? n : close;
            }
            while (k < n && /\s/.test(s[k])) k++;
            if (s[k] === ')') endAt = k + 1;
            var good = endAt > 0 ? okUrl(raw) : null;
            if (good === null) {
              warn('An image address was removed: only https:// links, /assets/ paths and data:image are allowed' +
                (raw ? ' (' + String(raw).slice(0, 60) + ')' : '') + '.');
              res += BAD; i = endAt > 0 ? endAt : Math.max(k, j + 1); continue;
            }
            res += place('url("' + good + '")');
            i = endAt; continue;
          }
          if (BAD_FUNCS[lower]) {
            warn(name + '() is not allowed — use url() instead.');
            res += BAD + name; i = j; continue;
          }
        }
        res += name; i = j; continue;
      }
      res += c; i++;
    }
    return res;
  }

  /* From an opening brace, the matching closing one (or the end). */
  function blockEnd(t, open) {
    var d = 0;
    for (var i = open; i < t.length; i++) {
      if (t[i] === '{') d++;
      else if (t[i] === '}') { d--; if (d === 0) return i; }
    }
    return t.length;
  }

  // Split on a separator that sits outside () and [].
  function splitTop(t, sep) {
    var parts = [], d = 0, start = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (c === '(' || c === '[') d++;
      else if ((c === ')' || c === ']') && d > 0) d--;
      else if (c === sep && d === 0) { parts.push(t.slice(start, i)); start = i + 1; }
    }
    parts.push(t.slice(start));
    return parts;
  }

  function scopeOne(sel) {
    var rest = sel, isRoot = false, m;
    for (;;) {
      m = rest.match(/^(?:html|:root|:scope|body)(?![\w-])/i);
      if (!m) break;
      isRoot = true;
      rest = rest.slice(m[0].length);
      if (/^[.:#\[]/.test(rest)) return ROOT + rest;   // body.x, body::before
      rest = rest.replace(/^\s*[>~+]?\s*/, '');
      if (!rest) return ROOT;
    }
    return ROOT + ' ' + (isRoot ? rest : sel);
  }

  function scopeSelectors(prelude, warn) {
    var out = [];
    splitTop(prelude, ',').forEach(function (s) {
      s = s.replace(/\s+/g, ' ').trim();
      if (!s) return;
      if (s.indexOf(BAD) >= 0) return;
      if (s.indexOf('&') >= 0) { warn('"&" is not allowed in a selector ("' + s.slice(0, 40) + '").'); return; }
      if (/[;{}]/.test(s)) return;
      out.push(scopeOne(s));
    });
    return out.join(',');
  }

  function Cleaner(strings, warn) {
    this.strings = strings; this.warn = warn;
    this.keyframes = Object.create(null);
    this.fonts = Object.create(null);
  }

  // A placeholder or bare text -> the plain name it spells.
  Cleaner.prototype.unq = function (v) {
    v = String(v || '').trim();
    var m = v.match(/^\u0001(\d+)\u0001$/);
    if (m) { var s = this.strings[+m[1]] || ''; return s.slice(1, -1); }
    return v.replace(/\s+/g, ' ');
  };
  Cleaner.prototype.fontName = function (name) {
    return '"' + NAME_PREFIX + String(name).replace(/[^A-Za-z0-9 _-]/g, '').trim() + '"';
  };

  // The names a stylesheet declares, read before anything is printed so a
  // rule above its own @keyframes is still rewritten.
  Cleaner.prototype.collect = function (t) {
    var self = this, m;
    var kre = /@(?:-webkit-)?keyframes\s+(-?[A-Za-z_][\w-]*)/gi;
    while ((m = kre.exec(t))) self.keyframes[m[1]] = 1;
    var fre = /@font-face\s*\{([^}]*)\}/gi;
    while ((m = fre.exec(t))) {
      var fm = m[1].match(/font-family\s*:\s*([^;]+)/i);
      if (fm) {
        var name = self.unq(fm[1]);
        if (name) self.fonts[name.toLowerCase()] = name;
      }
    }
  };

  Cleaner.prototype.renameFonts = function (prop, value) {
    var self = this;
    if (prop !== 'font-family' && prop !== 'font') return value;
    return splitTop(value, ',').map(function (item, idx) {
      var name = self.unq(item).replace(/\s*!important$/i, '');
      if (self.fonts[name.toLowerCase()]) {
        return item.replace(item.trim().replace(/\s*!important$/i, ''), self.fontName(self.fonts[name.toLowerCase()]));
      }
      if (prop === 'font' && idx === 0) {
        // The family is the tail of `font: bold 2rem Name`.
        var keys = Object.keys(self.fonts);
        for (var k = 0; k < keys.length; k++) {
          var real = self.fonts[keys[k]];
          var esc = real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          var re = new RegExp('(^|\\s)(' + esc + ')\\s*$', 'i');
          if (re.test(item)) return item.replace(re, '$1' + self.fontName(real));
          var phm = item.match(/(\u0001\d+\u0001)\s*$/);
          if (phm && self.unq(phm[1]).toLowerCase() === keys[k]) {
            return item.replace(phm[1], self.fontName(real));
          }
        }
      }
      return item;
    }).join(',');
  };

  Cleaner.prototype.renameAnimations = function (prop, value) {
    var self = this;
    if (prop !== 'animation' && prop !== 'animation-name' && prop !== '-webkit-animation' &&
        prop !== '-webkit-animation-name') return value;
    return value.replace(/(^|[\s,])(-?[A-Za-z_][\w-]*)(?=$|[\s,!])/g, function (all, pre, name) {
      return self.keyframes[name] ? pre + NAME_PREFIX + name : all;
    });
  };

  /* A declaration block -> "prop:value;…". `fontFace` renames the family. */
  Cleaner.prototype.decls = function (inner, fontFace) {
    var self = this;
    // Nested rules (native CSS nesting) are taken out first; see the header.
    var flat = '', i = 0, segStart = 0;
    while (i < inner.length) {
      var c = inner[i];
      if (c === ';') { flat += inner.slice(segStart, i + 1); segStart = i + 1; }
      else if (c === '{') {
        var end = blockEnd(inner, i);
        self.warn('Nested rules are not supported — write each rule on its own.');
        i = end + 1; segStart = i; continue;
      }
      i++;
    }
    flat += inner.slice(segStart);
    var out = [];
    splitTop(flat, ';').forEach(function (d) {
      var colon = d.indexOf(':');
      if (colon < 0) return;
      var prop = d.slice(0, colon).trim();
      var value = d.slice(colon + 1).trim();
      var custom = /^--[A-Za-z0-9_-]+$/.test(prop);
      if (!custom) {
        prop = prop.toLowerCase();
        if (!/^-?[a-z][a-z0-9-]*$/.test(prop)) return;
      }
      if (BAD_PROPS[prop]) { self.warn('"' + prop + '" is not allowed.'); return; }
      if (value.indexOf(BAD) >= 0) return;
      if (!value && !custom) return;
      if (/[{}]/.test(value)) return;
      if (fontFace && prop === 'font-family') {
        var name = self.unq(value);
        if (!name) return;
        value = self.fontName(name);
      } else if (!custom) {
        value = self.renameAnimations(prop, self.renameFonts(prop, value));
      }
      out.push(prop + ':' + value);
    });
    return out.join(';');
  };

  Cleaner.prototype.keyframeRules = function (inner) {
    var self = this, out = '', pos = 0;
    while (pos < inner.length) {
      var open = inner.indexOf('{', pos);
      if (open < 0) break;
      var sel = inner.slice(pos, open).replace(/\s+/g, ' ').trim();
      var end = blockEnd(inner, open);
      if (/^(from|to|\d{1,3}(\.\d+)?%)( ?, ?(from|to|\d{1,3}(\.\d+)?%))*$/i.test(sel)) {
        out += sel + '{' + self.decls(inner.slice(open + 1, end)) + '}';
      }
      pos = end + 1;
    }
    return out;
  };

  Cleaner.prototype.rules = function (t, depth) {
    var self = this, out = '', pos = 0, n = t.length;
    while (pos < n) {
      var c = t[pos];
      if (/\s/.test(c) || c === ';' || c === '}') { pos++; continue; }
      if (c === '@') {
        var m = t.slice(pos).match(/^@(-?[A-Za-z][\w-]*)/);
        var name = m ? m[1].toLowerCase() : '';
        var j = pos + (m ? m[0].length : 1);
        // The prelude runs to the first ; or { outside parentheses.
        var d = 0, k = j;
        for (; k < n; k++) {
          if (t[k] === '(') d++;
          else if (t[k] === ')' && d > 0) d--;
          else if ((t[k] === ';' || t[k] === '{') && d === 0) break;
        }
        var prelude = t.slice(j, k).trim();
        if (k >= n || t[k] === ';') {
          if (name) self.warn('@' + name + ' was removed.');
          pos = k + 1; continue;
        }
        var end = blockEnd(t, k);
        var inner = t.slice(k + 1, end);
        pos = end + 1;
        if (GROUP_AT[name] && depth < MAX_DEPTH) {
          if (prelude.indexOf(BAD) >= 0 || /[{}]/.test(prelude)) continue;
          var body = self.rules(inner, depth + 1);
          if (body) out += '@' + name + ' ' + prelude + '{' + body + '}';
        } else if (name === 'keyframes' || name === '-webkit-keyframes') {
          var kn = prelude.match(/^-?[A-Za-z_][\w-]*$/);
          if (!kn || /^(none|initial|inherit|unset|revert|default)$/i.test(prelude)) {
            self.warn('An @keyframes needs a plain name.'); continue;
          }
          out += '@' + name + ' ' + NAME_PREFIX + prelude + '{' + self.keyframeRules(inner) + '}';
        } else if (name === 'font-face' && depth === 0) {
          var ff = self.decls(inner, true);
          if (/(^|;)font-family:/.test(ff)) out += '@font-face{' + ff + '}';
        } else {
          self.warn('@' + (name || '?') + ' is not supported here and was removed.');
        }
        continue;
      }
      // A style rule: selectors up to {, then its block.
      var open = -1, q = pos, pd = 0;
      for (; q < n; q++) {
        if (t[q] === '(' || t[q] === '[') pd++;
        else if ((t[q] === ')' || t[q] === ']') && pd > 0) pd--;
        else if (t[q] === '{' && pd === 0) { open = q; break; }
        else if ((t[q] === ';' || t[q] === '}') && pd === 0) break;
      }
      if (open < 0) {
        self.warn('Some text that is not a CSS rule was removed ("' +
          t.slice(pos, Math.min(q, pos + 40)).replace(/[\u0001\u0002]\d*\u0001?/g, '').trim() + '").');
        pos = q + 1; continue;
      }
      var rEnd = blockEnd(t, open);
      var sels = scopeSelectors(t.slice(pos, open), self.warn);
      var decls = self.decls(t.slice(open + 1, rEnd));
      pos = rEnd + 1;
      if (sels && decls) out += sels + '{' + decls + '}';
    }
    return out;
  };

  function clean(text) {
    var warnings = [];
    function warn(msg) { if (warnings.indexOf(msg) < 0 && warnings.length < 30) warnings.push(msg); }
    if (typeof text !== 'string' || !text.trim()) return { css: '', warnings: warnings };
    var strings = [];
    var t = lex(text, strings, warn);
    var c = new Cleaner(strings, warn);
    c.collect(t);
    var css = c.rules(t, 0).replace(PH_RE, function (all, i) { return strings[+i] || '""'; });
    // Belt and braces: nothing above lets one through, and a "<" is the one
    // character that could end the <style> element this is printed into.
    css = css.replace(/</g, '\\3c ').replace(/[\u0001\u0002]/g, '');
    return { css: css, warnings: warnings };
  }

  var api = { clean: clean, ROOT: ROOT, okUrl: okUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CustomCSS = api;
})();
