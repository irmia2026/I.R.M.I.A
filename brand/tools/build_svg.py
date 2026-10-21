"""Emit brand/irmia-mark.svg and brand/irmia-logo.svg from irmia_geometry."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import irmia_geometry as G  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def f(v, nd=2):
    s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def glyph_path_d(name, x0, w):
    return " ".join("M " + " L ".join(f"{f(x)} {f(y)}" for x, y in pts)
                    for pts in G.glyph_paths(name, x0, w))


def build_mark():
    x0, y0, x1, y1 = G.mark_extent()
    pad = 6.0
    vb = (x0 - pad, y0 - pad, (x1 - x0) + 2 * pad, (y1 - y0) + 2 * pad)
    L = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- IRMIA mark: four-pointed star inside an inclined orbit ring.',
        '     Hand-built geometry - no font, no tracing. Coordinates are in the unit',
        '     where the star\'s vertical half-height is 512; origin = star centre. -->',
        '<svg xmlns="http://www.w3.org/2000/svg"',
        f'     viewBox="{f(vb[0], 1)} {f(vb[1], 1)} {f(vb[2], 1)} {f(vb[3], 1)}"',
        f'     width="{f(vb[2], 1)}" height="{f(vb[3], 1)}" role="img" aria-label="IRMIA mark">',
        '  <title>IRMIA mark</title>',
        '',
        '  <!-- orbit ring: tapered band, filled path; the star hides the middle -->',
        '  <g fill="#FFFFFF">',
    ]
    for d in G.ring_band_path_data():
        L.append(f'    <path d="{d}"/>')
    L += [
        '  </g>',
        '',
        '  <!-- four-pointed star: 8 cubic segments through 4 tips and 4 concave waists -->',
        f'  <path fill="#FFFFFF" d="{G.star_path_data()}"/>',
        '</svg>',
        '',
    ]
    return "\n".join(L)


def build_logo():
    mx0, my0, mx1, my1 = G.mark_extent()
    wx0, wy0, wx1, wy1 = G.wordmark_extent()
    pad = 6.0
    x0 = min(mx0, wx0) - pad
    x1 = max(mx1, wx1) + pad
    y0 = my0 - pad
    y1 = wy1 + pad
    L = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!-- IRMIA logo: star + orbit ring + wordmark.  All shapes are geometry;',
        '     the IRMIA letters are stroked paths, so no font is required. -->',
        '<svg xmlns="http://www.w3.org/2000/svg"',
        f'     viewBox="{f(x0, 1)} {f(y0, 1)} {f(x1 - x0, 1)} {f(y1 - y0, 1)}"',
        f'     width="{f(x1 - x0, 1)}" height="{f(y1 - y0, 1)}" role="img" aria-label="IRMIA">',
        '  <title>IRMIA</title>',
        '',
        '  <!-- orbit ring: tapered band -->',
        '  <g fill="#FFFFFF">',
    ]
    for d in G.ring_band_path_data():
        L.append(f'    <path d="{d}"/>')
    L += [
        '  </g>',
        '',
        '  <!-- four-pointed star -->',
        f'  <path fill="#FFFFFF" d="{G.star_path_data()}"/>',
        '',
        f'  <!-- IRMIA wordmark: cap height {f(G.W_CAP, 1)}, stem {f(G.W_STEM, 1)}, uniform gap -->',
        f'  <g fill="none" stroke="#FFFFFF" stroke-width="{f(G.W_STEM)}"',
        '     stroke-linecap="round" stroke-linejoin="round">',
    ]
    for name, gx, gw in G.wordmark_layout():
        L.append(f'    <!-- {name} -->')
        L.append(f'    <path d="{glyph_path_d(name, gx, gw)}"/>')
    L += ['  </g>', '</svg>', '']
    return "\n".join(L)


def main():
    for name, content in (("irmia-mark.svg", build_mark()), ("irmia-logo.svg", build_logo())):
        p = os.path.join(ROOT, name)
        open(p, "w", encoding="utf-8", newline="\n").write(content)
        print("wrote %s (%d bytes)" % (p, len(content)))
    print("mark extent  ", [round(v, 1) for v in G.mark_extent()])
    print("wordmark     ", [round(v, 1) for v in G.wordmark_extent()])


if __name__ == "__main__":
    main()
