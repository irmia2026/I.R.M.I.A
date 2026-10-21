"""IRMIA brand geometry - the single source of truth.

Every number here was measured from the reference bitmap (the analysis scripts in
this directory record how).  build_svg.py, build_png.py and build_ico.py all import
this module, so the SVG master and every exported bitmap are the same geometry.

Local coordinate system
-----------------------
Origin = the star's centre (the midpoint of its bounding box).  The star's four
tips point up / right / down / left.  Lengths are in one unit, chosen so that the
star's vertical half-height is 512.
"""

import math

# --------------------------------------------------------------------------
# global
# --------------------------------------------------------------------------
UNIT = 512.0                         # star's vertical half-height in local units

# --------------------------------------------------------------------------
# star
#
# Measured on the reference (1254x1254 px): the star's silhouette is a 298 x 427 px
# four-pointed star.  Its four tips are needles; the four concave waists sit
# 29.6 px (x) and 21 px (y) out from the centre.  The eight flanks are cubic
# Beziers fitted to the measured contour to 0.74 px RMS.
# --------------------------------------------------------------------------
STAR_CX = 0.0
STAR_CY = 0.0
STAR_HW = 350.9                      # horizontal tip reach
STAR_HV = 512.0                      # vertical tip reach
STAR_TIP_DY = 26.1                   # the horizontal arm's axis sits this far below centre

STAR_TIPS = {
    "top": (5.9, -512.4),
    "right": (350.9, 26.1),
    "bottom": (3.3, 511.6),
    "left": (-350.9, 26.1),
}
STAR_WAISTS = {
    "top_right": (69.1, -41.1),
    "bottom_right": (75.6, 89.7),
    "bottom_left": (-75.6, 89.7),
    "top_left": (-69.1, -41.1),
}

# Each entry: (start corner, control 1, control 2, end corner) - all corner names
# refer to STAR_TIPS / STAR_WAISTS.
STAR_SEGMENTS = [
    ("top", (28.4, -356.3), (-1.9, -186.8), "top_right"),
    ("top_right", (141.8, 31.6), (254.4, 8.0), "right"),
    ("right", (258.1, 44.6), (149.9, 25.0), "bottom_right"),
    ("bottom_right", (-4.5, 213.2), (28.5, 372.6), "bottom"),
    ("bottom", (-23.0, 372.6), (3.5, 211.0), "bottom_left"),
    ("bottom_left", (-151.5, 24.5), (-262.4, 47.1), "left"),
    ("left", (-261.1, 7.5), (-142.1, 34.4), "top_left"),
    ("top_left", (3.9, -181.7), (-22.8, -357.7), "top"),
]


def star_corners():
    """All star corners as a dict name -> (x, y)."""
    out = dict(STAR_TIPS)
    out.update(STAR_WAISTS)
    return out


def star_segments():
    """The star outline as a list of (P0, P1, P2, P3) cubic Bezier segments."""
    c = star_corners()
    return [(c[a], p1, p2, c[b]) for (a, p1, p2, b) in STAR_SEGMENTS]


def star_path_data(nd=2):
    """The star as an SVG path string."""
    segs = star_segments()

    def f(v):
        s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s

    out = [f"M {f(segs[0][0][0])} {f(segs[0][0][1])}"]
    for _, p1, p2, p3 in segs:
        out.append(f"C {f(p1[0])} {f(p1[1])} {f(p2[0])} {f(p2[1])} {f(p3[0])} {f(p3[1])}")
    out.append("Z")
    return " ".join(out)


def star_polygon(n=24, scale=1.0):
    """Flattened star outline (for rasterising)."""
    pts = []
    for (p0, p1, p2, p3) in star_segments():
        for i in range(n):
            t = i / n
            mt = 1 - t
            x = mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0]
            y = mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1]
            pts.append((x * scale, y * scale))
    return pts


# --------------------------------------------------------------------------
# small-size star variant
#
# At 16-32 px the 1 px-wide needle tips vanish.  This variant shortens the needles
# and fattens the waists so the mark stays legible; it is used only for icon sizes
# up to 32 px (see README).
# --------------------------------------------------------------------------
STAR_SMALL_HV = 512.0                # same tip reach as the master
STAR_SMALL_HW = 352.0
STAR_SMALL_WAIST = 300.0             # waists pushed right out (master: 69/76)
STAR_SMALL_TIP_DY = 26.0
# Ring / star ratio and ring weight used only at 16-24 px (see README).
SMALL_RING_A = 480.0
SMALL_RING_B = 190.0
SMALL_RING_STROKE = 70.0


def star_segments_small():
    """A stockier star for 16-24 px exports: same silhouette, blunter needles."""
    hw, hv, w, dy = STAR_SMALL_HW, STAR_SMALL_HV, STAR_SMALL_WAIST / 2.0, STAR_SMALL_TIP_DY
    top = (5.0, -hv)
    bottom = (2.0, hv)
    left = (-hw, dy)
    right = (hw, dy)
    tr = (w, -w * 0.35)
    br = (w, w * 2.05)
    bl = (-w, w * 2.05)
    tl = (-w, -w * 0.35)

    def seg(p0, p3, h, k):
        return (p0, (p0[0] + (p3[0] - p0[0]) * h, p0[1] + (p3[1] - p0[1]) * h),
                (p0[0] + (p3[0] - p0[0]) * k, p0[1] + (p3[1] - p0[1]) * k), p3)

    return [seg(top, tr, 0.32, 0.90), seg(tr, right, 0.47, 0.79),
            seg(right, br, 0.47, 0.79), seg(br, bottom, 0.47, 0.79),
            seg(bottom, bl, 0.32, 0.90), seg(bl, left, 0.47, 0.79),
            seg(left, tl, 0.47, 0.79), seg(tl, top, 0.32, 0.90)]


def star_polygon_small(n=24):
    pts = []
    for (p0, p1, p2, p3) in star_segments_small():
        for i in range(n):
            t = i / n
            mt = 1 - t
            pts.append((mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
                        mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1]))
    return pts


# --------------------------------------------------------------------------
# orbit ring
#
# Ellipse fitted to the ring band in the reference: centre 6.6 px right of and
# 6.1 px below the star centre, semi-axes 232.8 x 76.6 px, rotated -15.2 deg
# (screen space, so the right end rides higher).  The band's thickness is NOT
# constant in the reference - it tapers to a point at both ends and swells where
# the band turns vertical - so the ring is drawn as a filled shape whose half
# width follows the measured profile below.
# --------------------------------------------------------------------------
RING_CX = 11.9                       # ring centre in local units
RING_CY = 17.0
RING_A = 562.8                       # semi-major axis
RING_B = 183.7                       # semi-minor axis
RING_ROT = -15.2                     # degrees (screen space: right end rides higher)

# Stroke thickness sampled every 22.5 deg of the ellipse parameter (local units),
# measured from the reference band.  phi = 0 is the +major-axis end (the ring's
# right tip).  The reference band is not a constant-width stroke: it is thin at
# the two ends and swells around the turns, and the swelling is asymmetric
# (thicker upper-left / lower-right), which the harmonics below reproduce.
RING_THICKNESS = [
    55.6, 50.8, 31.9, 11.0,
    1.5, 1.5, 21.0, 48.5,
    70.5, 25.5, 7.6, 8.1,
    1.5, 1.5, 9.3, 28.7,
]
RING_HARMONICS = (0.0, 0.0, 0.0, 0.0)   # c1, s1, c2, s2 - unused, kept for tuning
RING_STROKE = 40.0                   # nominal width, used for the small-size variant

# The star hides the ring over these parameter ranges (degrees).
RING_GAPS = [(84.0, 110.0), (240.0, 264.0)]


def ring_point(phi_deg, cx=None, cy=None, a=None, b=None, rot=None):
    cx = RING_CX if cx is None else cx
    cy = RING_CY if cy is None else cy
    a = RING_A if a is None else a
    b = RING_B if b is None else b
    rot = RING_ROT if rot is None else rot
    t = math.radians(rot)
    p = math.radians(phi_deg)
    u, v = a * math.cos(p), b * math.sin(p)
    return (cx + u * math.cos(t) - v * math.sin(t),
            cy + u * math.sin(t) + v * math.cos(t))


def ring_normal(phi_deg, a=None, b=None, rot=None):
    """Unit outward normal of the ring's centreline at parameter phi."""
    a = RING_A if a is None else a
    b = RING_B if b is None else b
    rot = RING_ROT if rot is None else rot
    t = math.radians(rot)
    p = math.radians(phi_deg)
    # tangent of (a cos p, b sin p) is (-a sin p, b cos p); normal is (b cos p, a sin p)
    nx, ny = b * math.cos(p), a * math.sin(p)
    rx = nx * math.cos(t) - ny * math.sin(t)
    ry = nx * math.sin(t) + ny * math.cos(t)
    n = math.hypot(rx, ry) or 1.0
    return (rx / n, ry / n)


def ring_thickness_raw(phi_deg):
    """Stroke width at parameter `phi_deg` in local units (unscaled)."""
    th = RING_THICKNESS
    p = phi_deg % 360.0
    step = 360.0 / len(th)
    i = p / step
    i0 = int(math.floor(i)) % len(th)
    i1 = (i0 + 1) % len(th)
    f = i - math.floor(i)
    return th[i0] + (th[i1] - th[i0]) * f


def ring_thickness(phi_deg, scale=1.0):
    """Final stroke width: the sampled profile times the fitted harmonics."""
    r = math.radians(phi_deg)
    c1, s1, c2, s2 = RING_HARMONICS
    mod = 1.0 + c1 * math.cos(r) + s1 * math.sin(r) + c2 * math.cos(2 * r) + s2 * math.sin(2 * r)
    return max(ring_thickness_raw(phi_deg) * max(mod, 0.0), 1e-6) * scale


def ring_outline_polygon(n=288, scale=1.0, a=None, b=None, uniform=None):
    """Closed polygon of the tapered ring (outer edge forward, inner reversed).

    `uniform`, if given, forces a constant stroke width (used for tiny sizes).
    """
    a = (RING_A if a is None else a) * scale
    b = (RING_B if b is None else b) * scale
    cx = RING_CX * scale
    cy = RING_CY * scale
    t = math.radians(RING_ROT)
    outer, inner = [], []
    for i in range(n + 1):
        p = 360.0 * i / n
        u, v = a * math.cos(math.radians(p)), b * math.sin(math.radians(p))
        X = cx + u * math.cos(t) - v * math.sin(t)
        Y = cy + u * math.sin(t) + v * math.cos(t)
        nx, ny = ring_normal(p, a, b)
        h = (uniform * scale if uniform is not None else ring_thickness(p, scale)) / 2.0
        outer.append((X + nx * h, Y + ny * h))
        inner.append((X - nx * h, Y - ny * h))
    return outer + inner[::-1]


def ring_band_path_data(nd=2, scale=1.0, steps_per_deg=1.0):
    """The ring's two visible bands as SVG fill paths (outer edge out, inner back)."""
    def f(v):
        s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s

    a = RING_A * scale
    b = RING_B * scale
    t = math.radians(RING_ROT)
    out = []
    gaps = sorted(RING_GAPS)
    spans = []
    for k in range(len(gaps)):
        s0 = gaps[k][1]
        s1 = gaps[(k + 1) % len(gaps)][0] + (360.0 if k == len(gaps) - 1 else 0.0)
        spans.append((s0, s1))
    for (s0, s1) in spans:
        n = max(8, int((s1 - s0) * steps_per_deg))
        outer, inner = [], []
        for i in range(n + 1):
            p = s0 + (s1 - s0) * i / n
            u, v = a * math.cos(math.radians(p)), b * math.sin(math.radians(p))
            X = RING_CX * scale + u * math.cos(t) - v * math.sin(t)
            Y = RING_CY * scale + u * math.sin(t) + v * math.cos(t)
            nx, ny = ring_normal(p, a, b)
            h = ring_thickness(p, scale) / 2.0
            outer.append((X + nx * h, Y + ny * h))
            inner.append((X - nx * h, Y - ny * h))
        d = [f"M {f(outer[0][0])} {f(outer[0][1])}"]
        for q in outer[1:]:
            d.append(f"L {f(q[0])} {f(q[1])}")
        for q in inner[::-1]:
            d.append(f"L {f(q[0])} {f(q[1])}")
        d.append("Z")
        out.append(" ".join(d))
    return out


# --------------------------------------------------------------------------
# wordmark
#
# Measured: cap height 60 px, stroke 12 px, baseline 348.5 px below the star
# centre, letter widths I 12 / R 68 / M 79 / I 11 / A 76 px, gaps 58/54/57/49,
# wordmark centre 3 px right of the star centre.  Drawn as stroked paths with
# round caps so no font is involved.
# --------------------------------------------------------------------------
W_CAP = 143.9                        # cap height
W_STEM = 28.8                        # stroke width
W_BASELINE = 835.9                   # baseline y
W_DX = 7.2                           # wordmark centre offset
W_GAP = 131.9                        # uniform gap between glyphs
W_WIDTHS = [28.8, 163.1, 189.5, 26.4, 182.3]     # I R M I A


def wordmark_layout():
    """[(glyph, x_left, width)] in local units."""
    total = sum(W_WIDTHS) + W_GAP * (len(W_WIDTHS) - 1)
    x = -total / 2.0 + W_DX
    out = []
    for name, w in zip("IRMIA", W_WIDTHS):
        out.append((name, x, w))
        x += w + W_GAP
    return out


def _arc(cx, cy, r, a0, a1, steps=28):
    pts = []
    for i in range(steps + 1):
        a = math.radians(a0 + (a1 - a0) * i / steps)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def glyph_paths(name, x0, w, stem=None, cap=None, baseline=None):
    """Stroked sub-paths for one glyph (list of point lists)."""
    stem = W_STEM if stem is None else stem
    cap = W_CAP if cap is None else cap
    bl = W_BASELINE if baseline is None else baseline
    top = bl - cap
    h = stem / 2.0
    r = (cap - stem) / 2.0
    paths = []
    if name == "I":
        paths.append([(x0 + h, top), (x0 + h, bl)])
    elif name == "R":
        cxr = x0 + w - h
        cyr = top + r
        paths.append([(x0 + h, top), (x0 + h, bl)])                       # stem
        paths.append([(x0 + h, cyr), (cxr, cyr)])                         # bowl top
        paths.append(_arc(cxr - r, cyr, r, -90, 90))                      # bowl right
        paths.append([(cxr - r, cyr + r), (x0 + h + r * 0.18, cyr + r)])  # bowl bottom
        paths.append([(x0 + h + r * 0.18, cyr + r - h * 0.2), (x0 + w - h, bl)])   # leg
    elif name == "M":
        paths.append([(x0 + h, bl), (x0 + h, top)])
        paths.append([(x0 + w - h, bl), (x0 + w - h, top)])
        paths.append([(x0 + h, top), (x0 + w / 2.0, bl)])
        paths.append([(x0 + w - h, top), (x0 + w / 2.0, bl)])
    elif name == "A":
        paths.append([(x0 + h, bl), (x0 + w / 2.0, top)])
        paths.append([(x0 + w - h, bl), (x0 + w / 2.0, top)])
    return paths


def wordmark_extent(stem=None, cap=None, baseline=None):
    lay = wordmark_layout()
    stem = W_STEM if stem is None else stem
    cap = W_CAP if cap is None else cap
    bl = W_BASELINE if baseline is None else baseline
    return (lay[0][1] - stem / 2.0, bl - cap - stem / 2.0,
            lay[-1][1] + lay[-1][2] + stem / 2.0, bl + stem / 2.0)


def mark_extent():
    """Bounding box of star + ring: (x0, y0, x1, y1)."""
    ring = ring_outline_polygon(360)
    xs = [p[0] for p in ring] + [p[0] for p in star_polygon(16)]
    ys = [p[1] for p in ring] + [p[1] for p in star_polygon(16)]
    return (min(xs), min(ys), max(xs), max(ys))


# --------------------------------------------------------------------------
# palette (sampled from the reference)
# --------------------------------------------------------------------------
BLUE = "#0066E8"          # brand blue: reference cloud core #0058D7, mean #0361E1
BLUE_DEEP = "#0058D7"
BLUE_LIGHT = "#0D6DE8"
WHITE = "#FFFFFF"         # the mark, reference white mean #F7F9FC
