"""Generate Forge PNG icons (16/32/48/128): a white spark on a diagonal
violet→indigo→pink gradient tile. Run: python3 make_icons.py"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)

# gradient stops (diagonal): amber → orange → rose (ember)
STOPS = [(0.0, (255, 178, 77)), (0.5, (255, 122, 69)), (1.0, (255, 77, 110))]
MARK = (255, 255, 255)
SS = 8  # supersample for smooth edges


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def grad_color(t):
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return STOPS[-1][1]


def diagonal_gradient(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = grad_color((x + y) / (2 * (size - 1)))
    return img


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def spark(draw, cx, cy, R, inner):
    ir = R * inner
    draw.polygon([
        (cx, cy - R), (cx + ir, cy - ir),
        (cx + R, cy), (cx + ir, cy + ir),
        (cx, cy + R), (cx - ir, cy + ir),
        (cx - R, cy), (cx - ir, cy - ir),
    ], fill=MARK)


def make(size):
    big = size * SS
    base = diagonal_gradient(big).convert("RGBA")

    glyph = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(glyph)
    spark(d, big * 0.45, big * 0.47, big * 0.32, 0.21)   # main spark
    spark(d, big * 0.75, big * 0.25, big * 0.10, 0.24)   # small accent spark
    base.alpha_composite(glyph)

    base.putalpha(rounded_mask(big, int(big * 0.24)))
    return base.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    make(s).save(os.path.join(OUT, f"icon{s}.png"))
    print(f"wrote icons/icon{s}.png")
