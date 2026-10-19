#!/usr/bin/env python3
"""Download the SCP Fragmented Veil art into the repo. Run from the repo root:

    python3 migration/scp-fragmented-veil/fetch-art.py
    npm i --no-save sharp && node migration/optimize-images.js thumbs

art.json (written by build.mjs) lists every file. Character icons are put on
the wiki's standard frame exactly as assets/art-normalize.js does it in the
editors and importers: transparent margin trimmed (alpha > 16), the figure's
longest side scaled to 60% of a 591x591 transparent square, centred. The logo
and the background are stored as they are.

The Worker serves /assets/ from R2 first and the committed file second, so
these need no upload: they go live with the deploy. It never overwrites a
committed file (art/ is a shared namespace; a clash must be loud).
"""
import io
import json
import os
import sys
import urllib.request

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
TARGET, FILL, ALPHA = 591, 0.60, 16


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'botchomebrew.wiki import'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def standardize(raw):
    im = Image.open(io.BytesIO(raw)).convert('RGBA')
    box = im.getchannel('A').point(lambda a: 255 if a > ALPHA else 0).getbbox() or (0, 0, im.width, im.height)
    fig = im.crop(box)
    scale = FILL * TARGET / max(fig.width, fig.height)
    dw, dh = round(fig.width * scale), round(fig.height * scale)
    out = Image.new('RGBA', (TARGET, TARGET), (0, 0, 0, 0))
    out.paste(fig.resize((dw, dh), Image.LANCZOS), (round((TARGET - dw) / 2), round((TARGET - dh) / 2)))
    buf = io.BytesIO()
    out.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def main():
    jobs = json.load(open(os.path.join(HERE, 'art.json')))
    failed = []
    for job in jobs:
        dest = os.path.join(ROOT, job['dest'])
        if os.path.exists(dest):
            print('exists, left alone:', job['dest'])
            continue
        try:
            raw = fetch(job['url'])
            if job['dest'].startswith('assets/art/'):
                data = standardize(raw)
            else:
                fmt = Image.open(io.BytesIO(raw)).format
                want = {'.png': 'PNG', '.jpg': 'JPEG'}[os.path.splitext(dest)[1]]
                if fmt != want:
                    buf = io.BytesIO()
                    Image.open(io.BytesIO(raw)).convert('RGB' if want == 'JPEG' else 'RGBA').save(buf, want)
                    raw = buf.getvalue()
                data = raw
            with open(dest, 'wb') as f:
                f.write(data)
        except Exception as e:  # report every failure, then fail the run
            failed.append((job['url'], str(e)))
    for url, err in failed:
        print('FAILED', url, err)
    print(len(jobs) - len(failed), 'of', len(jobs), 'written')
    sys.exit(1 if failed else 0)


main()
