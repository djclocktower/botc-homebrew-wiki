# The dark theme's parchment: the same sheet as assets/parchment.webp, its
# mottling and stains kept, recoloured from cream to deep purple.
#   python3 migration/make-night-parchment.py
# The files are cached for a year, so a changed picture takes a new name
# (bump V here and in --tex-parch in styles.css).
import sys
import numpy as np
from PIL import Image

V = 'v1'
src = Image.open('assets/parchment.jpg').convert('RGB').resize((1000, 1333), Image.LANCZOS)
a = np.asarray(src).astype(np.float32) / 255.0
lum = a @ np.array([.2126, .7152, .0722], dtype=np.float32)
# How far each pixel sits from the sheet's own middle tone, in its own spread:
# the texture, with the cream taken out.
mid, spread = np.median(lum), lum.std()
t = np.clip((lum - mid) / (spread * 3.2), -1, 1)          # -1 stains .. +1 highlights

# Two purples to run between: the stains fall towards a blue-black violet,
# the highlights lift to a warmer plum. Flat colour would lose the paper.
low = np.array([0x22, 0x10, 0x2b], dtype=np.float32) / 255
base = np.array([0x33, 0x1b, 0x3c], dtype=np.float32) / 255
high = np.array([0x45, 0x26, 0x4c], dtype=np.float32) / 255
up = np.clip(t, 0, 1)[..., None]; down = np.clip(-t, 0, 1)[..., None]
out = base + (high - base) * up + (low - base) * down
img = Image.fromarray((np.clip(out, 0, 1) * 255).round().astype(np.uint8))
img.save('assets/parchment-night-%s.webp' % V, quality=82, method=6)
print('assets/parchment-night-%s.webp' % V)
