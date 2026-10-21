"""PDF 动作：造（ReportLab，中文字体硬保证）/ 查 / 抽 / 页操作 / 出图 / docx→pdf。

中文字体这条路是本技能的重点：
  选字体 → **先用 cmap 预检每个字有没有字形** → 注册子字体（.ttc 用 subfontIndex）
  → 画 → 出 PDF 后审计"字体是否嵌入" → 抽回文字逐字对 → 出 PNG + contact sheet 给人眼看。
Kimi 那套正是缺了"预检"和"嵌入审计"，`--font` 反而把中文变成方块而它的门判"无异常"。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from xml.sax.saxutils import escape

import _common as C
import _font
import _md
import _render

# ── 字体注册（进程内只注册一次） ─────────────────────────────────────────────

_REGISTERED: dict | None = None


def _register(font_path: str | None = None, index: int | None = None) -> dict:
    """注册中文字体，返回 {regular, bold, fontName, boldName, source}。"""
    global _REGISTERED
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    if font_path:
        fonts = {
            "regular": {"path": font_path, "index": index or 0},
            "bold": {"path": font_path, "index": index or 0},
            "checked": [{"path": font_path, "source": "explicit --font", "usable": True}],
        }
        cov = _font.coverage(font_path, index or 0)
        if not cov["ok"]:
            raise C.OfficeError(
                "FontUnusable",
                f"给的中文字体读不了：{font_path}（{cov['error']}）",
                next_steps=["换一个 .ttf/.ttc：`C:\\Windows\\Fonts\\msyh.ttc`、`simhei.ttf` 都行"],
            )
    else:
        fonts = _font.find_cjk_fonts()

    if not fonts.get("regular"):
        raise C.OfficeError(
            "NoCJKFont",
            "这台机器上没找到能画中文的字体，出中文 PDF 会变成方块，先不画。",
            next_steps=[
                "Windows 上确认 `C:\\Windows\\Fonts\\msyh.ttc` 在；没有字体文件就先装「微软雅黑」",
                "或者显式给：`pdf build --from a.md --out a.pdf --font C:\\Windows\\Fonts\\simhei.ttf`",
                "也可以用环境变量 OFFICE_FONT_REGULAR / OFFICE_FONT_BOLD 指定",
            ],
            detail={"checked": fonts.get("checked", [])},
        )

    key = (fonts["regular"]["path"], fonts["regular"]["index"])
    if _REGISTERED and _REGISTERED["key"] == key:
        return _REGISTERED

    name, bold_name = "CJK-Reg", "CJK-Bold"
    reg = fonts["regular"]
    pdfmetrics.registerFont(TTFont(name, reg["path"], subfontIndex=reg.get("index", 0)))
    bold = fonts.get("bold") or reg
    if (bold["path"], bold.get("index", 0)) == (reg["path"], reg.get("index", 0)):
        pdfmetrics.registerFont(TTFont(bold_name, reg["path"], subfontIndex=reg.get("index", 0)))
        bold_shared = True
    else:
        try:
            pdfmetrics.registerFont(TTFont(bold_name, bold["path"], subfontIndex=bold.get("index", 0)))
            bold_shared = False
        except Exception:
            pdfmetrics.registerFont(TTFont(bold_name, reg["path"], subfontIndex=reg.get("index", 0)))
            bold_shared = True
    try:
        from reportlab.pdfbase.pdfmetrics import registerFontFamily

        registerFontFamily(name, normal=name, bold=bold_name, italic=name, boldItalic=bold_name)
    except Exception:
        pass

    _REGISTERED = {
        "key": key,
        "regular": reg,
        "bold": bold,
        "fontName": name,
        "boldName": bold_name,
        "bold_shared": bold_shared,
        "source": "scan" if not font_path else "explicit",
        "checked": fonts.get("checked", []),
        "describe": f"{_font.describe(reg)} / {_font.describe(bold)}",
    }
    # reportlab 默认 base font 是没嵌入的 Helvetica，会在每页资源里留一个 /Helvetica。
    # 把它换成中文字体，PDF 里就只剩真正嵌入的字体（审计才说得干净）。
    try:
        from reportlab import rl_config

        rl_config.canvas_basefontname = name
    except Exception:
        pass
    return _REGISTERED


def _preflight(text: str, font: dict) -> dict:
    """**画之前**确认每个字都有字形。缺字直接失败，绝不产出方块。"""
    missing = _font.missing_chars(font["regular"]["path"], text, font["regular"].get("index", 0))
    missing_bold = []
    if not font.get("bold_shared"):
        missing_bold = _font.missing_chars(font["bold"]["path"], text, font["bold"].get("index", 0))
    return {
        "checked_chars": len({c for c in text if not c.isspace()}),
        "missing": missing,
        "missing_in_bold": missing_bold,
        "ok": not missing and not missing_bold,
    }


# ── 样式 ────────────────────────────────────────────────────────────────────


def _styles(font: dict):
    from reportlab.lib import colors
    from reportlab.lib.styles import ParagraphStyle

    reg, bold = font["fontName"], font["boldName"]
    base = dict(fontName=reg, wordWrap="CJK", textColor=colors.HexColor("#1B1F24"))
    return {
        "body": ParagraphStyle("body", fontSize=10.5, leading=17, spaceAfter=6, **base),
        "h1": ParagraphStyle("h1", fontName=bold, fontSize=20, leading=28, spaceBefore=6, spaceAfter=10,
                             wordWrap="CJK", textColor=colors.HexColor("#111418")),
        "h2": ParagraphStyle("h2", fontName=bold, fontSize=15.5, leading=22, spaceBefore=12, spaceAfter=6,
                             wordWrap="CJK", textColor=colors.HexColor("#111418")),
        "h3": ParagraphStyle("h3", fontName=bold, fontSize=12.5, leading=19, spaceBefore=10, spaceAfter=4,
                             wordWrap="CJK", textColor=colors.HexColor("#1B1F24")),
        "h4": ParagraphStyle("h4", fontName=bold, fontSize=11, leading=17, spaceBefore=8, spaceAfter=3,
                             wordWrap="CJK", textColor=colors.HexColor("#2A3038")),
        "bullet": ParagraphStyle("bullet", fontSize=10.5, leading=17, leftIndent=14, bulletIndent=4,
                                 spaceAfter=3, bulletFontName=reg, bulletFontSize=10.5, **base),
        "quote": ParagraphStyle("quote", fontSize=10, leading=16, leftIndent=12, textColor=colors.HexColor("#4A5260"),
                                spaceAfter=6, fontName=reg, wordWrap="CJK"),
        "code": ParagraphStyle("code", fontSize=9, leading=13, leftIndent=10, textColor=colors.HexColor("#26313D"),
                               fontName=reg, wordWrap="CJK", backColor=colors.HexColor("#F4F6F8"),
                               borderPadding=5, spaceAfter=8),
        "cell": ParagraphStyle("cell", fontSize=9, leading=13, **base),
        "cellhead": ParagraphStyle("cellhead", fontName=bold, fontSize=9, leading=13, wordWrap="CJK",
                                   textColor=colors.HexColor("#111418")),
        "caption": ParagraphStyle("caption", fontSize=8.5, leading=12, textColor=colors.HexColor("#6B7480"),
                                  fontName=reg, wordWrap="CJK"),
    }


_ANCHOR_SUFFIX = re.compile(r"\s*\{#([A-Za-z0-9_-]+)\}\s*$")


def _inline(text: str, style_body) -> str:
    """Markdown 行内 → ReportLab 的 mini-HTML。`[文字](#锚点)` 变成文内跳转，
    脚注标记变成上标数字。"""
    out = []
    for txt, fmt in _md.inline_runs(text):
        if fmt.get("footnote"):
            out.append(f'<super rise="3">{escape(fmt["footnote"])}</super>')
            continue
        s = escape(txt)
        if fmt.get("code"):
            s = f'<font backColor="#F1F3F5">{s}</font>'
        if fmt.get("bold"):
            s = f"<b>{s}</b>"
        if fmt.get("italic"):
            s = f"<i>{s}</i>"
        if fmt.get("link"):
            s = f'<link href="{escape(str(fmt["link"]))}">{s}</link>'
        out.append(s)
    return "".join(out)


def _split_anchor(text: str) -> tuple[str, str | None]:
    """标题尾部写 `{#名字}` 就当书签锚点（Pandoc 的老写法）。"""
    m = _ANCHOR_SUFFIX.search(text or "")
    if not m:
        return text, None
    return _ANCHOR_SUFFIX.sub("", text), m.group(1)


def _md_to_story(blocks: list[_md.Block], styles, font: dict, usable_w: float,
                 base_dir: Path | None = None, opts: dict | None = None):
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import (PageBreak, Paragraph, Preformatted, Spacer, Table,
                                    TableStyle, XPreformatted)

    opts = opts or {}
    highlight = bool(opts.get("highlight", True))
    table_style = (opts.get("table_style") or "grid").lower()
    code_stats = {"highlighted": 0, "plain": 0, "lexers": []}
    story = []
    for b in blocks:
        if b.kind == "heading":
            lvl = min(b.level, 4)
            text, anchor = _split_anchor(b.text)
            html = _inline(text, styles["body"])
            if anchor:
                html = f'<a name="{escape(anchor)}"/>{html}'
            story.append(Paragraph(html, styles[f"h{lvl}"]))
        elif b.kind == "para":
            story.append(Paragraph(_inline(b.text, styles["body"]), styles["body"]))
        elif b.kind in ("bullet", "ordered"):
            counters: dict[int, int] = {}
            for lvl, item in b.items:
                if b.kind == "ordered":
                    counters[lvl] = counters.get(lvl, 0) + 1
                    for deeper in [k for k in counters if k > lvl]:
                        counters.pop(deeper, None)
                    mark = f"{counters[lvl]}."
                else:
                    mark = "•" if lvl == 0 else "◦"
                st = styles["bullet"].clone(f"b{lvl}")
                st.leftIndent = 14 + lvl * 14
                st.bulletIndent = 4 + lvl * 14
                story.append(Paragraph(_inline(item, styles["body"]), st, bulletText=mark))
        elif b.kind == "quote":
            story.append(Paragraph(_inline(b.text, styles["body"]), styles["quote"]))
        elif b.kind == "code":
            if highlight:
                import _highlight

                markup, info = _highlight.reportlab_markup(b.text, b.lang)
                if info.get("highlighted"):
                    code_stats["highlighted"] += 1
                    if info.get("lexer"):
                        code_stats["lexers"].append(info["lexer"])
                    story.append(XPreformatted(markup, styles["code"]))
                    continue
            code_stats["plain"] += 1
            story.append(Preformatted(b.text, styles["code"]))
        elif b.kind == "hr":
            story.append(Spacer(1, 6))
        elif b.kind == "pagebreak":
            story.append(PageBreak())
        elif b.kind == "image":
            story.extend(_image_story(b, styles, usable_w, base_dir))
        elif b.kind == "equation":
            story.extend(_equation_story(b, styles, usable_w))
        elif b.kind == "table":
            story.append(_table(b, styles, usable_w, colors, mm, Table, TableStyle, Paragraph,
                                Spacer, table_style=table_style))
    story.extend(_notes_story(blocks, styles, opts.get("notes") or {}))
    return story, code_stats, table_style


def _equation_story(b, styles, usable_w: float):
    """公式在 PDF 里没有 OMML 可用 → matplotlib mathtext 渲染成 PNG 再插。

    mathtext 自带数学字形，所以不会出现"公式符号变方块"。
    两种情况下**退回文本近似排版**（不乱画）：含中文（mathtext 没有汉字字形）、
    或者公式里有 mathtext 不认的命令。
    """
    import _mathtex

    png, info = _mathtex.render(b.text)
    if png is None or info.get("cjk"):
        return _equation_text_story(b, styles, info)
    from reportlab.platypus import Image as RLImage
    from reportlab.platypus import Paragraph, Spacer

    px_w, px_h = C.image_px(png)
    w = min(usable_w * 0.8, px_w / 200.0 * 72.0)
    h = w * (px_h / px_w) if px_w else w * 0.4
    items = [Spacer(1, 6)]
    img = RLImage(str(png), width=w, height=h)
    img.hAlign = "CENTER"
    items.append(img)
    items.append(Spacer(1, 8))
    return items


def _equation_text_story(b, styles, info: dict):
    """公式退化成一行文本（用带汉字字形的正文样式），并说明为什么。"""
    from reportlab.enums import TA_CENTER

    from reportlab.platypus import Paragraph, Spacer

    import _omml

    text = _omml.plain_text(b.text)
    st = styles["body"].clone("eqtext")
    st.alignment = TA_CENTER
    st.fontSize = 11
    st.leading = 17
    reason = "含中文，PDF 这条路的 mathtext 没有汉字字形" if info.get("cjk") else \
        f"mathtext 渲染不了：{str(info.get('error'))[:120]}"
    note = styles["caption"].clone("eqnote")
    note.textColor = "#9A5B00"
    return [Spacer(1, 6), Paragraph(escape(text), st),
            Paragraph(f"（公式按文本近似排版 —— {reason}；docx 那条路是原生公式，没有这个问题）", note),
            Spacer(1, 8)]


def _notes_story(blocks, styles, notes: dict):
    """脚注在 PDF 里没有"页底"这回事：统一收在文末「注释」一节，并写清楚。"""
    from reportlab.platypus import Paragraph, Spacer

    if not notes:
        return []
    used: list[str] = []
    for b in blocks:
        if b.kind in ("heading", "para", "quote"):
            for fid in _md.footnote_refs(b.text):
                if fid in notes and fid not in used:
                    used.append(fid)
    if not used:
        return []
    items = [Spacer(1, 10), Paragraph("注释", styles["h4"])]
    for fid in used:
        items.append(Paragraph(f"<super rise='3'>{escape(fid)}</super> {escape(notes[fid])}",
                               styles["caption"]))
    return items



def _image_story(b, styles, usable_w: float, base_dir: Path | None):
    """插图 → ReportLab Image（按 96dpi 折算自然宽度，钉在版心内）+ 图注。"""
    from reportlab.platypus import Image as RLImage
    from reportlab.platypus import Paragraph, Spacer

    path = C.resolve_image(b.text, base_dir)
    px_w, px_h = C.image_px(path)
    if not px_w or not px_h:
        raise C.OfficeError("BadImage", f"这张图读不出尺寸：{path}",
                            next_steps=["用 Pillow 打开确认没坏：`python -c \"from PIL import Image; print(Image.open(r'…').size)\"`"])
    w = min(usable_w * 0.92, px_w / 96.0 * 72.0)
    h = w * (px_h / px_w)
    max_h = 16 * 72.0  # 16cm：一张竖图别把整页吃掉
    if h > max_h:
        w *= max_h / h
        h = max_h
    items = [Spacer(1, 4)]
    img = RLImage(str(path), width=w, height=h)
    img.hAlign = "CENTER"
    items.append(img)
    caption = (b.alt or b.title or "").strip()
    if caption:
        items.append(Paragraph(_inline(caption, styles["caption"]), styles["caption"]))
    items.append(Spacer(1, 8))
    return items


def _table(b, styles, usable_w, colors, mm, Table, TableStyle, Paragraph, Spacer,
           table_style: str = "grid"):
    """表格：`grid`（细网格+表头底色）或 `three-line`（学术三线表）；支持 colspan/rowspan。"""
    cols = max(len(r) for r in b.rows)
    head = [Paragraph(_inline(c or "", styles["cellhead"]), styles["cellhead"]) for c in b.rows[0]]
    body = [[Paragraph(_inline(c or "", styles["cell"]), styles["cell"]) for c in row] for row in b.rows[1:]]
    # 列宽：按各列字符数（CJK 记 2）分配，留 12% 余量
    weights = []
    for i in range(cols):
        wsum = 0
        for row in b.rows:
            cell = row[i] if i < len(row) else ""
            wsum = max(wsum, sum(2 if _is_wide(ch) else 1 for ch in cell))
        weights.append(max(wsum, 4))
    total = sum(weights)
    widths = [usable_w * 0.94 * w / total for w in weights]
    t = Table([head] + body, colWidths=widths, repeatRows=1, hAlign="LEFT")
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        # 不写 FONTNAME 的话 Table 会用默认 Helvetica 发一次 BT/Tf，
        # PDF 里就多出一个没嵌入的 /Helvetica（内容里其实只有表格背景）。
        ("FONTNAME", (0, 0), (-1, -1), styles["cell"].fontName),
    ]
    spans = [tuple(s) for s in (getattr(b, "spans", None) or [])]
    n_rows = len(b.rows)
    if table_style == "three-line":
        cmds += [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3F5F8")),
            ("LINEABOVE", (0, 0), (-1, 0), 1.2, colors.black),
            ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black),
            ("LINEBELOW", (0, n_rows - 1), (-1, n_rows - 1), 1.2, colors.black),
        ]
        for (r, c, rs, cs) in spans:
            cmds.append(("SPAN", (c, r), (c + cs - 1, r + rs - 1)))
    else:
        cmds += [
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#C9D0D8")),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF1F5")),
        ]
        for (r, c, rs, cs) in spans:
            cmds.append(("SPAN", (c, r), (c + cs - 1, r + rs - 1)))
    t.setStyle(TableStyle(cmds))
    return t


def _is_wide(ch: str) -> bool:
    cp = ord(ch)
    return 0x2E80 <= cp <= 0x9FFF or 0xFF00 <= cp <= 0xFFEF or 0x3000 <= cp <= 0x303F


# ── 动作：build ─────────────────────────────────────────────────────────────


def build(src_md: Path, out_pdf: Path, title: str | None, author: str | None,
          page_size: str = "A4", font_path: str | None = None, font_index: int | None = None,
          render_qa: Path | None = None, dpi: int = 120, blocks: list | None = None,
          base_dir: Path | None = None, source_label: str | None = None,
          notes: dict | None = None, table_style: str | None = None,
          highlight: bool = True, columns: int = 1) -> dict:
    from reportlab.lib.pagesizes import A4, LETTER
    from reportlab.lib.units import mm
    from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate

    font = _register(font_path, font_index)
    if blocks is None:
        text = src_md.read_text(encoding="utf-8")
        blocks, parsed_notes = _md.parse_ex(text)
        notes = notes if notes is not None else parsed_notes
    if not blocks:
        raise C.OfficeError("EmptySource", "源文件里没有可排的内容",
                            next_steps=["确认 --from 指的文件不是空的"])
    pre = _preflight(_md.all_text(blocks) + (title or ""), font)
    if not pre["ok"]:
        raise C.OfficeError(
            "GlyphMissing",
            "这些字在你给的字体里没有字形，画出来会是方块，所以停在这里："
            + "、".join(pre["missing"][:20]) + ("…" if len(pre["missing"]) > 20 else ""),
            next_steps=[
                "换字体：`--font C:\\Windows\\Fonts\\msyh.ttc`（微软雅黑覆盖面最广）",
                "或者把这些字换成常用字/图片，再重跑",
            ],
            detail={"missing": pre["missing"], "missing_in_bold": pre["missing_in_bold"]},
        )

    size = A4 if page_size.upper() == "A4" else LETTER
    margin = 20 * mm
    usable_w = size[0] - 2 * margin
    columns = max(1, min(4, int(columns or 1)))
    gap = 8 * mm
    # 分栏时"可排版宽度"是**一栏的宽**：否则表格/图片按整幅宽算，会从栏里溢出去
    content_w = (usable_w - gap * (columns - 1)) / columns if columns > 1 else usable_w
    styles = _styles(font)
    story, code_stats, used_table_style = _md_to_story(
        blocks, styles, font, content_w, base_dir or src_md.parent,
        {"highlight": highlight, "table_style": table_style or "grid", "notes": notes or {}},
    )
    doc_title = title or _guess_title(blocks) or src_md.stem

    bak = C.prepare_write(out_pdf)

    def _decorate(canvas, doc_):
        canvas.saveState()
        canvas.setFont(font["fontName"], 8)
        canvas.setFillColorRGB(0.42, 0.46, 0.52)
        canvas.drawString(margin, 12 * mm, doc_title[:48])
        canvas.drawRightString(size[0] - margin, 12 * mm, f"第 {canvas.getPageNumber()} 页")
        canvas.setStrokeColorRGB(0.85, 0.87, 0.9)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 15.5 * mm, size[0] - margin, 15.5 * mm)
        canvas.restoreState()

    doc = BaseDocTemplate(
        str(out_pdf),
        pagesize=size,
        leftMargin=margin,
        rightMargin=margin,
        topMargin=18 * mm,
        bottomMargin=20 * mm,
        title=doc_title,
        author=author or "",
        subject="",
        creator="Irmia Office skill (reportlab)",
    )
    frame = Frame(margin, 20 * mm, usable_w, size[1] - 38 * mm, id="body",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    if columns > 1:
        frames = [Frame(margin + i * (content_w + gap), 20 * mm, content_w, size[1] - 38 * mm,
                        id=f"col{i + 1}", leftPadding=0, rightPadding=0,
                        topPadding=0, bottomPadding=0)
                  for i in range(columns)]
        doc.addPageTemplates([PageTemplate(id="main", frames=frames, onPage=_decorate)])
    else:
        doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=_decorate)])

    # 页面起始字体也钉成中文字体：否则 reportlab 的页首导言会用 Helvetica，
    # 于是 PDF 里挂着一个没嵌入的 /Helvetica（虽然没画字），审计会如实报"有未嵌入字体"。
    from reportlab.pdfgen import canvas as _canvas

    def _canvasmaker(*a, **kw):
        kw.setdefault("initialFontName", font["fontName"])
        kw.setdefault("initialFontSize", 10.5)
        return _canvas.Canvas(*a, **kw)

    doc.build(story, canvasmaker=_canvasmaker)

    audit = _render.pdf_font_audit(out_pdf)
    expected = _md.all_text(blocks, include_equations=False)
    if notes:
        expected += "\n" + "\n".join(notes.values())
    roundtrip = _render.pdf_text_roundtrip(out_pdf, expected)
    result = {
        "out": C.rel_path(out_pdf),
        "bytes": out_pdf.stat().st_size,
        "backup": C.rel_path(bak) if bak else None,
        "pages": audit["pages"],
        "page_size": page_size,
        "font": {"regular": font["regular"]["path"], "index": font["regular"].get("index", 0),
                 "bold": font["bold"]["path"], "bold_shared": font["bold_shared"]},
        "preflight": pre,
        "font_audit": {"all_embedded": audit["all_fonts_embedded"], "non_embedded": audit["non_embedded"],
                       "fonts": audit["fonts"]},
        "text_roundtrip": roundtrip,
        "source": {"file": source_label or C.rel_path(src_md), "blocks": _md.stats(blocks)},
        "images": sum(1 for b in blocks if getattr(b, "kind", "") == "image"),
        "equations": sum(1 for b in blocks if getattr(b, "kind", "") == "equation"),
        "table_style": used_table_style,
        "columns": columns,
        "code_highlight": code_stats,
        "notes": len(notes or {}),
    }
    warnings = []
    if not audit["all_fonts_embedded"]:
        warnings.append(
            "有字体没嵌入（%s）：本机能看，换机器/换阅读器可能变样，正式交付建议全部嵌入"
            % "、".join(audit["non_embedded"])
        )
    if roundtrip.get("available") and not roundtrip["roundtrip_ok"]:
        warnings.append("抽回来的文字少了这些字：%s" % "".join(roundtrip["missing_chars"][:20]))
    return {"result": result, "warnings": warnings, "blocks": blocks}


def _guess_title(blocks) -> str | None:
    for b in blocks:
        if b.kind == "heading" and b.text.strip():
            return _md.plain_text(b.text).strip()
    return None


def _read_html_text(path: Path) -> tuple[str, str]:
    """读 HTML：先 UTF-8（含 BOM），再 GB18030（中文 Windows 的老文件）。

    返回 (文本, 实际用的编码)。编码猜错时中文会成乱码，而我们的 cmap 预检
    只查"字体有没有这个字形"、查不出"字符本身是错的"，所以这里要主动说清楚。
    """
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace"), "utf-8(replace)"


def _playwright_pdf(src_html: Path, out_pdf: Path, page_size: str = "A4") -> dict:
    """走 Chromium 打印（CSS 分页/@page/复杂表格/浮动都由浏览器负责）。"""
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # noqa: BLE001
        raise C.OfficeError(
            "DependencyMissing",
            f"HTML→PDF 的浏览器路线需要 playwright：{type(exc).__name__}: {exc}",
            next_steps=['"{}" -m pip install playwright'.format(__import__("sys").executable),
                        '"{}" -m playwright install chromium'.format(__import__("sys").executable),
                        "不装也能用本地链：`pdf from-html --engine local`（CSS 分页只认子集）"],
        ) from exc
    url = src_html.resolve().as_uri()
    C.prepare_write(out_pdf)
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as exc:  # noqa: BLE001
            raise C.OfficeError(
                "BrowserMissing",
                f"Chromium 起不来：{str(exc)[:200]}",
                next_steps=['"{}" -m playwright install chromium'.format(__import__("sys").executable),
                            "或者用本地链：`pdf from-html --engine local`（不依赖浏览器）"],
            ) from exc
        try:
            page = browser.new_page(viewport={"width": 1240, "height": 1754})
            page.goto(url, wait_until="load", timeout=45000)
            try:
                page.emulate_media(media="print")
            except Exception:
                pass
            page.pdf(path=str(out_pdf), format=page_size.title() if page_size else "A4",
                     print_background=True, prefer_css_page_size=True,
                     margin={"top": "18mm", "bottom": "18mm", "left": "16mm", "right": "16mm"})
        finally:
            browser.close()
    return {"route": "playwright", "bytes": out_pdf.stat().st_size}


def _html_all_text(html_text: str) -> str:
    """HTML 里的可见文字（`<style>`/`<script>` 里的东西不算，否则往返比对会假报警）。"""
    from lxml import html as LH

    try:
        root = LH.fromstring(html_text)
    except Exception:
        return ""
    for bad in list(root.iter()):
        tag = bad.tag.lower() if isinstance(bad.tag, str) else ""
        if tag in ("style", "script", "noscript", "head", "title"):
            parent = bad.getparent()
            if parent is not None:
                parent.remove(bad)
    return root.text_content()


def build_html(src_html: Path, out_pdf: Path, title: str | None, author: str | None,
               page_size: str = "A4", font_path: str | None = None, font_index: int | None = None,
               render_qa: Path | None = None, dpi: int = 120, engine: str = "auto") -> dict:
    """HTML → PDF。两条路：

    · `playwright`：Chromium 打印，CSS 分页/@page/浮动/复杂表格全交给浏览器（保真最高）
    · `local`：lxml 解析 → 我们自己的块模型 → ReportLab（不依赖浏览器，认 CSS 的子集）

    `auto` 先试浏览器，起不来就落回本地链，并在回执 `degraded` 里说清"为什么降级"。
    """
    import _html

    text, encoding = _read_html_text(src_html)
    engine = (engine or "auto").lower()
    warnings: list[str] = []
    degraded = []
    html_text_all = _html_all_text(text)

    if engine in ("auto", "playwright", "chromium", "browser"):
        try:
            pw = _playwright_pdf(src_html, out_pdf, page_size)
            audit = _render.pdf_font_audit(out_pdf)
            roundtrip = _render.pdf_text_roundtrip(out_pdf, html_text_all)
            result = {
                "out": C.rel_path(out_pdf),
                "bytes": pw["bytes"],
                "pages": audit["pages"],
                "page_size": page_size,
                "route": "playwright（Chromium 打印）",
                "encoding": encoding,
                "html_chars": len(html_text_all),
                "font": {"regular": "（浏览器使用系统字体）", "index": 0,
                         "bold": "", "bold_shared": True},
                "preflight": {"ok": None, "checked_chars": len({c for c in html_text_all if not c.isspace()}),
                              "note": "浏览器排版：cmap 预检不适用，改用文本往返 + 出图核对"},
                "font_audit": {"all_embedded": audit["all_fonts_embedded"],
                               "non_embedded": audit["non_embedded"], "fonts": audit["fonts"]},
                "text_roundtrip": roundtrip,
                "source": {"file": C.rel_path(src_html), "blocks": {"blocks": 0, "chars": len(html_text_all)}},
                "images": 0,
                "engine": "playwright",
            }
            if not audit["all_fonts_embedded"]:
                warnings.append("有字体没嵌入（%s）：换机器可能变样" % "、".join(audit["non_embedded"]))
            if roundtrip.get("available") and not roundtrip.get("roundtrip_ok"):
                warnings.append("抽回来的文字少了这些字：%s" % "".join(roundtrip["missing_chars"][:20]))
            return {"result": result, "warnings": warnings, "blocks": []}
        except C.OfficeError as exc:
            if engine != "auto":
                raise
            degraded.append({
                "capability": "浏览器排版（CSS 分页/@page/浮动）",
                "reason": f"{exc.code}: {exc.message[:160]}",
                "fallback": "已自动落回本地链（lxml → ReportLab）：CSS 分页只认子集，@page 尺寸/外边距认",
            })

    blocks, meta = _html.parse_ex(text)
    if not blocks:
        raise C.OfficeError(
            "EmptySource",
            f"HTML 里没解析出可排的内容（按 {encoding} 解码后 {len(text)} 字符）",
            next_steps=["确认 HTML 里真的有 h1/p/table/pre 这些标签",
                        "支持面见 SKILL.md「HTML → PDF」一节；纯 JS 渲染的页面（SPA）请用 --engine playwright"],
        )
    css_size = str((meta.get("page") or {}).get("size") or "").upper()
    if css_size in ("A4", "LETTER"):
        page_size = css_size.title() if css_size == "LETTER" else "A4"
    res = build(src_html, out_pdf, title=title, author=author, page_size=page_size,
                font_path=font_path, font_index=font_index, render_qa=render_qa, dpi=dpi,
                blocks=blocks, base_dir=src_html.parent, source_label=C.rel_path(src_html))
    res["result"]["route"] = "html→blocks→reportlab（本地，不引浏览器）"
    res["result"]["encoding"] = encoding
    res["result"]["engine"] = "local"
    res["result"]["html_blocks"] = _md.stats(blocks)
    res["result"]["css"] = {"page": meta.get("page"), "page_breaks": meta.get("page_breaks")}
    if encoding != "utf-8-sig":
        res["warnings"].append(f"HTML 不是 UTF-8，按 {encoding} 解码的；中文若成乱码请转成 UTF-8 再跑")
    if degraded:
        res["warnings"].append("浏览器路线不可用，已降级到本地链：" + degraded[0]["reason"])
        res["degraded"] = degraded
    return res


# ── 动作：表单（AcroForm） ──────────────────────────────────────────────────

def form_info(pdf_path: Path) -> dict:
    """列出 AcroForm 字段：名字/类型/当前值/是否必填/是否只读。"""
    try:
        from pypdf import PdfReader
    except Exception as exc:  # noqa: BLE001
        raise C.OfficeError("DependencyMissing", f"读表单需要 pypdf：{exc}",
                            next_steps=["python -m pip install pypdf"]) from exc
    reader = PdfReader(str(pdf_path))
    fields = reader.get_fields() or {}
    out = []
    for name, field in fields.items():
        ftype = str(field.get("/FT") or "")
        out.append({
            "name": name,
            "type": {"/Tx": "text", "/Btn": "button", "/Ch": "choice", "/Sig": "signature"}.get(
                ftype, ftype or "unknown"),
            "value": str(field.get("/V")) if field.get("/V") is not None else None,
            "required": bool(int(field.get("/Ff") or 0) & 2),
            "readonly": bool(int(field.get("/Ff") or 0) & 1),
        })
    return {"file": C.rel_path(pdf_path), "field_count": len(out), "fields": out,
            "has_acroform": bool(fields)}


def form_fill(pdf_path: Path, out_pdf: Path, values: dict) -> dict:
    """填表单。pypdf 负责改值 + 重生成外观；不认识的字段名会**报错**而不是静默忽略。"""
    try:
        from pypdf import PdfReader, PdfWriter
    except Exception as exc:  # noqa: BLE001
        raise C.OfficeError("DependencyMissing", f"填表单需要 pypdf：{exc}",
                            next_steps=["python -m pip install pypdf"]) from exc
    info = form_info(pdf_path)
    known = {f["name"] for f in info["fields"]}
    unknown = [k for k in values if k not in known]
    if unknown:
        raise C.OfficeError(
            "FieldNotFound",
            f"表单里没有这些字段：{unknown}",
            next_steps=[f"现有字段：{sorted(known)[:20]}", "先跑 `pdf form --info --file a.pdf` 看名字"],
        )
    reader = PdfReader(str(pdf_path))
    writer = PdfWriter()
    writer.append(reader)
    C.prepare_write(out_pdf)
    applied = 0
    for page in writer.pages:
        try:
            writer.update_page_form_field_values(page, values, auto_regenerate=False)
            applied += 1
        except Exception:
            continue
    try:
        writer.set_need_appearances_writer(True)
    except Exception:
        pass
    if not applied:
        raise C.OfficeError(
            "FormFillFailed",
            "一页都没写进去：pypdf 找不到这些字段（名字要用 info 里给的完整名，可能带前缀）",
            next_steps=["先跑 `pdf form --file a.pdf --info` 看字段的完整名字",
                        "有些表单字段名带 `form1[0].#subform[0].name[0]` 这种层级名"],
            detail={"set": values},
        )
    with open(out_pdf, "wb") as fh:
        writer.write(fh)
    after = form_info(out_pdf)
    filled = {f["name"]: f["value"] for f in after["fields"] if f["name"] in values}
    return {"file": C.rel_path(pdf_path), "out": C.rel_path(out_pdf),
            "bytes": out_pdf.stat().st_size,
            "set": values, "readback": filled,
            "fields": after["field_count"],
            "all_applied": all(str(filled.get(k)) == str(v) for k, v in values.items())}


# ── 动作：加密 / 解密 ──────────────────────────────────────────────────────

def encrypt_pdf(pdf_path: Path, out_pdf: Path, user_password: str,
                owner_password: str | None = None, algorithm: str = "aes256") -> dict:
    """加密（默认 AES-256，R=6）。权限位给全（可打印可复制），只设打开密码。"""
    pikepdf = _pikepdf()
    algo = (algorithm or "aes256").lower()
    if algo in ("aes256", "aes-256", "r6"):
        revision = 6
    elif algo in ("aes128", "aes-128", "r4"):
        revision = 4
    else:
        raise C.OfficeError("BadArg", f"不认识的加密算法：{algorithm!r}",
                            next_steps=["支持 aes256（默认）/ aes128"])
    C.prepare_write(out_pdf)
    with pikepdf.open(pdf_path) as pdf:
        enc = pikepdf.Encryption(owner=owner_password or user_password,
                                 user=user_password, R=revision)
        pdf.save(out_pdf, encryption=enc)
    # 立刻验证：不带密码打不开、带密码能打开
    locked = False
    try:
        with pikepdf.open(out_pdf):
            locked = False
    except pikepdf.PasswordError:
        locked = True
    opened = False
    try:
        with pikepdf.open(out_pdf, password=user_password) as pdf:
            opened = len(pdf.pages) > 0
    except Exception:
        opened = False
    return {"out": C.rel_path(out_pdf), "bytes": out_pdf.stat().st_size,
            "algorithm": algo, "revision": revision,
            "requires_password": locked, "opens_with_password": opened}


def decrypt_pdf(pdf_path: Path, out_pdf: Path, password: str) -> dict:
    pikepdf = _pikepdf()
    C.prepare_write(out_pdf)
    try:
        with pikepdf.open(pdf_path, password=password) as pdf:
            pdf.save(out_pdf)
            pages = len(pdf.pages)
    except pikepdf.PasswordError as exc:
        raise C.OfficeError(
            "PasswordWrong", "密码不对，打不开这份 PDF",
            next_steps=["确认是**打开密码**（user password），不是权限密码",
                        "没有密码的话这份文件解密不了"],
        ) from exc
    with pikepdf.open(out_pdf) as pdf:
        still_locked = False
        pages2 = len(pdf.pages)
    return {"out": C.rel_path(out_pdf), "bytes": out_pdf.stat().st_size,
            "pages": pages2, "decrypted": not still_locked}


# ── 动作：inspect ───────────────────────────────────────────────────────────


def inspect(pdf_path: Path) -> dict:
    audit = _render.pdf_font_audit(pdf_path)
    info = {
        "file": C.rel_path(pdf_path),
        "bytes": pdf_path.stat().st_size,
        "pages": audit["pages"],
        "page_sizes_pt": audit["page_sizes_pt"],
        "docinfo": audit["docinfo"],
        "fonts": audit["fonts"],
        "all_fonts_embedded": audit["all_fonts_embedded"],
        "non_embedded": audit["non_embedded"],
    }
    try:
        import pdfplumber

        with pdfplumber.open(pdf_path) as pdf:
            per_page = []
            for i, page in enumerate(pdf.pages):
                txt = page.extract_text() or ""
                per_page.append({
                    "page": i + 1,
                    "chars": len(txt.replace("\n", "").replace(" ", "")),
                    "has_cjk": bool(re.search(r"[\u4e00-\u9fff]", txt)),
                })
            info["per_page"] = per_page
            info["empty_pages"] = [p["page"] for p in per_page if p["chars"] == 0]
    except Exception as exc:  # noqa: BLE001
        info["per_page_error"] = f"{type(exc).__name__}: {exc}"
    return info


# ── 动作：extract ───────────────────────────────────────────────────────────


def _pages_filter(pdf, pages: str | None):
    if not pages or pages == "all":
        return list(range(len(pdf.pages)))
    out = []
    for part in str(pages).split(","):
        part = part.strip()
        if re.match(r"^\d+-\d+$", part):
            a, b = part.split("-")
            out.extend(range(int(a) - 1, int(b)))
        elif part.isdigit():
            out.append(int(part) - 1)
    return [i for i in out if 0 <= i < len(pdf.pages)]


def extract_text(pdf_path: Path, pages: str | None = None) -> dict:
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        idx = _pages_filter(pdf, pages)
        parts, per_page = [], []
        for i in idx:
            txt = pdf.pages[i].extract_text() or ""
            parts.append(f"===== 第 {i + 1} 页 =====\n{txt}")
            per_page.append({"page": i + 1, "chars": len(txt)})
    full = "\n\n".join(parts)
    return {
        "file": C.rel_path(pdf_path),
        "pages_read": len(idx),
        "chars": len(full),
        "cjk_chars": len(re.findall(r"[\u4e00-\u9fff]", full)),
        "per_page": per_page,
        "text": full,
    }


def extract_tables(pdf_path: Path, pages: str | None = None) -> dict:
    import pdfplumber

    tables = []
    with pdfplumber.open(pdf_path) as pdf:
        for i in _pages_filter(pdf, pages):
            for t_idx, table in enumerate(pdf.pages[i].extract_tables() or []):
                rows = [[(c or "").replace("\n", " ").strip() for c in row] for row in table if row]
                if not rows:
                    continue
                tables.append({"page": i + 1, "index": t_idx + 1, "rows": len(rows),
                               "cols": max(len(r) for r in rows), "cells": rows})
    return {"file": C.rel_path(pdf_path), "table_count": len(tables), "tables": tables,
            "markdown": _tables_to_md(tables)}


def _tables_to_md(tables: list[dict]) -> str:
    out = []
    for t in tables:
        out.append(f"### 第 {t['page']} 页 · 表 {t['index']}（{t['rows']}×{t['cols']}）")
        rows = t["cells"]
        head = rows[0]
        out.append("| " + " | ".join(head) + " |")
        out.append("|" + "|".join(["---"] * len(head)) + "|")
        for row in rows[1:]:
            out.append("| " + " | ".join(row) + " |")
        out.append("")
    return "\n".join(out)


def _walk_image_xobjects(res, depth: int = 0):
    """翻 /Resources/XObject：/Image 直接产出，/Form 递归进去（嵌套图也能抓到）。"""
    if res is None or depth > 4:
        return
    try:
        xo = res.get("/XObject")
    except Exception:
        return
    if xo is None:
        return
    for name, obj in list(xo.items()):
        try:
            sub = str(obj.get("/Subtype") or "")
        except Exception:
            continue
        if sub == "/Image":
            yield str(name), obj
        elif sub == "/Form":
            try:
                inner = obj.get("/Resources")
            except Exception:
                inner = None
            yield from _walk_image_xobjects(inner, depth + 1)


def _extract_images_pymupdf(pdf_path: Path, out_dir: Path, pages: str | None,
                            min_px: int) -> dict | None:
    """用 MuPDF 抽图：**JBIG2 / JPEG2000 / CCITT 扫描件它都能解**（Pillow 解不了的那些）。

    解不出来的再退一步：把该图在页面上的区域按 200dpi 渲染出来裁成 PNG（"截那块"）。
    pymupdf 不在时返回 None，让调用方落到 pikepdf 实现。
    """
    try:
        import pymupdf as fitz
    except Exception:
        try:
            import fitz  # type: ignore
        except Exception:
            return None
    found: list[dict] = []
    skipped: list[dict] = []
    placements: list[dict] = []
    seen: dict[int, dict] = {}
    doc = fitz.open(str(pdf_path))
    try:
        idx = _range_list(pages, doc.page_count)
        total_pages = len(idx)
        for pi in idx:
            page = doc[pi]
            for img in page.get_images(full=True):
                xref = img[0]
                if xref in seen:
                    rec = seen[xref]
                    if pi + 1 not in rec["pages"]:
                        rec["pages"].append(pi + 1)
                    continue
                rec = {"resource": f"xref{xref}", "pages": [pi + 1],
                       "filter": img[8] if len(img) > 8 else "?", "colorspace": str(img[5])}
                pix = None
                try:
                    pix = fitz.Pixmap(doc, xref)
                    if pix.width < min_px or pix.height < min_px:
                        skipped.append({**rec, "reason": f"太小（{pix.width}×{pix.height}）"})
                        continue
                    if pix.colorspace is None or pix.n - pix.alpha >= 4:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                except Exception as exc:  # noqa: BLE001
                    rects = []
                    try:
                        rects = page.get_image_rects(xref)
                    except Exception:
                        rects = []
                    if not rects:
                        skipped.append({**rec, "reason": f"MuPDF 解不出：{type(exc).__name__}: {exc}"})
                        continue
                    try:  # 最后兜底：把图上那块区域渲染出来
                        pix = page.get_pixmap(clip=rects[0], dpi=200)
                        rec["method"] = "page-crop(200dpi)"
                    except Exception as exc2:  # noqa: BLE001
                        skipped.append({**rec, "reason": f"区域渲染也失败：{type(exc2).__name__}: {exc2}"})
                        continue
                dst = out_dir / f"img-p{pi + 1:03d}-{len(found) + 1:02d}.png"
                C.prepare_write(dst, backup=False)
                try:
                    pix.save(str(dst))
                except Exception as exc:  # noqa: BLE001
                    skipped.append({**rec, "reason": f"存 PNG 失败：{type(exc).__name__}: {exc}"})
                    continue
                rec.setdefault("method", "muPDF-decode")
                rec.update({"path": str(dst), "px": [pix.width, pix.height],
                            "bytes": dst.stat().st_size})
                found.append(rec)
                seen[xref] = rec
                for rect in (page.get_image_rects(xref) or [])[:1]:
                    placements.append({"page": pi + 1, "x_pt": round(rect.x0, 1),
                                       "top_pt": round(rect.y0, 1),
                                       "w_pt": round(rect.width, 1),
                                       "h_pt": round(rect.height, 1),
                                       "src_px": [pix.width, pix.height]})
    finally:
        doc.close()
    return {"found": found, "skipped": skipped, "placements": placements,
            "pages_read": total_pages, "engine": "pymupdf"}


def extract_images(pdf_path: Path, out_dir: Path, pages: str | None = None,
                   min_px: int = 4, batch: int | None = None) -> dict:
    """把 PDF 页里的位图导成 PNG，拼 contact sheet 给人眼查。

    引擎优先 **MuPDF**（JBIG2/JPX/CCITT 扫描件能解；解不出的再按区域渲染兜底），
    没有 pymupdf 时退到 pikepdf（纯 Flate/DCT 的图没问题）。
    同一张图被多页复用时只导一份（`pages` 记下它出现在哪些页）。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    res = _extract_images_pymupdf(pdf_path, out_dir, pages, min_px)
    if res is None:
        res = _extract_images_pikepdf(pdf_path, out_dir, pages, min_px)
    found, skipped = res["found"], res["skipped"]
    pages_read = res.get("pages_read", 0)
    placements = res.get("placements") or []
    if not placements:
        placements, placement_error = _image_placements_pdfplumber(pdf_path, pages)
    else:
        placement_error = None
    for rec in found:
        st = _render.png_stats(rec["path"])
        rec.update({"ink_ratio": st["ink_ratio"], "blank": st["blank"]})
    sheet = None
    if found:
        sheet = _render.contact_sheet(
            found, out_dir / "contact-sheet.png", cols=min(3, max(1, len(found))),
            title=f"{pdf_path.name} · 抽出的 {len(found)} 张图 · 人眼看一遍",
            labels=[f"第 {'/'.join(str(p) for p in r['pages'])} 页 · {r['px'][0]}×{r['px'][1]}"
                    for r in found],
        )
    return {
        "file": C.rel_path(pdf_path),
        "engine": res.get("engine"),
        "chunked": bool(batch and pages_read > batch),
        "batch": batch,
        "pages_read": pages_read,
        "image_count": len(found),
        "images": [{**{k: v for k, v in r.items() if k != "path"}, "path": C.rel_path(r["path"])}
                   for r in found],
        "skipped": skipped,
        "placements": placements[:40],
        "placement_error": placement_error,
        "contact_sheet": C.rel_path(sheet["path"]) if sheet else None,
        "note": "导的是 PDF 里**内嵌的位图**；矢量图（曲线画的图/chart）不会变成 PNG，"
                "那种情况用 `pdf render` 截整页",
    }


def _image_placements_pdfplumber(pdf_path: Path, pages: str | None):
    placements: list[dict] = []
    error = None
    try:
        import pdfplumber

        with pdfplumber.open(pdf_path) as pdfp:
            for pi in _pages_filter(pdfp, pages):
                for im in pdfp.pages[pi].images:
                    placements.append({
                        "page": pi + 1,
                        "x_pt": round(float(im.get("x0") or 0), 1),
                        "top_pt": round(float(im.get("top") or 0), 1),
                        "w_pt": round(float(im.get("width") or 0), 1),
                        "h_pt": round(float(im.get("height") or 0), 1),
                        "src_px": list(im.get("srcsize") or []),
                    })
    except Exception as exc:  # noqa: BLE001
        error = f"{type(exc).__name__}: {exc}"
    return placements, error


def _extract_images_pikepdf(pdf_path: Path, out_dir: Path, pages: str | None,
                            min_px: int) -> dict:
    """pikepdf 实现（pymupdf 不在时的兜底）。"""
    pikepdf = _pikepdf()
    found: list[dict] = []
    skipped: list[dict] = []
    by_key: dict = {}
    with pikepdf.open(pdf_path) as pdf:
        idx = _pages_filter(pdf, pages)
        pages_read = len(idx)
        for pi in idx:
            page = pdf.pages[pi]
            for name, obj in _walk_image_xobjects(page.get("/Resources")):
                try:
                    key = tuple(obj.objgen)
                except Exception:
                    key = ("anon", len(found), len(skipped))
                if key in by_key:
                    rec = by_key[key]
                    if pi + 1 not in rec["pages"]:
                        rec["pages"].append(pi + 1)
                    continue
                rec: dict = {"resource": name, "pages": [pi + 1]}
                try:
                    pil = pikepdf.PdfImage(obj).as_pil_image()
                except Exception as exc:  # noqa: BLE001
                    skipped.append({**rec, "reason": f"{type(exc).__name__}: {exc}"})
                    continue
                if pil.width < min_px or pil.height < min_px:
                    skipped.append({**rec, "reason": f"太小（{pil.width}×{pil.height}），当装饰件跳过"})
                    continue
                dst = out_dir / f"img-p{pi + 1:03d}-{len(found) + 1:02d}.png"
                C.prepare_write(dst, backup=False)
                try:
                    pil.save(dst, optimize=True)
                except Exception as exc:  # noqa: BLE001
                    skipped.append({**rec, "reason": f"存 PNG 失败：{type(exc).__name__}: {exc}"})
                    continue
                try:
                    filters = str(obj.get("/Filter"))
                    colorspace = str(obj.get("/ColorSpace"))
                    has_smask = "/SMask" in obj
                except Exception:
                    filters, colorspace, has_smask = "?", "?", False
                rec.update({
                    "path": str(dst), "px": [pil.width, pil.height], "mode": pil.mode,
                    "bytes": dst.stat().st_size, "filter": filters,
                    "colorspace": colorspace, "has_smask": has_smask,
                    "method": "pikepdf",
                })
                found.append(rec)
                by_key[key] = rec
    return {"found": found, "skipped": skipped, "placements": [],
            "pages_read": pages_read, "engine": "pikepdf"}


# ── 动作：页操作 / 元信息 ───────────────────────────────────────────────────


def _pikepdf():
    try:
        import pikepdf

        return pikepdf
    except Exception as exc:  # pragma: no cover
        raise C.OfficeError(
            "DependencyMissing",
            f"页操作需要 pikepdf：{exc}",
            next_steps=["`python -m pip install pikepdf`，装完重跑"],
        )


def pages_split(pdf_path: Path, out_dir: Path, per_page: bool = True, chunk: int = 1) -> dict:
    pikepdf = _pikepdf()
    out_dir.mkdir(parents=True, exist_ok=True)
    made = []
    with pikepdf.open(pdf_path) as pdf:
        n = len(pdf.pages)
        if per_page:
            groups = [[i] for i in range(n)]
        else:
            chunk = max(1, chunk)
            groups = [list(range(i, min(i + chunk, n))) for i in range(0, n, chunk)]
        for gi, group in enumerate(groups, start=1):
            tail = f"-p{group[-1] + 1:03d}" if len(group) > 1 else ""
            name = f"{pdf_path.stem}-p{group[0] + 1:03d}{tail}.pdf"
            dst = out_dir / name
            C.prepare_write(dst)
            new = pikepdf.new()
            for i in group:
                new.pages.append(pdf.pages[i])
            new.save(dst)
            new.close()
            made.append({"path": C.rel_path(dst), "pages": [i + 1 for i in group],
                         "bytes": dst.stat().st_size})
    return {"file": C.rel_path(pdf_path), "source_pages": n, "outputs": made}


def pages_merge(files: list[Path], out_pdf: Path) -> dict:
    pikepdf = _pikepdf()
    C.prepare_write(out_pdf)
    new = pikepdf.new()
    counts = []
    for f in files:
        with pikepdf.open(f) as pdf:
            counts.append({"file": C.rel_path(f), "pages": len(pdf.pages)})
            for page in pdf.pages:
                new.pages.append(page)
    new.save(out_pdf)
    total = len(new.pages)
    new.close()
    return {"out": C.rel_path(out_pdf), "bytes": out_pdf.stat().st_size, "pages": total, "inputs": counts}


def pages_transform(pdf_path: Path, out_pdf: Path, rotate: int | None = None,
                    drop: str | None = None, keep: str | None = None,
                    crop: str | None = None) -> dict:
    pikepdf = _pikepdf()
    C.prepare_write(out_pdf)
    with pikepdf.open(pdf_path) as pdf:
        drop_idx = set(_pages_filter(pdf, drop)) if drop else set()
        keep_idx = set(_pages_filter(pdf, keep)) if keep else set(range(len(pdf.pages)))
        targets = [i for i in sorted(keep_idx) if i not in drop_idx]
        box = None
        if crop:
            vals = [float(x) for x in str(crop).replace(" ", "").split(",")]
            if len(vals) != 4:
                raise C.OfficeError("BadArg", f"--crop 要四个数：x0,y0,x1,y1（单位 pt），拿到 {crop!r}",
                                    next_steps=["例如 --crop 0,0,595,421 把 A4 裁成上半页"])
            box = vals
        new = pikepdf.new()
        for i in targets:
            page = pdf.pages[i]
            if rotate:
                page.Rotate = (int(page.get("/Rotate", 0)) + int(rotate)) % 360
            if box:
                page.CropBox = pikepdf.Array(box)
            new.pages.append(page)
        new.save(out_pdf)
        out_pages = len(new.pages)
        new.close()
    return {"out": C.rel_path(out_pdf), "bytes": out_pdf.stat().st_size, "pages": out_pages,
            "kept": [i + 1 for i in targets], "rotate": rotate, "crop_pt": box}


def meta_get(pdf_path: Path) -> dict:
    audit = _render.pdf_font_audit(pdf_path)
    return {"file": C.rel_path(pdf_path), "docinfo": audit["docinfo"], "pages": audit["pages"],
            "page_sizes_pt": audit["page_sizes_pt"]}


def meta_set(pdf_path: Path, out_pdf: Path, title=None, author=None, subject=None, keywords=None) -> dict:
    pikepdf = _pikepdf()
    C.prepare_write(out_pdf)
    changes = {k: v for k, v in
               {"/Title": title, "/Author": author, "/Subject": subject, "/Keywords": keywords}.items() if v}
    with pikepdf.open(pdf_path) as pdf:
        with pdf.open_metadata() as meta:
            mapping = {"/Title": "dc:title", "/Author": "dc:creator", "/Subject": "dc:description", "/Keywords": "pdf:Keywords"}
            for k, v in changes.items():
                try:
                    meta[mapping[k]] = v
                except Exception:
                    pass
        pdf.docinfo.update({k: str(v) for k, v in changes.items()})
        pdf.save(out_pdf)
    return {"out": C.rel_path(out_pdf), "bytes": out_pdf.stat().st_size, "set": changes}


# ── 动作：render（PDF → PNG + contact sheet） ───────────────────────────────


def _pdf_page_count(path: Path) -> int:
    try:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(str(path))
        n = len(doc)
        doc.close()
        return n
    except Exception:
        pass
    try:
        import pdfplumber

        with pdfplumber.open(path) as pdf:
            return len(pdf.pages)
    except Exception:
        return 0


def _batches(indexes: list[int], batch: int) -> list[list[int]]:
    if not batch or batch <= 0 or len(indexes) <= batch:
        return [indexes]
    return [indexes[i:i + batch] for i in range(0, len(indexes), batch)]


def render_pages(pdf_path: Path, out_dir: Path, dpi: int = 120, pages: str | None = None,
                 cols: int = 3, title: str | None = None, batch: int = 200) -> dict:
    """PDF 逐页出 PNG + contact sheet。**超过 `batch` 页就分批**（大文件不至于一口气吃满内存）。

    底层复用 `_render.pdf_to_pngs`（pypdfium2 优先，可退到 kit）。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    total = _pdf_page_count(pdf_path)
    want = _range_list(pages, total) if total else [0]
    groups = _batches(want, batch)
    chunked = len(groups) > 1
    images: list[dict] = []
    sheets: list[dict] = []
    route = None
    try:
        for gi, group in enumerate(groups, start=1):
            sub = out_dir / f"batch-{gi:02d}" if chunked else out_dir
            page_arg = ",".join(str(i + 1) for i in group) if chunked else pages
            shot = _render.pdf_to_pngs(pdf_path, sub, dpi=dpi, pages=page_arg)
            route = route or shot.get("route")
            images.extend(shot["images"])
            stats = _render.summarize_pages(shot["images"])
            label_map = {i["page"]: f"第 {i['page']} 页" for i in shot["images"] if "page" in i}
            sheet_path = sub / ("contact-sheet.png" if not chunked else "contact-sheet.png")
            sheet = _render.contact_sheet(
                shot["images"], sheet_path, cols=cols,
                title=(title or f"{pdf_path.name} · {len(shot['images'])} 页")
                      + (f"（第 {gi}/{len(groups)} 批）" if chunked else ""),
                labels=[label_map.get(i.get("page"), "") for i in shot["images"]],
            )
            sheets.append({"path": C.rel_path(sheet["path"]), "pages": len(shot["images"]),
                           "batch": gi})
            if not chunked:
                break
    except C.OfficeError:
        raise
    except Exception as exc:  # noqa: BLE001
        import _lo

        try:
            _lo.require("PDF 出图")
        except Exception as exc2:  # noqa: BLE001
            raise C.OfficeError(
                "RenderUnavailable",
                f"PDF 出图两条路都不通：{type(exc).__name__}: {exc}；libreoffice: {exc2}",
                next_steps=["`python -m pip install pypdfium2` 是最省事的一条（不需要 node/浏览器）"],
            ) from exc
        raise

    stats_all = _render.summarize_pages(images)
    first_sheet = sheets[0]["path"] if sheets else None
    return {
        "file": C.rel_path(pdf_path),
        "route": route,
        "dpi": dpi,
        "page_count": len(images),
        "chunked": chunked,
        "batch": batch,
        "batches": len(sheets),
        "images": [{**i, "path": C.rel_path(i["path"])} for i in images],
        "contact_sheet": first_sheet,
        "contact_sheets": sheets,
        "pages": [{**s_, "path": C.rel_path(s_["path"])} for s_ in stats_all],
        "blank_pages": [s_["page"] for s_ in stats_all if s_["blank"]],
        "mean_ink_ratio": round(sum(s_["ink_ratio"] for s_ in stats_all) / len(stats_all), 5)
        if stats_all else 0.0,
    }


def _range_list(pages: str | None, total: int) -> list[int]:
    if not pages or pages == "all":
        return list(range(total))
    out = []
    for part in str(pages).split(","):
        part = part.strip()
        if re.match(r"^\d+-\d+$", part):
            a, b = part.split("-")
            out.extend(range(int(a) - 1, min(int(b), total)))
        elif part.isdigit():
            out.append(int(part) - 1)
    return [i for i in dict.fromkeys(out) if 0 <= i < total]


# ── 动作：docx/xlsx → pdf（走 LibreOffice） ─────────────────────────────────


def from_office(src: Path, out_pdf: Path) -> dict:
    import _lo

    res = _lo.convert(src, out_pdf)
    audit = _render.pdf_font_audit(out_pdf)
    return {
        "source": C.rel_path(src),
        "out": C.rel_path(out_pdf),
        "bytes": out_pdf.stat().st_size,
        "route": res.get("route"),
        "backup": res.get("backup"),
        "missing_fonts": res.get("missingFonts", []),
        "pages": audit["pages"],
        "fonts": audit["fonts"],
        "all_fonts_embedded": audit["all_fonts_embedded"],
    }
