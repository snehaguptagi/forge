"""Generate Forge PNG icons (16/32/48/128): a bold white "F" monogram with a
spark accent on a diagonal ember-gradient tile. Run: python3 make_icons.py"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)

# diagonal ember gradient: gold -> orange -> crimson-rose
STOPS = [(0.0, (255, 194, 74)), (0.5, (255, 111, 60)), (1.0, (244, 67, 110))]
MARK = (255, 255, 255)
SS = 8  # supersample

# bold "F" monogram as three bars (x0,y0,x1,y1 in unit coords, y down)
F_BARS = [
    (0.31, 0.22, 0.45, 0.80),   # stem
    (0.31, 0.22, 0.73, 0.365),  # top arm
    (0.31, 0.445, 0.65, 0.575), # middle arm
]


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def grad_color(t):
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]; t1, c1 = STOPS[i + 1]
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return STOPS[-1][1]


def diagonal_gradient(size):
    img = Image.new("RGB", (size, size)); px = img.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = grad_color((x + y) / (2 * (size - 1)))
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make(size):
    big = size * SS
    base = diagonal_gradient(big).convert("RGBA")

    glyph = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glyph)
    r = big * 0.03
    for (x0, y0, x1, y1) in F_BARS:
        gd.rounded_rectangle([x0 * big, y0 * big, x1 * big, y1 * big], radius=r, fill=MARK)
    cx, cy, R, ir = big * 0.785, big * 0.30, big * 0.085, big * 0.022
    gd.polygon([(cx, cy - R), (cx + ir, cy - ir), (cx + R, cy), (cx + ir, cy + ir),
                (cx, cy + R), (cx - ir, cy + ir), (cx - R, cy), (cx - ir, cy - ir)], fill=MARK)
    base.alpha_composite(glyph)

    base.putalpha(rounded_mask(big, int(big * 0.24)))
    return base.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    make(s).save(os.path.join(OUT, f"icon{s}.png"))
    print(f"wrote icons/icon{s}.png")
