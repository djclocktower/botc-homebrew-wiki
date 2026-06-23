import math
import numpy as _np
from PIL import Image, ImageDraw, ImageFont

BLANK = Image.open('reminder_blank.png').convert('RGBA')
RW, RH = BLANK.size
# derive disk geometry from the base art
_ba = _np.array(BLANK)[:, :, 3] > 40
_ys, _xs = _np.where(_ba)
DCX, DCY = float((_xs.min()+_xs.max())/2), float((_ys.min()+_ys.max())/2)
DR = float((_xs.max()-_xs.min())/2)

FONT = 'fonts/OpenSans-SemiBold.ttf'    # reminder font = Open Sans
CREAM = (238, 235, 218, 255)
OUTLINE = (40, 20, 42, 235)
STROKE = 6

# icon — sized to fill the token like the official reminders
REM_ICON_CY  = DCY - 0.17*DR             # raised so tall icons clear the caption
REM_ART_AREA = 278000                    # target visual area (~+10%)
REM_ART_W_MAX, REM_ART_H_MAX = 1.06*DR, 1.0*DR    # relaxed caps so tall/narrow art fills too
# text — arc is CONCENTRIC with the disk so every reminder keeps a uniform margin
REM_SIZE_MAX     = 138                    # big, bold caption (~+8%)
REM_TEXT_R       = DR - 104              # pulled in so long text can curve round the side
REM_ARC_SPAN_MAX = math.radians(156)     # long text wraps around the rim instead of shrinking
REM_TRACK        = 0.055                  # letter-spacing (fraction of font size) — stops overlap

def autocrop(im):
    bb = im.split()[-1].getbbox()
    return im.crop(bb) if bb else im

def place_icon(canvas, art_path):
    art = autocrop(Image.open(art_path).convert('RGBA'))
    w, h = art.size
    s = math.sqrt(REM_ART_AREA / float(w*h))
    if h*s > REM_ART_H_MAX: s = REM_ART_H_MAX/float(h)
    if w*s > REM_ART_W_MAX: s = REM_ART_W_MAX/float(w)
    art = art.resize((max(1,int(w*s)), max(1,int(h*s))), Image.LANCZOS)
    canvas.alpha_composite(art, (int(DCX - art.width/2), int(REM_ICON_CY - art.height/2)))

def _glyph_cream(ch, f, asc, desc, pad=STROKE+4):
    adv = f.getlength(ch)
    tw = max(1, int(math.ceil(adv)) + 2*pad); th = asc + desc + 2*pad
    tile = Image.new('RGBA', (tw, th), (0,0,0,0))
    ImageDraw.Draw(tile).text((pad, pad), ch, font=f, fill=CREAM,
                              stroke_width=STROKE, stroke_fill=OUTLINE)
    return tile, (pad + adv/2.0, pad + asc), adv

def _draw_curved(canvas, text, size):
    R = REM_TEXT_R
    for sz in range(size, 40, -2):
        f = ImageFont.truetype(FONT, sz)
        track = REM_TRACK * sz
        advs = [f.getlength(c) + track for c in text]   # advance + letter-spacing
        total = sum(advs)
        if total / R <= REM_ARC_SPAN_MAX:
            break
    asc, desc = f.getmetrics()
    span = total / R
    arc_cy = DCY                              # concentric with the disk
    cum = 0.0
    for ch, adv in zip(text, advs):
        ang = (math.pi/2 + span/2) - (cum + adv/2.0)/R
        cum += adv
        if ch == ' ': continue
        Px = DCX + R*math.cos(ang); Py = arc_cy + R*math.sin(ang)
        tile, (ax, ay), _ = _glyph_cream(ch, f, asc, desc)
        D = int(2*max(ax, ay, tile.width-ax, tile.height-ay)) + 6
        sq = Image.new('RGBA', (D, D), (0,0,0,0))
        sq.alpha_composite(tile, (int(D/2-ax), int(D/2-ay)))
        sq = sq.rotate(90 - math.degrees(ang), resample=Image.BICUBIC, center=(D/2, D/2))
        canvas.alpha_composite(sq, (int(Px - D/2), int(Py - D/2)))

def remmake(art_path, text, out):
    c = BLANK.copy()
    place_icon(c, art_path)
    _draw_curved(c, text, REM_SIZE_MAX)
    c.save(out); return out
