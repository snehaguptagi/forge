"""Generate docs/banner.png: a dark ember banner for the README.
Run: python3 make_banner.py"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(__file__)
DOCS = os.path.join(ROOT, "docs")
os.makedirs(DOCS, exist_ok=True)

W, H = 1280, 440
BG = (11, 10, 12)
EMBER = [(0.0, (255, 194, 74)), (0.5, (255, 111, 60)), (1.0, (244, 67, 110))]
WHITE = (244, 240, 238)
DIM = (173, 163, 159)
SS = 2

FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Helvetica.ttc"


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def grad(t):
    for i in range(len(EMBER) - 1):
        t0, c0 = EMBER[i]; t1, c1 = EMBER[i + 1]
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return EMBER[-1][1]


def diag_tile(size):
    img = Image.new("RGB", (size, size)); px = img.load()
    for y in range(size):
        for x in range(size):
            px[x, y] = grad((x + y) / (2 * (size - 1)))
    return img


def spark(draw, cx, cy, R, inner=0.21, fill=(255, 255, 255)):
    ir = R * inner
    draw.polygon([(cx, cy - R), (cx + ir, cy - ir), (cx + R, cy), (cx + ir, cy + ir),
                  (cx, cy + R), (cx - ir, cy + ir), (cx - R, cy), (cx - ir, cy - ir)], fill=fill)


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


img = Image.new("RGB", (W * SS, H * SS), BG)

# ember glow (soft, upper-left)
glow = Image.new("RGB", (W * SS, H * SS), BG)
gd = ImageDraw.Draw(glow)
gd.ellipse([-200 * SS, -260 * SS, 720 * SS, 360 * SS], fill=(120, 46, 30))
gd.ellipse([120 * SS, -120 * SS, 760 * SS, 300 * SS], fill=(150, 40, 55))
glow = glow.filter(ImageFilter.GaussianBlur(110 * SS))
img = Image.blend(img, glow, 0.55)

d = ImageDraw.Draw(img)

# logo tile
tile = 132 * SS
tx, ty = 90 * SS, (H * SS - tile) // 2
t_img = diag_tile(tile).convert("RGBA")
mask = Image.new("L", (tile, tile), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, tile - 1, tile - 1], radius=int(tile * 0.26), fill=255)
sp = Image.new("RGBA", (tile, tile), (0, 0, 0, 0))
spd = ImageDraw.Draw(sp)
dcx = dcy = tile / 2
dR = tile * 0.32
dhw = dR * 0.72
spd.polygon([(dcx, dcy - dR), (dcx + dhw, dcy), (dcx, dcy + dR), (dcx - dhw, dcy)], fill=(255, 255, 255, 255))
spd.line([(dcx - dhw, dcy), (dcx + dhw, dcy)], fill=(255, 111, 60, 255), width=int(tile * 0.022))
t_img.alpha_composite(sp)
t_img.putalpha(mask)
img.paste(t_img, (tx, ty), t_img)

# text
text_x = tx + tile + 44 * SS
f_word = font(FONT_BOLD, 96 * SS)
f_sub = font(FONT_BOLD, 30 * SS)
f_tag = font(FONT_REG, 25 * SS)

d.text((text_x, 150 * SS), "Forge", font=f_word, fill=WHITE)
d.text((text_x + 4 * SS, 252 * SS), "AI PROMPT OPTIMIZER", font=f_sub, fill=(255, 138, 90))
d.text((text_x + 4 * SS, 300 * SS),
       "Dump a rough idea. Watch it get forged into the prompt you should've written.",
       font=f_tag, fill=DIM)

img = img.resize((W, H), Image.LANCZOS)
img.save(os.path.join(DOCS, "banner.png"))
print("wrote docs/banner.png")
