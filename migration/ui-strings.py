"""Lists the user-visible strings in a page or script that break the wiki's
wording rule: no em or en dashes, and nothing over LEN characters (110 by
default; MINLEN=60 in the environment lowers it).

    python3 migration/ui-strings.py script.html assets/script-builder.js

Pulls string literals out of JS (comments and regex literals skipped) and
the text plus title/placeholder/aria-label/alt/content attributes out of
HTML. Official ability text and SVG paths show up as long strings; read the
output rather than treating every hit as a fault."""
import os, re, sys, html as H

def js_strings(src):
    out = []; i = 0; n = len(src); line = 1
    while i < n:
        c = src[i]
        if c == '\n': line += 1; i += 1; continue
        if src.startswith('//', i):
            j = src.find('\n', i); i = n if j < 0 else j; continue
        if src.startswith('/*', i):
            j = src.find('*/', i + 2); seg = src[i:j+2]; line += seg.count('\n'); i = j + 2; continue
        if c in ('"', "'", '`'):
            q = c; j = i + 1; buf = []
            while j < n and src[j] != q:
                if src[j] == '\\': buf.append(src[j:j+2]); j += 2; continue
                if src[j] == '\n': line += 1
                buf.append(src[j]); j += 1
            out.append((line, ''.join(buf))); i = j + 1; continue
        if c == '/' :
            # a regex literal: previous non-space char decides
            k = i - 1
            while k >= 0 and src[k] in ' \t': k -= 1
            prev = src[k] if k >= 0 else ''
            if prev in '(,=:[!&|?{};\n' or prev == '':
                j = i + 1; cls = False
                while j < n and (src[j] != '/' or cls):
                    if src[j] == '\\': j += 2; continue
                    if src[j] == '[': cls = True
                    elif src[j] == ']': cls = False
                    elif src[j] == '\n': break
                    j += 1
                i = j + 1; continue
        i += 1
    return out

def html_strings(src):
    out = []
    # attributes that a reader sees
    for m in re.finditer(r'(?:title|placeholder|aria-label|alt|content)="([^"]*)"', src):
        out.append((src[:m.start()].count('\n') + 1, H.unescape(m.group(1))))
    # text between tags, outside <script>/<style>
    body = re.sub(r'<script\b.*?</script>', '', src, flags=re.S)
    body = re.sub(r'<style\b.*?</style>', '', body, flags=re.S)
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    pos = 0
    for m in re.finditer(r'>([^<]+)<', body):
        t = H.unescape(' '.join(m.group(1).split()))
        if t: out.append((body[:m.start()].count('\n') + 1, t))
    return out

DASH = re.compile('[—–]')
files = sys.argv[1:]
total = 0
for f in files:
    src = open(f, encoding='utf-8').read()
    strs = html_strings(src) if f.endswith('.html') else js_strings(src)
    hits = []
    for line, s in strs:
        s2 = s.strip()
        if not s2 or len(s2) < 4: continue
        # skip things that are plainly not prose: selectors, urls, paths, ids
        if re.fullmatch(r'[\w\-./#:?=&%+ ,\[\]\'"()<>=*;{}]*', s2) and not re.search(r'[a-z]{3,} [a-z]{3,}', s2): continue
        if DASH.search(s2) or len(s2) > int(os.environ.get("MINLEN", "110")):
            hits.append((line, s2))
    if hits:
        print('=' * 12, f, len(hits))
        for line, s in hits:
            print('%5d  %s' % (line, s[:200].replace('\n', '\\n')))
        total += len(hits)
print('TOTAL', total)
