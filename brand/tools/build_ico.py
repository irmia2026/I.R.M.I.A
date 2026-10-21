"""Build brand/export/irmia.ico with sizes 16/24/32/48/64/128/256.

Per-size drawing follows the same small-size policy as build_png.py.  Each frame
is also written as a PNG next to the .ico so the result can be eyeballed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_png as B  # noqa: E402
import irmia_geometry as G  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SIZES = [16, 24, 32, 48, 64, 128, 256]

PLAN = {
    16: dict(small=True, ss=16, uniform=70.0, pad=0.010, a=480.0, b=190.0),
    24: dict(small=True, ss=16, uniform=70.0, pad=0.010, a=480.0, b=190.0),
    32: dict(small=True, ss=16, uniform=64.0, pad=0.014, a=480.0, b=190.0),
    48: dict(small=True, ss=10, uniform=58.0, pad=0.016, a=500.0, b=200.0),
    64: dict(small=True, ss=8, uniform=52.0, pad=0.018, a=520.0, b=205.0),
    128: dict(small=False, ss=6, uniform=None, pad=0.018, a=None, b=None),
    256: dict(small=False, ss=4, uniform=None, pad=0.016, a=None, b=None),
}


def main():
    exp = os.path.join(ROOT, "export")
    os.makedirs(exp, exist_ok=True)
    imgs = []
    for s in SIZES:
        im = B.render_mark(s, **PLAN[s]).convert("RGBA")
        imgs.append(im)
        p = os.path.join(exp, f"irmia-icon-{s}.png")
        im.save(p)
        print("wrote %-46s %s" % (p, im.size))
    ico = os.path.join(exp, "irmia.ico")
    imgs[-1].save(ico, format="ICO", sizes=[(s, s) for s in SIZES])
    print("wrote", ico)


if __name__ == "__main__":
    main()
