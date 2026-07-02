import math
from PIL import Image

BARE = Image.open('frame_bare.png').convert('RGBA')
import glob as _g
L_FIRST = Image.open(_g.glob('botc_app/botc.app/assets/firstnight-*.png')[0]).convert('RGBA').transpose(Image.FLIP_LEFT_RIGHT)  # left -> first night (flipped)
L_OTHER = Image.open(_g.glob('botc_app/botc.app/assets/othernight-*.png')[0]).convert('RGBA')  # right -> other nights
FLOWER  = Image.open('raw_Layer_2.png').convert('RGBA')   # setup
LEAF    = Image.open('leaf_left.png').convert('RGBA')      # reminder unit (broad)

POS_FIRST = (-14, 464)
POS_OTHER = (829, 440)
POS_FLOWER= (730, 538)   # original position; clipped to the disk in _place_flower

import glob as _glob
_TOKEN_W = BARE.width
REAL_TOP = {}
for _n in (1,2,3,4,5,6,7):
    _g=_glob.glob(f'botc_app/botc.app/assets/leaf-top{_n}-*.png')
    if _g:
        _im=Image.open(_g[0]).convert('RGBA')
        _sc=_TOKEN_W/_im.width
        REAL_TOP[_n]=_im.resize((int(_im.width*_sc), int(_im.height*_sc)), Image.LANCZOS)


import numpy as _np
S_NEW = 1.24                 # height-matched to official leaf size
AX_NEW, AY_NEW = 460.0, 2.0
NEW_TOP = {}
for _n in (1,2,4,7):
    import os as _os
    _p=f'leaf_new/{_n}leaf.png'
    if _os.path.exists(_p): NEW_TOP[_n]=Image.open(_p).convert('RGBA')
def _content_anchor(im):
    a=_np.array(im)[:,:,3]; ys,xs=_np.where(a>20); return ((xs.min()+xs.max())/2.0, ys.min())
def _place_tight(canvas, im):
    big=im.resize((int(im.width*S_NEW), int(im.height*S_NEW)), Image.LANCZOS)
    cx,ty=_content_anchor(big); ox,oy=int(round(AX_NEW-cx)), int(round(AY_NEW-ty))
    x0,y0=max(0,ox),max(0,oy); sub=big.crop((x0-ox,y0-oy,big.width,big.height)); canvas.alpha_composite(sub,(x0,y0))


import numpy as _np
_DCX, _DCY, _R = 467, 464, 437
_DISK = (_np.array(BARE)[:,:,3] > 0)            # token shape, for clipping
TOP_ANCHOR = -24                                # lifted slightly off the ability text

def _place_top(canvas, asset, scale, dy=0):
    big = asset.resize((int(asset.width*scale), int(asset.height*scale)), Image.LANCZOS)
    a = _np.array(big)[:,:,3] > 20
    ys, xs = _np.where(a)
    if len(xs)==0: return
    cx = (xs.min()+xs.max())/2.0
    ox = int(round(_DCX - cx))                  # centre on disk centre
    oy = int(round(TOP_ANCHOR + int(dy) - ys.min()))   # keep leaves high (dy = user offset)
    # render onto a transparent layer at full canvas size
    layer = Image.new('RGBA', (BARE.width, BARE.height), (0,0,0,0))
    x0, y0 = max(0,ox), max(0,oy)
    sub = big.crop((x0-ox, y0-oy, big.width, big.height))
    layer.alpha_composite(sub, (x0, y0))
    # clip to the token disk: cut anything outside the edge (i.e. the bits poking past the top)
    la = _np.array(layer)
    la[:,:,3] = _np.where(_DISK, la[:,:,3], 0)
    canvas.alpha_composite(Image.fromarray(la))

PIVOT = (467, 2)
SPREAD = 42.0

def paste_at(canvas, img, left, top):
    x0, y0 = max(0,left), max(0,top)
    sub = img.crop((x0-left, y0-top, img.width, img.height))
    canvas.alpha_composite(sub, (x0, y0))

def _flower_layer(left, top, scale=1.0):
    """A full-canvas layer with the flower at (left, top), clipped to the disk."""
    import numpy as _np
    fl = FLOWER
    if float(scale) != 1.0:
        fl = FLOWER.resize((max(1, int(FLOWER.width*scale)), max(1, int(FLOWER.height*scale))), Image.LANCZOS)
    layer = Image.new('RGBA', (BARE.width, BARE.height), (0,0,0,0))
    x0, y0 = max(0, left), max(0, top)
    sub = fl.crop((x0-left, y0-top, fl.width, fl.height))
    layer.alpha_composite(sub, (x0, y0))
    la = _np.array(layer)
    la[:,:,3] = _np.where(_DISK, la[:,:,3], 0)     # cut anything outside the disk
    return Image.fromarray(la)

# when the flower must dodge a long name: lift just enough to clear it, then push a
# moderate amount toward the right edge so it bleeds off the token (default stays put)
FLOWER_DODGE_MAX   = 200    # max vertical travel (px)
FLOWER_GAP         = 12     # clearance above the name once lifted
FLOWER_DODGE_RIGHT = 26     # rightward push when dodging (smaller than before)

def _flower_pos_for(name_mask):
    """Default position untouched; if a long name overlaps, lift to clear then bleed right."""
    import numpy as _np
    bx, by = POS_FLOWER
    if name_mask is None:
        return bx, by
    base = _np.array(_flower_layer(bx, by))[:,:,3] > 30
    if not (base & name_mask).any():
        return bx, by                               # no overlap -> leave it EXACTLY put
    kc = FLOWER_DODGE_MAX
    for k in range(0, FLOWER_DODGE_MAX+1, 5):       # minimal lift to clear the name
        fa = _np.array(_flower_layer(bx, by - k))[:,:,3] > 30
        if not (fa & name_mask).any():
            kc = k; break
    return bx + FLOWER_DODGE_RIGHT, by - (kc + FLOWER_GAP)

def _place_flower(canvas, name_mask=None, dx=0, dy=0, scale=1.0):
    if int(dx) != 0 or int(dy) != 0 or float(scale) != 1.0:
        left, top = POS_FLOWER[0] + int(dx), POS_FLOWER[1] + int(dy)   # manual: no auto-dodge
    else:
        left, top = _flower_pos_for(name_mask)
    canvas.alpha_composite(_flower_layer(left, top, scale))

S_NIGHT = 0.95
FN_CENTER = (78, 470)      # first-night sprig (left)
ON_CENTER = (845, 430)     # other-night leaves (right)
def _place_night(canvas, asset, center):
    import numpy as _np
    big = asset.resize((int(asset.width*S_NIGHT), int(asset.height*S_NIGHT)), Image.LANCZOS)
    ox = int(round(center[0]-big.width/2)); oy = int(round(center[1]-big.height/2))
    layer = Image.new('RGBA', (canvas.width, canvas.height), (0,0,0,0))
    x0,y0=max(0,ox),max(0,oy); sub=big.crop((x0-ox,y0-oy,big.width,big.height)); layer.alpha_composite(sub,(x0,y0))
    la=_np.array(layer); import deco as _self
    la[:,:,3]=_np.where(_DISK, la[:,:,3], 0)
    canvas.alpha_composite(Image.fromarray(la))

def _leaf(canvas, angle_deg):
    sx, sy = LEAF.width/2, 2
    D = int(2*max(LEAF.width, LEAF.height)) + 8
    sq = Image.new('RGBA',(D,D),(0,0,0,0))
    sq.alpha_composite(LEAF, (int(D/2-sx), int(D/2-sy)))
    sq = sq.rotate(-angle_deg, resample=Image.BICUBIC, center=(D/2,D/2))
    canvas.alpha_composite(sq, (int(PIVOT[0]-D/2), int(PIVOT[1]-D/2)))

def _reminders(canvas, n, scale_mul=1.0, dy=0):
    if n <= 0: return
    if n in REAL_TOP:                      # official asset
        _place_top(canvas, REAL_TOP[n], 1.0*float(scale_mul), dy); return
    if n in NEW_TOP:                       # user-provided leaf (matched scale)
        _place_top(canvas, NEW_TOP[n], S_NEW*float(scale_mul), dy); return
    # last-resort fan (no asset for this count)
    if n == 1: angles=[0]
    else: angles=[(-SPREAD + 2*SPREAD*i/(n-1)) for i in range(n)]
    for a in angles: _leaf(canvas, a)

def frame_for(first_night=False, other_night=False, setup=False, reminders=0, name=None,
              adj=None, name_mask=None):
    a = adj or {}
    f = BARE.copy()
    if first_night: _place_night(f, L_FIRST, FN_CENTER)
    if other_night: _place_night(f, L_OTHER, ON_CENTER)
    flower_mode = a.get('flower', 'auto')            # 'auto' | 'on' | 'off'
    show_flower = setup if flower_mode == 'auto' else (flower_mode == 'on')
    if show_flower:
        nm = name_mask
        if nm is None and name:
            import numpy as _np, gen          # lazy import avoids a circular dependency
            nm = _np.array(gen.render_name(name))[:, :, 3] > 40
        _place_flower(f, nm,
                      a.get('flower_dx', 0) or 0,
                      a.get('flower_dy', 0) or 0,
                      a.get('flower_scale', 1.0) or 1.0)
    n = 0 if a.get('leaves', 'auto') == 'off' else reminders
    _reminders(f, n, a.get('leaf_scale', 1.0) or 1.0, a.get('leaf_dy', 0) or 0)
    return f
