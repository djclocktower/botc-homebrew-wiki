"""Generate the Token Tool's reminder-leaf art for 7 to 12 reminders.

The official app ships leaf art for at most six reminders
(assets/tokens/botc_app/.../leaf-top6-*.png). A character with more reminders
needs as many leaves, so this script continues the official arc: it keeps the
six official leaves exactly where they are and adds copies of them, rotated
about the token's own centre, at the same spacing, alternating left then
right (the order the official 3 -> 5 -> 6 art grows in).

Geometry, in the 539 px asset's coordinates: deco.py scales the asset to the
token width (905/539) and places it with its content centred on the disk
centre (467) and its top at TOP_ANCHOR (-24). So the token's disk centre sits
at (267, 290.6) here, and the official leaves' centroids all lie ~252 px from
that point: they hang from the rim, and so do the new ones.

    python3 migration/make-leaf-tops.py      (from the repo root)

writes assets/tokens/leaf_gen/leaf-top{7..12}.png. Re-run it only if the
official art changes; bump assets/tokens/manifest.json's "v" afterwards.
"""
import glob, math, os
from collections import deque
import numpy as np
from PIL import Image

HERE = os.path.join(os.path.dirname(__file__), '..', 'assets', 'tokens')
SRC = glob.glob(os.path.join(HERE, 'botc_app/botc.app/assets/leaf-top6-*.png'))[0]
OUT = os.path.join(HERE, 'leaf_gen')
PIVOT = (267.0, 290.6)


def components(a):
    """Each separate leaf as (mask, angle-from-pivot in degrees, + = right)."""
    m = a[:, :, 3] > 8
    lab = np.zeros(m.shape, int)
    found = []
    n = 0
    for y, x in zip(*np.nonzero(m)):
        if lab[y, x]:
            continue
        n += 1
        q = deque([(y, x)])
        lab[y, x] = n
        pts = []
        while q:
            cy, cx = q.popleft()
            pts.append((cy, cx))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    yy, xx = cy + dy, cx + dx
                    if 0 <= yy < m.shape[0] and 0 <= xx < m.shape[1] and m[yy, xx] and not lab[yy, xx]:
                        lab[yy, xx] = n
                        q.append((yy, xx))
        if len(pts) < 30:
            continue
        ys, xs = np.array(pts).T
        ang = math.degrees(math.atan2(xs.mean() - PIVOT[0], PIVOT[1] - ys.mean()))
        found.append((lab == n, ang))
    return found


def main():
    base = Image.open(SRC).convert('RGBA')
    a = np.array(base)
    leaves = sorted(components(a), key=lambda c: c[1])        # left to right
    angles = [ang for _, ang in leaves]
    step = (angles[-1] - angles[0]) / (len(angles) - 1)

    def sprite(mask):
        s = a.copy()
        s[:, :, 3] = np.where(mask, s[:, :, 3], 0)
        return Image.fromarray(s)

    # The two outermost leaves on each side are the sources, used in turn, so
    # neighbouring new leaves are not the same picture twice.
    left_src = [leaves[0], leaves[1]]
    right_src = [leaves[-1], leaves[-2]]
    os.makedirs(OUT, exist_ok=True)
    canvas = base.copy()
    lo, hi = angles[0], angles[-1]
    added_l = added_r = 0
    for n in range(7, 13):
        if n % 2:      # 7, 9, 11: one more on the left
            lo -= step
            mask, ang = left_src[added_l % 2]
            added_l += 1
            target = lo
        else:          # 8, 10, 12: one more on the right
            hi += step
            mask, ang = right_src[added_r % 2]
            added_r += 1
            target = hi
        # PIL rotates counter-clockwise; a positive (rightward) move is clockwise.
        moved = sprite(mask).rotate(-(target - ang), resample=Image.BICUBIC, center=PIVOT)
        canvas = Image.alpha_composite(canvas, moved)
        canvas.save(os.path.join(OUT, 'leaf-top%d.png' % n), optimize=True)
        print('leaf-top%d.png' % n, 'span %.1f..%.1f deg' % (lo, hi))


if __name__ == '__main__':
    main()
