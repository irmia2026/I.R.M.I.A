"""Compose the exported PNGs over the brand blue so the transparency can be checked."""
import os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(HERE, "..", "export"))
ANA = os.path.abspath(os.path.join(HERE, "..", "_analysis"))

BLUE = (0, 102, 232, 255)
names = ["irmia-mark-512.png", "irmia-logo-1024.png"]
tiles = []
for n in names:
    im = Image.open(os.path.join(EXP, n)).convert("RGBA")
    bg = Image.new("RGBA", im.size, BLUE)
    bg.alpha_composite(im)
    tiles.append((n, bg.convert("RGB")))
h = 560
scaled = [(n, im.resize((int(im.width * h / im.height), h), Image.LANCZOS)) for n, im in tiles]
W = sum(im.width for _, im in scaled) + 30
sheet = Image.new("RGB", (W, h + 10), (30, 30, 30))
x = 10
for n, im in scaled:
    sheet.paste(im, (x, 5))
    x += im.width + 20
sheet.save(os.path.join(ANA, "on_blue.png"))
print("wrote on_blue.png", sheet.size)
