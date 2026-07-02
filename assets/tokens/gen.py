import json, math
import numpy as _np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FRAME = Image.open('frame_bare.png').convert('RGBA')
W, H = FRAME.size

# ---- true token disk geometry (measured from frame alpha) ----
DCX, DCY, R = 467, 464, 437

DUM = 'fonts/dumbledor2.ttf'
TG  = 'fonts/trade-gothic-lt-std.otf'
FILL = (12, 13, 7, 255)

# ability band
ABIL_TOP, ABIL_BOT = 142, 336
ABIL_PAD = 40                        # horizontal padding from the rim
ABIL_SIZE = 47                       # bumped to match almanac reference
# art
ART_CX, ART_CY = DCX, 545
ART_AREA = 150000     # target visual area (px^2)
ART_W_MAX, ART_H_MAX = 472, 410   # caps so wide/tall art can't overflow or crowd
# name arc (derived to match CLOAK placement): baseline circle r=668, centre above
NAME_ARC_CX = DCX
NAME_R_MAX, NAME_R_MIN = 582, 432     # short names flat, long names curve more
NAME_ADV_LO, NAME_ADV_HI = 320, 540  # advance range over which R interpolates
NAME_BOTTOM_Y = 840                  # fixed bottom-centre of the name
NAME_SIZE_MAX = 97
NAME_SPAN_MAX = math.radians(98)     # allow more sweep for long names
NAME_TRACK = 0.03                    # near-original tracking

def autocrop(im):
    bb = im.split()[-1].getbbox()
    return im.crop(bb) if bb else im

def chord_halfwidth(y):
    dy = abs(DCY - y)
    return math.sqrt(max(0.0, R*R - dy*dy))

# ---------- ABILITY (centered, inside circle, wrap to chord) ----------
def wrap(draw, text, font, maxw):
    out, cur = [], ''
    for w in text.split():
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=font) <= maxw or not cur:
            cur = t
        else:
            out.append(cur); cur = w
    if cur: out.append(cur)
    return out

def render_ability(text, size_mul=1.0, dy=0):
    img = Image.new('RGBA', (W, H), (0,0,0,0))
    d = ImageDraw.Draw(img)
    words = text.split()
    top, bot = ABIL_TOP + int(dy), ABIL_BOT + int(dy)
    start = max(12, int(round(ABIL_SIZE * size_mul)))
    stop = min(start - 1, max(8, int(round(37 * size_mul))))
    for size in range(start, stop, -1):
        f = ImageFont.truetype(TG, size)
        lh = int(size * 1.12)
        # circle-aware wrap: each line limited by the chord at its own height, minus padding
        lines, i, y = [], 0, top
        while i < len(words):
            avail = chord_halfwidth(y)*2 - 2*ABIL_PAD
            line, j = words[i], i+1
            while j < len(words):
                t = line + ' ' + words[j]
                if d.textlength(t, font=f) <= avail:
                    line = t; j += 1
                else:
                    break
            lines.append(line); i = j; y += lh
        total = len(lines)*lh
        if total <= (bot - top):
            break
    # centre the block in the band so it sits lower (moved down) yet clears the art
    y = top + max(0, (bot - top - total)//2)
    for ln in lines:
        lw = d.textlength(ln, font=f)
        d.text((DCX - lw/2, y), ln, font=f, fill=FILL)
        y += lh
    return img

# ---------- NAME (arced, per-glyph, embossed) ----------
def glyph_tile(ch, f, asc, desc, pad=12):
    adv = f.getlength(ch)
    tw = max(1, int(math.ceil(adv)) + 2*pad)
    th = asc + desc + 2*pad
    x, yb = pad, pad
    # soft drop shadow for gentle lift off the parchment
    sh = Image.new('RGBA', (tw, th), (0,0,0,0))
    ImageDraw.Draw(sh).text((x+1, yb+2), ch, font=f, fill=(0,0,0,150))
    sh = sh.filter(ImageFilter.GaussianBlur(1.6))
    tile = sh
    g = ImageDraw.Draw(tile)
    # whisper of a top-left highlight (peeks out from under the fill)
    g.text((x-1, yb-1), ch, font=f, fill=(248,242,226,70))
    # solid, clean fill
    g.text((x, yb), ch, font=f, fill=FILL)
    anchor = (pad + adv/2.0, pad + asc)
    return tile, anchor, adv

def _name_radius(total_adv):
    if total_adv <= NAME_ADV_LO: return NAME_R_MAX
    if total_adv >= NAME_ADV_HI: return NAME_R_MIN
    t = (total_adv - NAME_ADV_LO) / float(NAME_ADV_HI - NAME_ADV_LO)
    return NAME_R_MAX + t*(NAME_R_MIN - NAME_R_MAX)

# ── optical kerning: only nudges outlier pairs, leaves typical pairs untouched ──
KERN_LOOSE_THRESH = 16.0   # closest-approach above this = too loose -> pull in
KERN_K_LOOSE      = 1.0
KERN_TIGHT_MEAN   = 11.0   # mean gap below this = uniformly cramped -> push apart
KERN_K_TIGHT      = 1.6
KERN_CLAMP        = (-30.0, 8.0)
_prof_cache = {}
def _glyph_profiles(f, ch, size, pad=6):
    key = (ch, size)
    if key in _prof_cache: return _prof_cache[key]
    w = int(f.getlength(ch)) + 2*pad; h = int(size*2.2)
    im = Image.new('L', (w, h), 0); ImageDraw.Draw(im).text((pad, pad), ch, font=f, fill=255)
    a = _np.array(im) > 60
    L = _np.full(h, _np.nan); R = _np.full(h, _np.nan)
    for y in range(h):
        xs = _np.where(a[y])[0]
        if len(xs): L[y] = xs[0]-pad; R[y] = xs[-1]-pad
    _prof_cache[key] = (L, R)
    return L, R
def _pair_kern(f, c0, c1, size, track):
    if c0 == ' ' or c1 == ' ': return 0.0
    L0, R0 = _glyph_profiles(f, c0, size); L1, R1 = _glyph_profiles(f, c1, size)
    s = f.getlength(c0) + track
    gaps = [(s + L1[y]) - R0[y] for y in range(len(R0))
            if not _np.isnan(R0[y]) and not _np.isnan(L1[y])]
    if not gaps: return 0.0
    mn = min(gaps); mean = sum(gaps)/len(gaps)
    corr = (-KERN_K_LOOSE * max(0.0, mn - KERN_LOOSE_THRESH)
            + KERN_K_TIGHT * max(0.0, KERN_TIGHT_MEAN - mean))
    return max(KERN_CLAMP[0], min(KERN_CLAMP[1], corr))

def render_name(name, size_mul=1.0, dy=0):
    name = name.upper()
    start = max(24, int(round(NAME_SIZE_MAX * size_mul)))
    stop = min(start - 1, max(20, int(round(58 * size_mul))))
    bottom_y = NAME_BOTTOM_Y + int(dy)
    for size in range(start, stop, -1):
        f = ImageFont.truetype(DUM, size)
        track = NAME_TRACK * size
        advs = [f.getlength(c) + track for c in name]
        total_adv = sum(advs)
        R = _name_radius(total_adv)        # curvature uses uncorrected width (unchanged)
        if total_adv / R <= NAME_SPAN_MAX:
            break
    asc, desc = f.getmetrics()
    # per-pair optical corrections inserted between glyphs (0 for typical pairs)
    corrs = [_pair_kern(f, name[i], name[i+1], size, track) for i in range(len(name)-1)]
    # advance-centred placement (identical to before when all corrs==0)
    starts = [0.0]; 
    for i in range(len(name)-1):
        starts.append(starts[-1] + advs[i] + corrs[i])
    centers = [starts[i] + advs[i]/2.0 for i in range(len(name))]
    total = starts[-1] + advs[-1]
    mid = total/2.0
    arc_cy = bottom_y - R                  # keep bottom-centre fixed at bottom_y
    canvas = Image.new('RGBA', (W, H), (0,0,0,0))
    for ch, c in zip(name, centers):
        ang = math.pi/2 - (c - mid)/R
        if ch == ' ':
            continue
        Px = NAME_ARC_CX + R*math.cos(ang)
        Py = arc_cy + R*math.sin(ang)
        tile, anchor, _ = glyph_tile(ch, f, asc, desc)
        ax, ay = anchor
        D = int(2*max(ax, ay, tile.width-ax, tile.height-ay)) + 6
        sq = Image.new('RGBA', (D, D), (0,0,0,0))
        sq.alpha_composite(tile, (int(D/2-ax), int(D/2-ay)))
        rot_deg = 90 - math.degrees(ang)
        sq = sq.rotate(rot_deg, resample=Image.BICUBIC, center=(D/2, D/2))
        canvas.alpha_composite(sq, (int(Px - D/2), int(Py - D/2)))
    return canvas

ART_NAME_MARGIN = 4    # desired clear gap between icon bottom and name top
ART_MIN_TOP     = 340  # never let an icon rise into the ability-text band

def place_art(canvas, art_path, name_mask=None, dx=0, dy=0, scale=1.0):
    art = autocrop(Image.open(art_path).convert('RGBA'))
    w, h = art.size
    import math as _m
    s = _m.sqrt(ART_AREA / float(w*h))   # equal visual area for every icon
    if h*s > ART_H_MAX: s = ART_H_MAX/float(h)
    if w*s > ART_W_MAX: s = ART_W_MAX/float(w)
    s *= float(scale)                    # user scale applied on top of the caps
    art = art.resize((max(1,int(w*s)), max(1,int(h*s))), Image.LANCZOS)
    left = ART_CX - art.width//2 + int(dx)
    top  = ART_CY - art.height//2 + int(dy)
    manual = (int(dx) != 0 or int(dy) != 0 or float(scale) != 1.0)
    if name_mask is not None and not manual:            # nudge up only if it overlaps the name
        am = _np.array(art)[:,:,3] > 40
        shift = 0
        for cx in range(am.shape[1]):
            col = _np.where(am[:, cx])[0]
            if not len(col): continue
            gx = left + cx
            if 0 <= gx < name_mask.shape[1]:
                ncol = _np.where(name_mask[:, gx])[0]
                if len(ncol):
                    ov = (top + col.max()) - (ncol.min() - ART_NAME_MARGIN)
                    if ov > shift: shift = ov
        if shift > 0:
            top = max(ART_MIN_TOP, top - int(shift))
    canvas.alpha_composite(art, (left, top))

def make(name, ability, art_path, out):
    c = FRAME.copy()
    name_layer = render_name(name)
    name_mask = _np.array(name_layer)[:, :, 3] > 40
    place_art(c, art_path, name_mask)
    c.alpha_composite(render_ability(ability))
    c.alpha_composite(name_layer)
    c.save(out); print("saved", out)

if __name__ == '__main__':
    import os; os.makedirs('tokens', exist_ok=True)
    data = {e['name']: e for e in json.load(open('/mnt/user-data/uploads/Necrovitality__1_.json')) if isinstance(e,dict) and e.get('name')}
    for nm in ['Locksmith','Chupacabra']:
        e = data[nm]; make(nm, e['ability'], f'art/{nm.lower()}.png', f'tokens/token_{nm.lower()}.png')
