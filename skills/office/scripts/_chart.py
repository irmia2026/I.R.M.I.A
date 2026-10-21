"""图表：JSON 规格 → PNG。**自己用 Pillow 画，不引 matplotlib**。

为什么不引 matplotlib：
- 本机没装它，而「装一个 40MB 的绘图库」只为画三根柱子不值当；
- 更要紧的是**中文**：matplotlib 默认字体不含汉字、缺字形时静默画方块，
  正是用户点名的那个坑。这里复用 `_font` 的 cmap 解析，**画之前**逐字预检，
  缺字直接失败并列出来，绝不产出方块图。

支持的图型（够用那一档）：`bar`（竖柱，多系列分组）/ `barh`（横柱）/ `line` / `pie`。
产物：PNG + 一张单页 contact sheet（统一"人眼可查"的接口）+ 可量化读数。
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import _common as C
import _font

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"需要 Pillow：{exc}")

# 一套克制的配色（深蓝/赭石/青灰/酒红/橄榄），不刺眼、打印也分得清
_PALETTE = [
    (58, 96, 154), (196, 122, 62), (86, 138, 130), (152, 74, 84),
    (110, 118, 66), (124, 106, 158), (170, 146, 62), (74, 106, 128),
]
_INK = (28, 34, 42)
_MUTED = (110, 118, 128)
_GRID = (222, 226, 232)
_AXIS = (150, 157, 166)
_BG = (255, 255, 255)

def _text_width(draw, text: str, font) -> float:
    try:
        return draw.textlength(text, font=font)
    except Exception:  # pragma: no cover - 老 Pillow
        return sum(font.getbbox(c)[2] if c.strip() else 0 for c in text)


def _font_at(size: int) -> tuple:
    fonts = _font.find_cjk_fonts()
    reg = fonts.get("regular")
    if not reg:
        raise C.OfficeError(
            "NoCJKFont",
            "这台机器上没找到能画中文的字体，画出来的图会是方块，先不画。",
            next_steps=[
                "Windows 上确认 `C:\\Windows\\Fonts\\msyh.ttc` 在；不在就先装「微软雅黑」",
                "或者设 OFFICE_FONT_REGULAR 指向一个 .ttf/.ttc",
            ],
            detail={"checked": fonts.get("checked", [])},
        )
    try:
        return ImageFont.truetype(reg["path"], size=size, index=reg.get("index", 0)), reg
    except Exception as exc:  # pragma: no cover
        raise C.OfficeError("FontUnusable", f"中文字体打不开：{reg['path']}（{exc}）",
                            next_steps=["换字体文件，或设 OFFICE_FONT_REGULAR"]) from exc


def _as_float(value, where: str) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).strip().replace(",", "").rstrip("%"))
    except Exception as exc:
        raise C.OfficeError(
            "BadSpec",
            f"{where} 不是数字：{value!r}",
            next_steps=["图表规格里 values 只能是数字（百分比给 98.7 这种，不要带 %）"],
        ) from exc


def _nice_ticks(vmax: float, count: int = 5) -> list[float]:
    """把 0..vmax 切成好看的刻度（1/2/2.5/5×10^k）。"""
    if vmax <= 0:
        return [0.0, 1.0]
    raw = vmax / count
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1
    for mult in (1, 2, 2.5, 5, 10):
        step = mult * mag
        if step >= raw:
            break
    step = step or raw
    out, v = [], 0.0
    while v < vmax + step * 0.001:
        out.append(round(v, 10))
        v += step
    if out[-1] < vmax:
        out.append(round(out[-1] + step, 10))
    return out


def _fmt(value: float, spec: dict) -> str:
    fmt = spec.get("value_format")
    if fmt:
        try:
            return fmt.format(value)
        except Exception:
            pass
    if abs(value) >= 1000 or float(value).is_integer():
        return f"{value:,.0f}"
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def _spec_texts(spec: dict) -> str:
    bits = [str(spec.get("title") or ""), str(spec.get("subtitle") or ""),
            str(spec.get("x_label") or ""), str(spec.get("y_label") or "")]
    bits += [str(c) for c in (spec.get("categories") or [])]
    for s in spec.get("series") or []:
        bits.append(str(s.get("name") or ""))
    return "\n".join(bits)


def preflight(spec: dict) -> dict:
    """**画之前**把图里所有要出现的文字逐字对一遍 cmap。"""
    fonts = _font.find_cjk_fonts()
    reg = fonts.get("regular")
    text = _spec_texts(spec)
    if not reg:
        return {"ok": False, "missing": [], "checked_chars": len({c for c in text if not c.isspace()}),
                "error": "没有可用的中文字体"}
    missing = _font.missing_chars(reg["path"], text, reg.get("index", 0))
    return {
        "font": f"{Path(reg['path']).name}#{reg.get('index', 0)}",
        "checked_chars": len({c for c in text if not c.isspace()}),
        "missing": missing,
        "ok": not missing,
    }


def _series_of(spec: dict, n_cat: int) -> list[dict]:
    series = spec.get("series") or []
    if not series:
        raise C.OfficeError(
            "BadSpec",
            "图表规格里没有 series（至少一组数据）",
            next_steps=['写成 {"type":"bar","categories":["甲","乙"],"series":[{"name":"销量","values":[1,2]}]}'],
        )
    out = []
    for i, s in enumerate(series):
        values = s.get("values") or []
        if not values:
            raise C.OfficeError("BadSpec", f"第 {i + 1} 组 series 没有 values")
        nums = [_as_float(v, f"series[{i}].values[{j}]") for j, v in enumerate(values)]
        if len(nums) < n_cat:
            nums += [0.0] * (n_cat - len(nums))
        out.append({"name": str(s.get("name") or f"系列 {i + 1}"),
                    "values": nums[:n_cat],
                    "color": s.get("color") or _color_at(i)})
    return out


def _color_at(i: int) -> tuple:
    return _PALETTE[i % len(_PALETTE)]


def render(spec: dict, out_png: Path) -> dict:
    """按规格画一张 PNG。返回读数（含预检结果与文字清单，便于回执里自证）。"""
    pre = preflight(spec)
    if not pre["ok"]:
        raise C.OfficeError(
            "GlyphMissing",
            "图里有字在这个字体里没有字形，画出来会是方块，所以停在这里："
            + "、".join(pre["missing"][:20]),
            next_steps=["设 OFFICE_FONT_REGULAR 指向覆盖更全的字体（微软雅黑覆盖 2.9 万码位）",
                        "或者把这些标签换成常用字"],
            detail={"missing": pre["missing"], "font": pre.get("font")},
        )

    kind = str(spec.get("type") or "bar").lower()
    alias = {"column": "bar", "hbar": "barh", "horizontal": "barh", "line_chart": "line",
             "pie_chart": "pie", "bar_chart": "bar"}
    kind = alias.get(kind, kind)
    if kind not in ("bar", "barh", "line", "pie"):
        raise C.OfficeError(
            "BadSpec",
            f"不支持的图型：{spec.get('type')!r}",
            next_steps=["支持 bar（竖柱）/ barh（横柱）/ line（折线）/ pie（饼）"],
        )

    cats = [str(c) for c in (spec.get("categories") or [])]
    if kind == "pie":
        if not cats:
            raise C.OfficeError("BadSpec", "饼图必须给 categories（否则切片没有标签）",
                                next_steps=['"categories":["华东","华南","华北"]'])
        series = _series_of(spec, len(cats))[:1]
    else:
        if not cats:
            raise C.OfficeError("BadSpec", "柱/折线图必须给 categories（横轴标签）")
        series = _series_of(spec, len(cats))

    W = int(spec.get("width") or 960)
    H = int(spec.get("height") or 560)
    W = max(360, min(W, 4000))
    H = max(240, min(H, 4000))

    im = Image.new("RGB", (W, H), _BG)
    draw = ImageDraw.Draw(im)
    f_title, _ = _font_at(max(15, int(H * 0.038)))
    f_body, _ = _font_at(max(11, int(H * 0.026)))
    f_small, _ = _font_at(max(9, int(H * 0.021)))

    title = str(spec.get("title") or "")
    pad = max(14, int(W * 0.022))
    y_head = pad
    if title:
        draw.text((pad, y_head), title, font=f_title, fill=_INK)
        y_head += int(f_title.size * 1.5)
    subtitle = str(spec.get("subtitle") or "")
    if subtitle:
        draw.text((pad, y_head), subtitle, font=f_small, fill=_MUTED)
        y_head += int(f_small.size * 1.6)

    legend_items = [(s["name"], s["color"]) for s in series] if (len(series) > 1 or kind == "pie") else []
    legend_labels = [name for name, _ in legend_items]
    if kind == "pie":
        vals = series[0]["values"]
        tot = sum(vals) or 1.0
        legend_labels = [f"{c}  {_fmt(v, spec)}（{v / tot * 100:.1f}%）" for c, v in zip(cats, vals)]
    legend_w = 0
    for label in legend_labels:
        legend_w = max(legend_w, int(_text_width(draw, label, f_small)) + 34)

    top = max(y_head + 8, pad)
    bottom = H - pad - int(f_body.size * 2.4) - (int(f_small.size * 1.6) if spec.get("x_label") else 0)
    left = pad + int(_text_width(draw, "8888", f_small)) + 14
    right = W - pad - (legend_w + 18 if legend_items else 0)

    if kind == "pie":
        _draw_pie(im, draw, spec, cats, series[0], f_small, W, H, top, legend_items, legend_w)
    else:
        _draw_cartesian(im, draw, spec, cats, series, kind, f_body, f_small,
                        left, top, right, bottom, legend_items, legend_w, pad)

    C.prepare_write(out_png)
    im.save(out_png, optimize=True)
    values = [v for s in series for v in s["values"]]
    return {
        "path": str(out_png),
        "type": kind,
        "width": W,
        "height": H,
        "bytes": out_png.stat().st_size,
        "categories": cats,
        "series": [{"name": s["name"], "values": s["values"]} for s in series],
        "points": len(values),
        "value_max": max(values) if values else 0,
        "value_sum": round(sum(values), 6),
        "preflight": pre,
    }


def _draw_cartesian(im, draw, spec, cats, series, kind, f_body, f_small,
                    left, top, right, bottom, legend_items, legend_w, pad):
    horizontal = kind == "barh"
    values = [v for s in series for v in s["values"]]
    vmax = max(values) if values else 1.0
    vmax = vmax if vmax > 0 else 1.0
    ticks = _nice_ticks(vmax)
    vmax_tick = ticks[-1] or 1.0

    plot_l, plot_t, plot_r, plot_b = left, top, max(left + 40, right), max(top + 40, bottom)
    grid_on = spec.get("gridlines", True)
    axis_col = _AXIS

    # 刻度 + 网格
    for t in ticks:
        ratio = t / vmax_tick
        if horizontal:
            x = plot_l + ratio * (plot_r - plot_l)
            if grid_on:
                draw.line([(x, plot_t), (x, plot_b)], fill=_GRID, width=1)
            label = _fmt(t, spec)
            draw.text((x - _text_width(draw, label, f_small) / 2, plot_b + 6), label, font=f_small, fill=_MUTED)
        else:
            y = plot_b - ratio * (plot_b - plot_t)
            if grid_on:
                draw.line([(plot_l, y), (plot_r, y)], fill=_GRID, width=1)
            label = _fmt(t, spec)
            draw.text((plot_l - 8 - _text_width(draw, label, f_small), y - f_small.size * 0.6),
                      label, font=f_small, fill=_MUTED)

    # 轴线
    draw.line([(plot_l, plot_t), (plot_l, plot_b)], fill=axis_col, width=1)
    draw.line([(plot_l, plot_b), (plot_r, plot_b)], fill=axis_col, width=1)

    n_cat = len(cats)
    span = (plot_r - plot_l) if not horizontal else (plot_b - plot_t)
    group_w = span / max(1, n_cat)

    if kind == "line":
        for si, s in enumerate(series):
            pts = []
            for i, v in enumerate(s["values"]):
                cx = plot_l + (i + 0.5) * span / n_cat
                cy = plot_b - (v / vmax_tick) * (plot_b - plot_t)
                pts.append((cx, cy))
            if len(pts) > 1:
                draw.line(pts, fill=s["color"], width=max(2, int(im.height * 0.006)), joint="curve")
            r = max(3, int(min(im.width, im.height) * 0.008))
            for (cx, cy), v in zip(pts, s["values"]):
                draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255),
                             outline=s["color"], width=2)
                if spec.get("show_values"):
                    label = _fmt(v, spec)
                    draw.text((cx - _text_width(draw, label, f_small) / 2, cy - r - f_small.size * 1.35),
                              label, font=f_small, fill=s["color"])
    else:
        n_ser = len(series)
        bar_slot = group_w * 0.62
        bar_w = max(3, bar_slot / max(1, n_ser))
        for i, cat in enumerate(cats):
            base = plot_l + i * group_w + (group_w - bar_slot) / 2
            for si, s in enumerate(series):
                v = s["values"][i]
                ratio = max(0.0, min(1.0, v / vmax_tick))
                if horizontal:
                    y0 = plot_b - (i + 1) * group_w + (group_w - bar_slot) / 2 + si * bar_w
                    x0 = plot_l
                    draw.rectangle([x0, y0, x0 + ratio * (plot_r - plot_l), y0 + max(2, bar_w - 2)],
                                   fill=s["color"])
                    if spec.get("show_values"):
                        label = _fmt(v, spec)
                        draw.text((x0 + ratio * (plot_r - plot_l) + 6, y0 - 1), label, font=f_small, fill=_MUTED)
                else:
                    x0 = base + si * bar_w
                    y0 = plot_b - ratio * (plot_b - plot_t)
                    draw.rectangle([x0, y0, x0 + max(2, bar_w - 3), plot_b], fill=s["color"])
                    if spec.get("show_values"):
                        label = _fmt(v, spec)
                        draw.text((x0 + (bar_w - 3 - _text_width(draw, label, f_small)) / 2,
                                   y0 - f_small.size * 1.35), label, font=f_small, fill=_MUTED)

    # 分类标签
    for i, cat in enumerate(cats):
        if horizontal:
            cy = plot_b - (i + 0.5) * group_w
            draw.text((plot_l - 8 - _text_width(draw, cat, f_body), cy - f_body.size * 0.65),
                      cat, font=f_body, fill=_INK)
        else:
            cx = plot_l + (i + 0.5) * group_w
            draw.text((cx - _text_width(draw, cat, f_body) / 2, plot_b + 6 + f_small.size * 1.5),
                      cat, font=f_body, fill=_INK)

    x_label = str(spec.get("x_label") or "")
    if x_label and not horizontal:
        cx = (plot_l + plot_r) / 2
        draw.text((cx - _text_width(draw, x_label, f_small) / 2, plot_b + 10 + f_small.size * 3),
                  x_label, font=f_small, fill=_MUTED)
    y_label = str(spec.get("y_label") or "")
    if y_label:
        if horizontal:
            draw.text((plot_l, plot_t - f_small.size * 1.7), y_label, font=f_small, fill=_MUTED)
        else:
            tmp = Image.new("RGBA", (int(_text_width(draw, y_label, f_small)) + 8, f_small.size + 8), (0, 0, 0, 0))
            td = ImageDraw.Draw(tmp)
            td.text((0, 0), y_label, font=f_small, fill=_MUTED)
            tmp = tmp.rotate(90, expand=True)
            im.paste(tmp, (max(2, left - f_small.size * 2 - 4), plot_t), tmp)

    # 图例
    if legend_items:
        lx = im.width - pad - legend_w
        ly = top
        for name, color in legend_items:
            draw.rectangle([lx, ly + f_small.size * 0.25, lx + 12, ly + f_small.size * 0.25 + 12], fill=color)
            draw.text((lx + 18, ly), name, font=f_small, fill=_INK)
            ly += int(f_small.size * 1.7)


def _draw_pie(im, draw, spec, cats, series, f_small, W, H, top, legend_items, legend_w):
    values = [max(0.0, v) for v in series["values"]]
    total = sum(values) or 1.0
    side = min(W - 2 * legend_w - 40, H - top - 30)
    side = max(120, side)
    box = [max(16, (W - legend_w - side) // 2), top + 10,
           max(16, (W - legend_w - side) // 2) + side, top + 10 + side]
    start = -90.0
    for i, (cat, v) in enumerate(zip(cats, values)):
        sweep = 360.0 * (v / total)
        draw.pieslice(box, start=start, end=start + sweep, fill=_color_at(i), outline=(255, 255, 255), width=2)
        if sweep > 26:  # 太窄的切片里面塞字会糊，只留在图例里
            mid = math.radians(start + sweep / 2)
            r = side * 0.33
            cx, cy = (box[0] + box[2]) / 2 + r * math.cos(mid), (box[1] + box[3]) / 2 + r * math.sin(mid)
            pct = f"{v / total * 100:.1f}%"
            draw.text((cx - _text_width(draw, pct, f_small) / 2, cy - f_small.size * 0.6),
                      pct, font=f_small, fill=(255, 255, 255))
        start += sweep
    lx = W - legend_w - 8
    ly = top + 10
    for i, (cat, v) in enumerate(zip(cats, values)):
        draw.rectangle([lx, ly + f_small.size * 0.25, lx + 12, ly + f_small.size * 0.25 + 12], fill=_color_at(i))
        label = f"{cat}  {_fmt(v, spec)}（{v / total * 100:.1f}%）"
        draw.text((lx + 18, ly), label, font=f_small, fill=_INK)
        ly += int(f_small.size * 1.8)


def load_spec(path: Path) -> dict:
    try:
        spec = json.loads(Path(path).read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise C.OfficeError("BadSpec", f"图表规格不是合法 JSON：{exc}",
                            next_steps=['用一个 {"type":"bar",...} 结构的 JSON；`office.py chart example` 会打印一份可用样例']) from exc
    if not isinstance(spec, dict):
        raise C.OfficeError("BadSpec", "图表规格的顶层必须是一个对象")
    return spec


EXAMPLE_SPEC = {
    "type": "bar",
    "title": "季度订单量对比",
    "subtitle": "单位：万单 · 数据来源：运营月报",
    "categories": ["华东", "华南", "华北"],
    "series": [{"name": "Q3", "values": [182.5, 96.3, 88.0]},
               {"name": "Q4", "values": [201.4, 104.8, 92.6]}],
    "y_label": "万单",
    "show_values": True,
}
