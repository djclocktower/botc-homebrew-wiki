"""
web_render.py — parameterized wrapper around the existing token toolkit.

Per-TOKEN rendering reuses gen/deco/reminder UNCHANGED (pixel-identical to the
desktop sets). The two things that are NEW here, because they don't exist in the
toolkit, are:
  1. margin exposed as a parameter (was a hardcoded constant in build_necro_margin)
  2. the whole sheet-packing / pagination / PDF layer (no sheet code shipped in the zip)

Public API (what the Pyodide bridge will call):
  render_character_token(entry, art_path, char_margin=1.05) -> RGBA Image
  render_reminder_token(art_path, text, rem_margin=1.10)     -> RGBA Image
  build_token_set(data, art_resolver, char_margin, rem_margin) -> (char_imgs, rem_imgs)
  pack_sheets(tokens, kind, opts) -> [RGBA page Images]
  sheets_to_png(pages) / sheets_to_pdf(pages) -> bytes
"""
import io, re, math, json, os
import numpy as np
from PIL import Image
import gen, deco, reminder

MM_PER_IN = 25.4
PAPER = {                       # (width_mm, height_mm), portrait
    'A4':     (210.0, 297.0),
    'Letter': (215.9, 279.4),
}

def slug(n):
    return re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-')

# ----------------------------------------------------------------------------
# PER-TOKEN RENDER  (margin parameterized; everything else is the toolkit verbatim)
# ----------------------------------------------------------------------------
def render_character_token(entry, art_path, char_margin=1.05):
    fn = float(entry.get('firstNight', 0) or 0) > 0
    on = float(entry.get('otherNight', 0) or 0) > 0
    frame = deco.frame_for(first_night=fn, other_night=on,
                           setup=bool(entry.get('setup')),
                           reminders=len(entry.get('reminders', []) or []),
                           name=entry['name'])
    content = Image.new('RGBA', frame.size, (0, 0, 0, 0))
    nl = gen.render_name(entry['name'])
    nm = np.array(nl)[:, :, 3] > 40
    gen.place_art(content, art_path, nm)
    content.alpha_composite(gen.render_ability(entry['ability']))
    content.alpha_composite(nl)
    nw, nh = round(frame.width * char_margin), round(frame.height * char_margin)
    big = frame.resize((nw, nh), Image.LANCZOS)
    big.alpha_composite(content, (round(gen.DCX * (char_margin - 1)),
                                  round(gen.DCY * (char_margin - 1))))
    return big

def render_reminder_token(art_path, text, rem_margin=1.10):
    base = reminder.BLANK
    content = Image.new('RGBA', base.size, (0, 0, 0, 0))
    reminder.place_icon(content, art_path)
    reminder._draw_curved(content, text, reminder.REM_SIZE_MAX)
    nw, nh = round(base.width * rem_margin), round(base.height * rem_margin)
    big = base.resize((nw, nh), Image.LANCZOS)
    big.alpha_composite(content, (round(reminder.DCX * (rem_margin - 1)),
                                  round(reminder.DCY * (rem_margin - 1))))
    return big

# disk diameter (px) inside a freshly-rendered token canvas, used for packing pitch
def _char_disk_px(char_margin):  return 2.0 * gen.R * char_margin
def _rem_disk_px(rem_margin):    return 2.0 * reminder.DR * rem_margin

# ----------------------------------------------------------------------------
# BUILD A WHOLE SET
# ----------------------------------------------------------------------------
def build_token_set(data, art_resolver, char_margin=1.05, rem_margin=1.10,
                    include_global=True):
    """data: list of character dicts. art_resolver(entry)->path or None."""
    chars, rems = [], []
    for e in data:
        if not (isinstance(e, dict) and e.get('name') and e.get('ability')):
            continue
        art = art_resolver(e)
        if not art:
            continue
        chars.append(render_character_token(e, art, char_margin))
        seq = (e.get('reminders', []) or [])
        if include_global:
            seq = seq + (e.get('remindersGlobal', []) or [])
        seen = [r for i, r in enumerate(seq) if r not in seq[:i]]   # per-char de-dupe, keep order
        for r in seen:
            rems.append(render_reminder_token(art, r, rem_margin))
    return chars, rems

# ----------------------------------------------------------------------------
# SHEET PACKING  (NEW — grid + alternating(offset) grid, pagination)
# ----------------------------------------------------------------------------
DEFAULTS = dict(
    paper='A4', dpi=400, layout='grid',
    page_margin_mm=5.0, pad_mm=2.0,
    char_disk_mm=46.0,   # -> 4 across on A4
    rem_disk_mm=30.0,    # -> 6 across on A4
    bg=(255, 255, 255, 255),
)

def _scaled(img, disk_now_px, disk_target_px):
    s = disk_target_px / disk_now_px
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)

def pack_sheets(tokens, kind, opts=None):
    """tokens: list of RGBA Images (already margined). kind: 'char'|'reminder'."""
    o = dict(DEFAULTS); o.update(opts or {})
    pw_mm, ph_mm = PAPER[o['paper']]
    px = lambda mm: mm * o['dpi'] / MM_PER_IN
    PW, PH = round(px(pw_mm)), round(px(ph_mm))
    M = px(o['page_margin_mm']); PAD = px(o['pad_mm'])
    if kind == 'char':
        disk_now = _char_disk_px(o.get('char_margin', 1.05)); disk_mm = o['char_disk_mm']
    else:
        disk_now = _rem_disk_px(o.get('rem_margin', 1.10));   disk_mm = o['rem_disk_mm']
    disk_t = px(disk_mm)
    toks = [_scaled(t, disk_now, disk_t) for t in tokens]

    pitch_x = disk_t + PAD
    usable_w = PW - 2 * M
    cols = max(1, int((usable_w + PAD) // pitch_x))

    alt = (o['layout'] == 'alternating')
    pitch_y = disk_t * (0.87 if alt else 1.0) + PAD

    # rows that fit per page (token canvas can be taller than the disk via leaf overhang;
    # pitch is disk-based so neighbours nestle, matching the felt-backed look)
    usable_h = PH - 2 * M
    rows_per_page = max(1, int((usable_h + PAD) // pitch_y))

    pages = []
    i, n = 0, len(toks)
    while i < n:
        page = Image.new('RGBA', (PW, PH), o['bg'])
        for r in range(rows_per_page):
            if i >= n:
                break
            row_cols = cols
            x_off = 0.0
            if alt and (r % 2 == 1):
                row_cols = cols - 1            # offset row holds one fewer, nestled in the gaps
                x_off = pitch_x / 2.0
            # centre this row horizontally
            row_w = row_cols * disk_t + (row_cols - 1) * PAD
            start_x = M + (usable_w - row_w) / 2.0 + x_off
            cy = M + r * pitch_y + disk_t / 2.0
            for c in range(row_cols):
                if i >= n:
                    break
                t = toks[i]; i += 1
                cx = start_x + c * pitch_x + disk_t / 2.0
                page.alpha_composite(t, (round(cx - t.width / 2.0), round(cy - t.height / 2.0)))
        pages.append(page)
    return pages

def sheets_to_png(pages):
    """Return list of PNG bytes (one per page), with DPI metadata."""
    out = []
    for p in pages:
        b = io.BytesIO()
        p.convert('RGBA').save(b, 'PNG')
        out.append(b.getvalue())
    return out

def sheets_to_pdf(pages, dpi=400):
    """Single multi-page PDF (RGB, white-flattened) at the given DPI."""
    flat = []
    for p in pages:
        bg = Image.new('RGB', p.size, (255, 255, 255))
        bg.paste(p.convert('RGBA'), (0, 0), p.convert('RGBA'))
        flat.append(bg)
    b = io.BytesIO()
    flat[0].save(b, 'PDF', resolution=dpi, save_all=True, append_images=flat[1:])
    return b.getvalue()

# ----------------------------------------------------------------------------
# WEB ENTRY POINTS  (called from JS via Pyodide; art written to FS by the bridge)
# ----------------------------------------------------------------------------
import base64 as _b64

def _build(characters, o):
    cm = float(o.get('char_margin', 1.05)); rm = float(o.get('rem_margin', 1.10))
    inc = bool(o.get('include_global', True))
    chars, rems = [], []
    for e in characters:
        if not (isinstance(e, dict) and e.get('name') and e.get('ability')):
            continue
        art = e.get('_art')
        if not art or not os.path.exists(art):
            continue
        chars.append(render_character_token(e, art, cm))
        seq = list(e.get('reminders', []) or [])
        if inc:
            seq += list(e.get('remindersGlobal', []) or [])
        seen = [r for i, r in enumerate(seq) if r not in seq[:i]]
        for r in seen:
            rems.append(render_reminder_token(art, r, rm))
    return chars, rems

def web_preview(entry_json, opts_json):
    e = json.loads(entry_json); o = json.loads(opts_json)
    art = e.get('_art')
    if not art or not os.path.exists(art):
        return json.dumps({'error': 'art-missing'})
    img = render_character_token(e, art, float(o.get('char_margin', 1.05)))
    sc = float(o.get('preview_scale', 0.42))
    img = img.resize((max(1, round(img.width*sc)), max(1, round(img.height*sc))), Image.LANCZOS)
    b = io.BytesIO(); img.convert('RGBA').save(b, 'PNG')
    return json.dumps({'png': _b64.b64encode(b.getvalue()).decode()})

def web_sheets(chars_json, opts_json):
    characters = json.loads(chars_json); o = json.loads(opts_json)
    chars, rems = _build(characters, o)
    fmt = o.get('format', 'png'); dpi = int(o.get('dpi', 400))
    cpages = pack_sheets(chars, 'char', o) if (o.get('want_char', True) and chars) else []
    rpages = pack_sheets(rems, 'reminder', o) if (o.get('want_rem', True) and rems) else []
    files = []
    def add(name, mime, data): files.append({'name': name, 'mime': mime, 'b64': _b64.b64encode(data).decode()})
    if fmt == 'pdf':
        if cpages: add('character_tokens.pdf', 'application/pdf', sheets_to_pdf(cpages, dpi))
        if rpages: add('reminder_tokens.pdf', 'application/pdf', sheets_to_pdf(rpages, dpi))
    else:
        for i, p in enumerate(cpages):
            b = io.BytesIO(); p.convert('RGBA').save(b, 'PNG'); add(f'character_tokens_{i+1}.png', 'image/png', b.getvalue())
        for i, p in enumerate(rpages):
            b = io.BytesIO(); p.convert('RGBA').save(b, 'PNG'); add(f'reminder_tokens_{i+1}.png', 'image/png', b.getvalue())
    return json.dumps({'files': files, 'counts': {'char': len(chars), 'rem': len(rems),
                       'char_pages': len(cpages), 'rem_pages': len(rpages)}})
