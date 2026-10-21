# IRMIA brand assets

Hand-built vector geometry for the IRMIA mark: a four-pointed star inside an
inclined orbit ring. **No autotracing was used and no font is required** — every
shape is explicit path data.

The reference bitmap all measurements come from is a blue 1254×1254 PNG supplied
as the design reference. That bitmap is **not** shipped in this repository — only
the vector geometry derived from it is.

---

## 1. Files

| File | What it is |
| --- | --- |
| `irmia-mark.svg` | Master: star + orbit ring only. Transparent background, no `<defs>`, no font. |
| `export/irmia-mark-{16,32,48,64,128,256,512}.png` | The mark rendered from the same geometry, transparent, square, **white**. |
| `export/irmia-mark-blue-{256,512}.png` | The same two renders recoloured to the brand blue (alpha untouched), for **light backgrounds** where white artwork would disappear. |
| `export/irmia-icon-{16,24,32,48,64,128,256}.png` | The exact frames that go into the `.ico`, kept for inspection. |
| `export/irmia.ico` | Multi-size Windows icon: 16, 24, 32, 48, 64, 128, 256. |
| `tools/irmia_geometry.py` | **Single source of truth.** Every number the SVG and the PNGs are made from. |
| `tools/build_svg.py` | Writes the two SVGs. |
| `tools/build_png.py` | Rasterises the PNGs with Pillow (no SVG renderer involved). |
| `tools/build_ico.py` | Builds `irmia.ico` from the same renderer. |

## 2. Coordinate system

The SVG uses one unit: **the star's vertical half-height is 512**. The origin is
the star's centre. So the star is 1024 units tall and ~702 units wide, and the ring
reaches ~1140 units across.

Mark bounding box: `x −565.5 … 584.4`, `y −512.4 … 511.6`.

## 3. The star

Measured on the reference: the silhouette is **298 × 427 reference px**, i.e. a
half-width of 149 px against a half-height of 213.5 px → the vertical points are
**1.43× longer** than the horizontal ones.

The outline is **8 cubic Bézier segments** through 8 corners — 4 needle tips and
4 concave waists — mirrored so the star is symmetric about both axes:

| corner | local units | reference px |
| --- | --- | --- |
| top tip | (5.9, −512.4) | (627.4, 332) |
| right tip | (350.9, 26.1) | (765.2, 556) |
| bottom tip | (3.3, 511.6) | (626.3, 759) |
| left tip | (−350.9, 26.1) | (−) (484.8, 556) |
| waist upper-right | (69.1, −41.1) | (652.6, 529) |
| waist lower-right | (75.6, 89.7) | (655.2, 581) |
| waist lower-left | (−75.6, 89.7) | (594.8, 581) |
| waist upper-left | (−69.1, −41.1) | (597.4, 529) |

Proportions worth knowing:

* needle tips are **extremely sharp** — the vertical point is 1–2 px wide for the
  first ~40 px of its 213 px length, i.e. its flanks have a slope of only
  ≈ 0.07 px across per px along;
* the concave waists are **138 units across horizontally (0.269 × the tip span) and
  130 units across vertically**, and sit 36 / 90 units above / below the centre;
* each flank is a single cubic whose control points were fitted to the measured
  contour (segment RMS **0.74 px** on the reference, silhouette IoU **0.90** after
  symmetrising).

## 4. The orbit ring

Fitted to the band in the reference: an ellipse

* centre **11.9, 17.0 units** right of / below the star centre,
* semi-major axis **562.8**, semi-minor axis **183.7**,
* rotated **−15.2°** (screen space, so the right end rides higher than the left —
  the left tip sits ~26 units *below* the star's horizontal points, the right tip
  ~26 units above, which is why the ring appears to pass in front on one side and
  behind on the other).

The stroke is **not constant** in the reference — the band swells where the ring
turns and thins to almost nothing at the two ends. That is reproduced with a
16-point thickness profile sampled every 22.5° of the ellipse parameter
(`RING_THICKNESS` in `tools/irmia_geometry.py`), running from **1.5 units at the
tips to 70.5 at the turns** (1.5 is a deliberate floor: the measured value is
below 1 unit, which would vanish when rasterised). Fitted band agreement:
IoU **0.82**.

Because a variable-width stroke cannot be expressed as `stroke-width`, the ring
in `irmia-mark.svg` is a **filled path** (outer edge out, inner edge back), split
into the two visible arcs. The star occludes the ring over the parameter ranges
**84°–110°** and **240°–264°**; those are the gaps where the arcs stop.

## 5. Colour

Sampled from the reference bitmap:

| name | HEX | where it comes from |
| --- | --- | --- |
| brand blue | `#0066E8` | chosen between the reference cloud's core `#0058D7` and its mean `#0361E1`, so it stays legible as a background for white artwork |
| deep blue | `#0058D7` | darkest 10 % of the reference's blue pixels |
| light blue | `#0D6DE8` | brightest 10 % of the reference's blue pixels |
| white | `#FFFFFF` | the mark; the reference's white pixels average `#F7F9FC`, so pure white is used for crisp rendering |

The SVG is **pure white on transparent** (`fill="#FFFFFF"`, no background), so it
can be dropped onto the blue above or onto any other surface. Because a white mark
is invisible on a white page, `export/irmia-mark-blue-{256,512}.png` are the same
renders with every non-transparent pixel recoloured to `#0066E8` and the alpha
channel left untouched — use those on light backgrounds (GitHub light theme, white
docs pages). The reference's blue cloud is a background texture, not part of the
mark, and is deliberately not reproduced.

## 6. Re-exporting

Requires only Python 3 with Pillow. No network, no SVG renderer, no font.
Run from the repository root; the scripts locate themselves, so no absolute paths
are needed.

```powershell
python brand\tools\build_svg.py   # -> brand\irmia-mark.svg
python brand\tools\build_png.py   # -> brand\export\irmia-mark-*.png
python brand\tools\build_ico.py   # -> brand\export\irmia.ico (+ icon-*.png frames)
```

To change the design, edit **`tools/irmia_geometry.py`** and re-run the three
commands — the SVG and every bitmap are produced from those numbers, so they can
never drift apart. The parameters are grouped as: `STAR_TIPS` / `STAR_WAISTS` /
`STAR_SEGMENTS` (star), `RING_*` (ring), plus the small-size block
`STAR_SMALL_*` / `SMALL_RING_*`.

The two `irmia-mark-blue-*.png` files are a colour-only variant of the white
renders (same geometry, same alpha), so they are not produced by these scripts;
recolour the corresponding `irmia-mark-*.png` to `#0066E8` if you need to
regenerate them.

## 7. Small sizes (16–64 px)

At 16 px the master star's needles are ~0.75 px wide and the ring's tapered tips
fall below one pixel, so the master geometry is **not** used unchanged. Instead
the mark is redrawn with a stockier star and a constant-width ring:

| size | star | ring | supersampling |
| --- | --- | --- | --- |
| 16, 24 | stockier star: same tips, waists pushed from 69/76 out to **300** units | uniform stroke **70** units, ring shrunk to a=480 / b=190 | 16× |
| 32 | stockier star | uniform stroke 64, a=480 / b=190 | 16× |
| 48 | stockier star | uniform stroke 58, a=500 / b=200 | 10× |
| 64 | stockier star | uniform stroke 52, a=520 / b=205 | 8× |
| 128+ | master star | master tapered ring | 6× / 4× / 3× |

Everything is rendered at 8–16× and downsampled with Lanczos, so the edges stay
smooth. The `MARK_PLAN` table at the top of `tools/build_png.py` and `PLAN` in
`tools/build_ico.py` hold these choices; the 16 px frame is also written out as
`export/irmia-icon-16.png` so it can be inspected on its own.

## 8. Known differences from the reference

These are the places where the vector deliberately or unavoidably differs from the
reference bitmap:

1. **The star is symmetrised.** The reference's arms are not quite mirror-equal
   (its left arm is ~1.5 % shorter, its horizontal axis sits ~1 px off). The
   vector uses one symmetric star; this costs ~2 % of silhouette overlap
   (IoU 0.97 → 0.90) and buys clean, editable mathematics.
2. **The ring's fitted ellipse is 0.82 IoU, not 0.9+.** The reference band is an
   irregular, hand-painted-looking ribbon: its centreline wanders by up to ~5 px
   and its width varies by a factor of ~5 along the arc. The vector reproduces the
   width variation with a 16-point profile, but the last few per cent of overlap
   are not reachable with a clean ellipse.
3. **The reference's background is not reproduced.** The blue cloud, its gradient
   and its ragged edge are a bitmap texture. Only `#0066E8` is defined as the
   brand colour.
4. **At 16–24 px the ring is a plain constant-width band**, not the tapered
   ribbon, and the star's needles are blunted. This is intentional — see §7 — so
   the tiny icon is a different (simplified) silhouette from the master.
