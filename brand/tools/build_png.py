"""Rasterise the IRMIA mark and logo with Pillow, straight from irmia_geometry.

No SVG renderer is needed: the SVG master and these bitmaps are produced from the
same numbers, so they cannot drift apart.

Small-size policy (see README):
  16, 24 px  -> stockier star (blunter needles) + uniform, heavier ring
  32 px      -> master star + uniform, slightly heavier ring
  48 px+     -> master geometry unchanged
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import irmia_geometry as G  # noqa: E402

from PIL import Image, ImageDraw  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

# size -> how to draw it.  `small` selects the stockier star, `uniform` forces a
# constant ring stroke, `a`/`b` override the ring's semi-axes for the small mark.
MARK_PLAN = {
    16: dict(small=True, ss=16, uniform=70.0, pad=0.010, a=480.0, b=190.0),
    32: dict(small=True, ss=16, uniform=64.0, pad=0.014, a=480.0, b=190.0),
    48: dict(small=True, ss=10, uniform=58.0, pad=0.016, a=500.0, b=200.0),
    64: dict(small=True, ss=8, uniform=52.0, pad=0.018, a=520.0, b=205.0),
    128: dict(small=False, ss=6, uniform=None, pad=0.018, a=None, b=None),
    256: dict(small=False, ss=4, uniform=None, pad=0.016, a=None, b=None),
    512: dict(small=False, ss=3, uniform=None, pad=0.015, a=None, b=None),
}


def _fit(points, size, pad_frac):
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    span = max(x1 - x0, y1 - y0)
    s = (size * (1.0 - 2 * pad_frac)) / span
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    return s, cx, cy


def _white_on_alpha(mask_img):
    """Convert a rendered luminance mask into white artwork with that mask as alpha."""
    from PIL import Image as _I
    alpha = mask_img.convert("L")
    out = _I.new("RGBA", mask_img.size, (255, 255, 255, 0))
    out.putalpha(alpha)
    return out


def render_mark(size, small=None, ss=None, uniform=None, pad=None, a=None, b=None):
    plan = MARK_PLAN.get(size, MARK_PLAN[512])
    small = plan["small"] if small is None else small
    ss = plan["ss"] if ss is None else ss
    uniform = plan["uniform"] if uniform is None else uniform
    pad = plan["pad"] if pad is None else pad
    star = G.star_polygon_small(80) if small else G.star_polygon(160)
    if a is None:
        a = G.SMALL_RING_A if small else G.RING_A
    if b is None:
        b = G.SMALL_RING_B if small else G.RING_B
    ring = G.ring_outline_polygon(1024, uniform=uniform, a=a, b=b)
    s, cx, cy = _fit(ring + star, size, pad)
    big = size * ss
    img = Image.new("L", (big, big), 0)
    d = ImageDraw.Draw(img)

    def T(p):
        return (big / 2.0 + (p[0] - cx) * s * ss, big / 2.0 + (p[1] - cy) * s * ss)

    d.polygon([T(p) for p in ring], fill=255)
    d.polygon([T(p) for p in star], fill=255)
    return _white_on_alpha(img.resize((size, size), Image.LANCZOS))


def render_logo(width, ss=3, pad_frac=0.02):
    """Star + ring + wordmark, fitted to `width` px (height follows the aspect)."""
    mx0, my0, mx1, my1 = G.mark_extent()
    wx0, wy0, wx1, wy1 = G.wordmark_extent()
    x0 = min(mx0, wx0)
    x1 = max(mx1, wx1)
    y0 = my0
    y1 = wy1
    w = x1 - x0
    h = y1 - y0
    pad = pad_frac * w
    H = int(round(width * (h + 2 * pad) / (w + 2 * pad)))
    s = (width - 2 * pad) / w
    big_w, big_h = width * ss, H * ss
    img = Image.new("L", (big_w, big_h), 0)
    d = ImageDraw.Draw(img)

    def T(p):
        return ((p[0] - x0 + pad) * s * ss, (p[1] - y0 + pad) * s * ss)

    d.polygon([T(p) for p in G.ring_outline_polygon(1024)], fill=255)
    d.polygon([T(p) for p in G.star_polygon(160)], fill=255)
    sw = max(1, int(round(G.W_STEM * s * ss)))
    r = sw / 2.0
    for name, gx, gw in G.wordmark_layout():
        for pts in G.glyph_paths(name, gx, gw):
            xy = [T(p) for p in pts]
            if len(xy) == 2:
                d.line([xy[0], xy[1]], fill=255, width=sw)
            else:
                d.line(xy, fill=255, width=sw, joint="curve")
            for (px, py) in (xy[0], xy[-1]):
                d.ellipse([px - r, py - r, px + r, py + r], fill=255)
    return _white_on_alpha(img.resize((width, H), Image.LANCZOS))


def main():
    exp = os.path.join(ROOT, "export")
    os.makedirs(exp, exist_ok=True)
    for size in (16, 32, 48, 64, 128, 256, 512):
        img = render_mark(size)
        p = os.path.join(exp, f"irmia-mark-{size}.png")
        img.save(p)
        print("wrote %-46s %s" % (p, img.size))
    for size in (512, 1024):
        img = render_logo(size, ss=3 if size <= 512 else 2)
        p = os.path.join(exp, f"irmia-logo-{size}.png")
        img.save(p)
        print("wrote %-46s %s" % (p, img.size))


if __name__ == "__main__":
    main()
