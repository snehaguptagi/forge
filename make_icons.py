"""Generate PromptForge PNG icons (16/32/48/128) — a four-point AI 'sparkle'
on a rounded indigo tile. Run: python3 make_icons.py"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)

BG_TOP = (139, 124, 255)   # --accent
BG_BOT = (122, 104, 255)   # --accent-hover
MARK = (255, 255, 255)
SS = 8  # supersample for smooth edges


def vgrad(size, top, bot):
    img = Image.new("RGB", (1, size), 0)
    for y in range(size):
        t = y / max(1, size - 1)
        img.putpixel((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def sparkle(draw, cx, cy, R, inner):
    """A 4-point concave star (the classic AI sparkle)."""
    ir = R * inner
    pts = [
        (cx, cy - R), (cx + ir, cy - ir),
        (cx + R, cy), (cx + ir, cy + ir),
        (cx, cy + R), (cx - ir, cy + ir),
        (cx - R, cy), (cx - ir, cy - ir),
    ]
    draw.polygon(pts, fill=MARK)


def make(size):
    big = size * SS
    base = vgrad(big, BG_TOP, BG_BOT).convert("RGBA")

    glyph = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(glyph)
    # Main sparkle, slightly up-left of center
    sparkle(d, big * 0.44, big * 0.46, big * 0.30, 0.20)
    # Small accent sparkle, lower-right
    sparkle(d, big * 0.74, big * 0.74, big * 0.12, 0.22)

    base.alpha_composite(glyph)
    base.putalpha(rounded_mask(big, int(big * 0.22)))
    return base.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    make(s).save(os.path.join(OUT, f"icon{s}.png"))
    print(f"wrote icons/icon{s}.png")
