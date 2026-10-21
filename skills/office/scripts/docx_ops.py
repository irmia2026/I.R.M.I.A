"""DOCX 动作：建（Markdown→docx）/ 校验 / 预览 / 拆包 / XML 切片 / 批注 / 修订 / 插图 / 出图。

和 Kimi 那套对齐的能力面，但实现全是我们自己的：
- 建：自己写的 Markdown 解析 + python-docx 排版（中文 eastAsia 字体显式设置，支持插图/脚注/公式/分栏）
- 版式：页眉页脚页码、**目录域（带真页码缓存）**、三线表、多节、分栏、封面
- 校验：OPC/ZIP 结构 + XML 良构 + 关系可达 + **语义抽查** + **元素顺序/批注链/书签/脚注/图片等深检查**
- 预览：给模型读的 view.txt（块序号 + 样式 + 表格尺寸），不靠渲染
- 批注：python-docx 原生 add_comment + **回复/标记解决/批量计划**（`w15:commentEx` 的 paraId 链，自己拼）
- 修订：`w:ins` / `w:del` 的列、插入与删除、**按 id/作者接受或拒绝**（直接改 document.xml）
- 插图 / 书签 / 内链 / 公式（OMML）：XML 层自己拼
- 出图：`convert → PDF → pypdfium2` → PNG + contact sheet + missingFonts
"""

from __future__ import annotations

import hashlib
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import _common as C
import _md
import _ooxml
from _ooxml import (
    CT,
    CT_COMMENTS_EXT,
    M,
    MC,
    PR,
    PPR_ORDER,
    R,
    REL_COMMENTS_EXT,
    REL_NS,
    RPR_ORDER,
    TBLPR_ORDER,
    TCPR_ORDER,
    W,
    W14,
    W15,
    WP,
    XML_SPACE,
)

_check_order = _ooxml.check_order
_insert_ordered = _ooxml.insert_ordered

CJK_FONT = "微软雅黑"
LATIN_FONT = "Segoe UI"
MONO_FONT = "Cascadia Mono"


def _docx():
    import docx

    return docx


def _set_cjk(style_or_run, cjk: str = CJK_FONT, latin: str = LATIN_FONT) -> None:
    """把中/西文字体都钉死。只设 run.font.name 在中文上是不够的（缺 w:eastAsia）。"""
    from docx.oxml.ns import qn

    font = style_or_run.font
    font.name = latin
    rpr = style_or_run.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), cjk)
    rfonts.set(qn("w:ascii"), latin)
    rfonts.set(qn("w:hAnsi"), latin)


def _shade(paragraph_or_cell, hex_fill: str) -> None:
    from docx.oxml.ns import qn

    is_par = hasattr(paragraph_or_cell, "_p")
    el = paragraph_or_cell._p if is_par else paragraph_or_cell._tc
    pr = el.get_or_add_pPr() if is_par else el.get_or_add_tcPr()
    shd = pr.find(qn("w:shd"))
    if shd is None:
        shd = pr.makeelement(qn("w:shd"), {})
        # 顺序敏感：w:shd 必须排在 w:ind / w:spacing / w:jc 之前，append 会写坏顺序
        _insert_ordered(pr, shd, PPR_ORDER if is_par else TCPR_ORDER)
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_fill)


def _hyperlinked_run(par, text: str, anchor: str | None = None, url: str | None = None) -> bool:
    """造一个**可点**的超链接：内链用 `w:anchor`，外链用关系 id。"""
    from lxml import etree

    h = etree.SubElement(par._p, W + "hyperlink")
    if anchor:
        h.set(W + "anchor", anchor)
        h.set(W + "history", "1")
    elif url:
        try:
            rid = par.part.relate_to(
                url,
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                is_external=True,
            )
            h.set(R + "id", rid)
        except Exception:
            return False
    else:
        return False
    run_el = etree.SubElement(h, W + "r")
    rpr = etree.SubElement(run_el, W + "rPr")
    etree.SubElement(rpr, W + "rFonts").set(W + "eastAsia", CJK_FONT)
    etree.SubElement(rpr, W + "color").set(W + "val", "1A5CC8")
    etree.SubElement(rpr, W + "u").set(W + "val", "single")
    t = etree.SubElement(run_el, W + "t")
    t.text = text
    t.set(XML_SPACE, "preserve")
    return True


def _add_runs(par, text: str, bold_all: bool = False, mono: bool = False,
              notes: dict | None = None, used_notes: list | None = None) -> None:
    """行内标记 → run。支持外部链接（`[文字](url)`）与**内链**（`[文字](#书签)`），
    脚注在正文里先落一个 `⟦FN:id⟧` 占位，落盘后再换成真 `w:footnoteReference`。"""
    for chunk, fmt in _md.inline_runs(text):
        if fmt.get("footnote"):
            key = fmt["footnote"]
            if notes is not None and key not in notes:
                continue  # 没有对应定义，当普通文字丢掉标记
            if used_notes is not None and key not in used_notes:
                used_notes.append(key)
            par.add_run(FOOTNOTE_MARK.format(key))
            continue
        if not chunk:
            continue
        link = fmt.get("link")
        if link:
            anchor = str(link)[1:] if str(link).startswith("#") else None
            url = None if anchor else str(link)
            if _hyperlinked_run(par, chunk, anchor=anchor, url=url):
                continue
        run = par.add_run(chunk)
        if fmt.get("bold") or bold_all:
            run.bold = True
        if fmt.get("italic"):
            run.italic = True
        if fmt.get("code") or mono:
            run.font.name = MONO_FONT
            run.font.size = _docx().shared.Pt(9.5)


def _table(doc, block: _md.Block, usable_cm: float, notes: dict | None = None,
           used_notes: list | None = None):
    from docx.shared import Cm

    rows = block.rows
    cols = max(len(r) for r in rows)
    table = doc.add_table(rows=len(rows), cols=cols)
    table.style = "Table Grid"
    table.autofit = True
    # 按内容长度分配列宽（CJK 记 2），并钉住总宽 = 版心宽
    weights = []
    for i in range(cols):
        w = 4
        for row in rows:
            cell = row[i] if i < len(row) else ""
            w = max(w, sum(2 if _is_wide(ch) else 1 for ch in cell))
        weights.append(w)
    total = sum(weights) or 1
    for i, w in enumerate(weights):
        width = Cm(usable_cm * w / total)
        for row in table.rows:
            row.cells[i].width = width
    for ri, row in enumerate(rows):
        for ci in range(cols):
            cell = table.cell(ri, ci)
            cell.text = ""
            par = cell.paragraphs[0]
            par.paragraph_format.space_before = _docx().shared.Pt(2)
            par.paragraph_format.space_after = _docx().shared.Pt(2)
            text = row[ci] if ci < len(row) else ""
            _add_runs(par, text, bold_all=(ri == 0), notes=notes, used_notes=used_notes)
            for run in par.runs:
                run.font.size = _docx().shared.Pt(9.5)
            if ri == 0:
                _shade(cell, "EDF1F6")
    return table


def _is_wide(ch: str) -> bool:
    cp = ord(ch)
    return 0x2E80 <= cp <= 0x9FFF or 0xFF00 <= cp <= 0xFFEF or 0x3000 <= cp <= 0x303F


# ── 插图 ────────────────────────────────────────────────────────────────────


def resolve_image(src: str, base: Path) -> Path:
    """Markdown/参数里给的图：先按当前工作目录找，再按源文件所在目录找（实现在 _common）。"""
    return C.resolve_image(src, base)


def image_size_px(path: Path) -> tuple[int, int]:
    return C.image_px(path)


def _fit_width_cm(px_w: int, usable_cm: float, cap_ratio: float = 0.92) -> float:
    """按 96dpi 折算自然宽度，再钉在版心内（别把图撑出版心）。"""
    natural = (px_w / 96.0) * 2.54 if px_w else usable_cm
    return round(min(usable_cm * cap_ratio, natural), 2)


def _usable_cm(section) -> float:
    return (section.page_width - section.left_margin - section.right_margin) / 360000.0


def _add_picture_paragraph(doc, image_path: Path, width_cm: float, alt: str = ""):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm

    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_before = _docx().shared.Pt(4)
    par.paragraph_format.space_after = _docx().shared.Pt(2)
    run = par.add_run()
    shape = run.add_picture(str(image_path), width=Cm(width_cm))
    if alt:
        try:  # 给图片写 alt 文本（无障碍 / 纯文本阅读器会用到）
            shape._inline.docPr.set("descr", alt)
            shape._inline.docPr.set("title", alt)
        except Exception:
            pass
    return par


def _add_caption(doc, text: str):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, RGBColor

    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_after = Pt(8)
    run = par.add_run(text)
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x5A, 0x63, 0x70)
    _set_cjk(run)
    return par


def _drop_image_block_with_caption(doc, caption: str) -> int:
    """删掉「一张图 + 同 caption 的那一行」——重跑时替换，而不是越插越多。"""
    removed = 0
    want = (caption or "").strip()
    if not want:
        return 0
    for par in list(doc.paragraphs):
        if par._p.getparent() is None:
            continue
        if (par.text or "").strip() != want:
            continue
        prev = par._p.getprevious()
        if prev is not None and prev.tag == W + "p" and prev.find(".//" + W + "drawing") is not None:
            prev.getparent().remove(prev)
            par._p.getparent().remove(par._p)
            removed += 1
    return removed


def insert_image(docx_path: Path, image: Path, anchor: str | None = None,
                 width_cm: float | None = None, caption: str | None = None,
                 out_docx: Path | None = None) -> dict:
    """把一张图放进**已有** docx（可选：接在某段文字后面 + 图注 + 指定宽度）。

    幂等约定：给了 `--caption` 时，同 caption 的「图 + 图注」会先被摘掉再插新的，
    所以重跑同一命令不会把图堆成三张。
    """
    docx = _docx()
    out = out_docx or docx_path
    doc = docx.Document(str(docx_path))
    usable_cm = _usable_cm(doc.sections[0])
    px_w, px_h = image_size_px(image)
    width = float(width_cm) if width_cm else _fit_width_cm(px_w, usable_cm)
    if width <= 0:
        raise C.OfficeError("BadArg", f"--width-cm 必须是正数：{width}")
    if width > usable_cm + 0.01:
        raise C.OfficeError(
            "BadArg",
            f"--width-cm {width} 超过版心宽 {usable_cm:.2f}cm，图会被裁",
            next_steps=[f"改成 {usable_cm * 0.92:.2f} 以内，或者不加 --width-cm 让我们按版心自适应"],
        )

    replaced = _drop_image_block_with_caption(doc, caption or "")
    target = None
    if anchor:
        target = _find_paragraph(doc, anchor)
        if target is None:
            raise C.OfficeError(
                "AnchorNotFound",
                f"文档里找不到锚点文字：{anchor!r}",
                next_steps=["先 `docx view --file a.docx` 看真实文字，挑一段连续、短的文字"],
            )

    pic_par = _add_picture_paragraph(doc, image, width, alt=caption or image.stem)
    cap_par = _add_caption(doc, caption) if caption else None
    if target is not None:
        target._p.addnext(pic_par._p)
        if cap_par is not None:
            pic_par._p.addnext(cap_par._p)

    bak = C.prepare_write(out)
    doc.save(str(out))
    report = validate(out)
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        doc_xml = zf.read("word/document.xml")
    n_drawings = len(re.findall(rb"<w:drawing[ >]", doc_xml))
    media = sorted(n for n in names if n.startswith("word/media/"))
    return {
        "file": C.rel_path(out),
        "backup": C.rel_path(bak) if bak else None,
        "image": {"path": C.rel_path(image), "px": [px_w, px_h], "width_cm": round(width, 2),
                  "alt": caption or image.stem},
        "caption": caption,
        "anchored_after": anchor,
        "replaced_existing": replaced,
        "images_in_doc": n_drawings,
        "media_parts": media,
        "validate": report,
    }


def _fix_zoom(doc) -> bool:
    """python-docx 的默认模板给的是 `<w:zoom w:val="bestFit"/>`，缺 `w:percent`。

    Word 会按 100% 顶上，但这类"模板遗留"属于 Kimi 那份清单里要修的一类；
    我们自己建文档时就写对，省得交付件带着它。
    """
    from docx.oxml.ns import qn

    try:
        el = doc.settings.element
    except Exception:
        return False
    fixed = False
    for z in el.iter(qn("w:zoom")):
        if z.get(qn("w:percent")) is None:
            z.set(qn("w:percent"), "100")
            fixed = True
    return fixed


def build(src_md: Path, out_docx: Path, title: str | None = None, subtitle: str | None = None,
          header: str | None = None, footer: str | None = None, page_numbers: bool = False,
          table_style: str | None = None, cover: bool = False, toc: bool = False,
          author: str | None = None, columns: int | None = None) -> dict:
    docx = _docx()
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm, Pt, RGBColor

    text = src_md.read_text(encoding="utf-8")
    blocks, notes = _md.parse_ex(text)
    if not blocks:
        raise C.OfficeError("EmptySource", "Markdown 里没有内容", next_steps=["确认 --from 的文件不是空的"])

    doc = docx.Document()
    section = doc.sections[0]
    section.left_margin = section.right_margin = Cm(2.4)
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.0)
    usable_cm = (section.page_width - section.left_margin - section.right_margin) / 360000.0

    normal = doc.styles["Normal"]
    _set_cjk(normal)
    normal.font.size = Pt(10.5)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.45
    for name, size in (("Heading 1", 19), ("Heading 2", 15), ("Heading 3", 12.5), ("Heading 4", 11.5)):
        try:
            st = doc.styles[name]
            _set_cjk(st)
            st.font.size = Pt(size)
            st.font.bold = True
            st.font.color.rgb = RGBColor(0x16, 0x1A, 0x1F)
            st.paragraph_format.space_before = Pt(12 if name != "Heading 1" else 6)
            st.paragraph_format.space_after = Pt(6)
        except KeyError:
            pass

    if cover:
        add_cover(doc, title or src_md.stem, subtitle, author,
                  datetime.now().strftime("%Y 年 %m 月 %d 日"))
        title_used = True
    else:
        title_used = False

    if title and not title_used:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        run = p.add_run(title)
        run.bold = True
        run.font.size = Pt(24)
        _set_cjk(run)
        if subtitle:
            sp = doc.add_paragraph()
            srun = sp.add_run(subtitle)
            srun.font.size = Pt(11)
            srun.font.color.rgb = RGBColor(0x5A, 0x63, 0x70)
            _set_cjk(srun)

    image_count = 0
    equation_count = 0
    cjk_equations = 0
    section_count = 1
    bk_id = 0
    anchors: list[str] = []
    used_notes: list[str] = []
    for b in blocks:
        if b.kind == "heading":
            lvl = min(b.level, 4)
            text, anchor = _md.split_anchor(b.text)
            par = doc.add_paragraph(style=f"Heading {lvl}")
            _add_runs(par, text, notes=notes, used_notes=used_notes)
            if anchor:
                bk_id += 1
                _ooxml.wrap_with_bookmark(par._p, anchor[:40], bk_id)
                anchors.append(anchor)
        elif b.kind == "para":
            par = doc.add_paragraph()
            _add_runs(par, b.text, notes=notes, used_notes=used_notes)
        elif b.kind in ("bullet", "ordered"):
            counters: dict[int, int] = {}
            for lvl, item in b.items:
                if b.kind == "ordered":
                    counters[lvl] = counters.get(lvl, 0) + 1
                    for deeper in [k for k in counters if k > lvl]:
                        counters.pop(deeper, None)
                    prefix = f"{counters[lvl]}. "
                else:
                    prefix = "• " if lvl == 0 else "◦ "
                par = doc.add_paragraph()
                par.paragraph_format.left_indent = Cm(0.6 + lvl * 0.55)
                par.paragraph_format.space_after = Pt(3)
                par.add_run(prefix)
                _add_runs(par, item, notes=notes, used_notes=used_notes)
        elif b.kind == "quote":
            for line in b.text.split("\n"):
                par = doc.add_paragraph()
                par.paragraph_format.left_indent = Cm(0.8)
                par.paragraph_format.space_after = Pt(2)
                _add_runs(par, line, notes=notes, used_notes=used_notes)
                _shade(par, "F5F7FA")
                for run in par.runs:
                    run.font.size = Pt(10)
        elif b.kind == "code":
            for line in b.text.split("\n"):
                par = doc.add_paragraph()
                par.paragraph_format.left_indent = Cm(0.5)
                par.paragraph_format.space_after = Pt(0)
                run = par.add_run(line if line else " ")
                run.font.name = MONO_FONT
                run.font.size = Pt(9)
                _set_cjk(run, latin=MONO_FONT)
                _shade(par, "F2F4F7")
        elif b.kind == "table":
            _table(doc, b, usable_cm, notes=notes, used_notes=used_notes)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)
        elif b.kind == "hr":
            par = doc.add_paragraph()
            pPr = par._p.get_or_add_pPr()
            from docx.oxml.ns import qn

            bdr = pPr.makeelement(qn("w:pBdr"), {})
            bottom = pPr.makeelement(qn("w:bottom"), {})
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:color"), "C8CFD8")
            bdr.append(bottom)
            _insert_ordered(pPr, bdr, PPR_ORDER)
        elif b.kind == "pagebreak":
            doc.add_page_break()
        elif b.kind == "sectionbreak":
            from docx.enum.section import WD_SECTION

            doc.add_section(WD_SECTION.NEW_PAGE)
            section_count += 1
        elif b.kind == "columns":
            # 只作用在**当前最后一节**：分节之后写分栏，本来就是这个意思
            set_columns(doc, b.level, index=len(doc.sections) - 1)
        elif b.kind == "equation":
            import _omml
            from lxml import etree

            try:
                math_el = _omml.to_omml(b.text)
            except _omml.LatexError as exc:
                raise C.OfficeError("BadLatex", f"公式解析失败：{exc}",
                                    next_steps=["支持 LaTeX 子集：上下标/分式/根式/求和积分/希腊字母"],
                                    detail={"latex": b.text}) from exc
            par = doc.add_paragraph()
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER
            para_el = etree.SubElement(par._p, M + "oMathPara")
            para_el.append(math_el)
            equation_count += 1
            if _omml.has_cjk(b.text):
                cjk_equations += 1
        elif b.kind == "image":
            img = resolve_image(b.text, src_md.parent)
            px_w, _px_h = image_size_px(img)
            _add_picture_paragraph(doc, img, _fit_width_cm(px_w, usable_cm), alt=b.alt or b.title)
            if b.alt:
                _add_caption(doc, b.alt)
            image_count += 1

    if columns:
        set_columns(doc, columns)
    zoom_fixed = _fix_zoom(doc)
    layout = apply_header_footer(doc, header, footer, page_numbers) if (
        header or footer or page_numbers) else {}
    tables_styled = apply_table_style(doc, table_style) if table_style else 0
    bak = C.prepare_write(out_docx)
    doc.save(out_docx)

    # 脚注占位 → 真脚注部件（python-docx 不支持脚注，落盘后自己拼）
    footnotes_info = {"injected": 0}
    if used_notes:
        parts, names = _read_parts(out_docx)
        footnotes_info = _inject_footnote_markers(
            parts, names, {k: notes[k] for k in used_notes if k in notes})
        if footnotes_info.get("injected"):
            _write_parts(out_docx, out_docx, parts, names)

    toc_info = {}
    if toc:
        toc_info = insert_toc(out_docx, out_docx, (1, 3), None, True)
        toc_info = {k: toc_info[k] for k in ("entries", "passes", "verified") if k in toc_info}

    report = validate(out_docx)
    preview = view(out_docx)
    return {
        "out": C.rel_path(out_docx),
        "bytes": out_docx.stat().st_size,
        "backup": C.rel_path(bak) if bak else None,
        "source": {"file": C.rel_path(src_md), "blocks": _md.stats(blocks)},
        "validate": report,
        "repairs": (["w:zoom 补上 w:percent=100"] if zoom_fixed else []),
        "paragraphs": preview["paragraph_count"],
        "tables": preview["table_count"],
        "images": image_count,
        "equations": equation_count,
        "cjk_equations": cjk_equations,
        "sections": len(doc.sections),
        "layout": layout,
        "tables_styled": tables_styled,
        "footnotes": footnotes_info,
        "toc": toc_info,
        "anchors": anchors,
        "notes_defined": len(notes),
        "chars": preview["chars"],
        "cjk_ok": preview["has_cjk"],
    }


# ── 版式：页眉 / 页脚 / 页码 ───────────────────────────────────────────────

PAGE_TOKEN = re.compile(r"(\{page\}|\{pages\})")
FOOTNOTE_MARK = "\u27e6FN:{}\u27e7"   # ⟦FN:1⟧ 运进 document.xml，再换成真脚注引用


def _style_run(run, size_pt: float | None = None, bold: bool = False, color=None):
    from docx.shared import Pt, RGBColor

    if size_pt:
        run.font.size = Pt(size_pt)
    if bold:
        run.bold = True
    if color:
        run.font.color.rgb = RGBColor(*color)
    _set_cjk(run)
    return run


def _rpr_size(size_pt: float, bold: bool = False):
    """给**手写的** run（域 run）加字号：python-docx 的 Run 包装器不认这种裸元素，
    所以字号要在 rPr 里直接写。"""
    from lxml import etree

    val = str(int(round(size_pt * 2)))

    def build(rpr):
        etree.SubElement(rpr, W + "sz").set(W + "val", val)
        etree.SubElement(rpr, W + "szCs").set(W + "val", val)
        if bold:
            etree.SubElement(rpr, W + "b")

    return build


def _fill_hf_paragraph(par, text: str, size_pt: float = 9, total_pages: bool = True) -> dict:
    """把 `文字 {page} 文字 {pages}` 填进段落：占位符换成 PAGE / NUMPAGES 域。"""
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    for old in list(par._p.findall(W + "r")):
        par._p.remove(old)
    for old in list(par._p.findall(W + "hyperlink")):
        par._p.remove(old)
    rpr = _rpr_size(size_pt)
    fields = {"page": 0, "pages": 0}
    for part in PAGE_TOKEN.split(text or ""):
        if part == "{page}":
            for el in _ooxml.field_runs(" PAGE ", "1", rpr):
                par._p.append(el)
            fields["page"] += 1
        elif part == "{pages}":
            if total_pages:
                for el in _ooxml.field_runs(" NUMPAGES ", "1", rpr):
                    par._p.append(el)
                fields["pages"] += 1
            else:
                _style_run(par.add_run("?"), size_pt)
        elif part:
            _style_run(par.add_run(part), size_pt)
    if par.alignment is None:
        par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    return fields


def apply_header_footer(doc, header: str | None, footer: str | None, page_numbers: bool,
                        size_pt: float = 9) -> dict:
    """给**每一节**写页眉页脚；`{page}`/`{pages}` 换成真域，页码不是画上去的数字。"""
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    info = {"sections": 0, "header": bool(header), "footer": bool(footer),
            "page_field": 0, "pages_field": 0, "page_numbers": bool(page_numbers)}
    footer_text = footer or ""
    if page_numbers and "{page}" not in footer_text:
        footer_text = (footer_text + ("　　" if footer_text else "") + "第 {page} 页 / 共 {pages} 页")
    for section in doc.sections:
        info["sections"] += 1
        if header:
            hdr = section.header
            hdr.is_linked_to_previous = False
            par = hdr.paragraphs[0] if hdr.paragraphs else hdr.add_paragraph()
            got = _fill_hf_paragraph(par, header, size_pt)
            info["page_field"] += got["page"]
            info["pages_field"] += got["pages"]
            par.alignment = WD_ALIGN_PARAGRAPH.LEFT
        if footer_text:
            ftr = section.footer
            ftr.is_linked_to_previous = False
            par = ftr.paragraphs[0] if ftr.paragraphs else ftr.add_paragraph()
            got = _fill_hf_paragraph(par, footer_text, size_pt)
            info["page_field"] += got["page"]
            info["pages_field"] += got["pages"]
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    return info


def set_header_footer(docx_path: Path, out_docx: Path | None, header: str | None,
                      footer: str | None, page_numbers: bool) -> dict:
    """动作：给既有文档补/换页眉页脚（重跑=替换，不会越叠越多）。"""
    docx = _docx()
    out = out_docx or docx_path
    doc = docx.Document(str(docx_path))
    info = apply_header_footer(doc, header, footer, page_numbers)
    bak = C.prepare_write(out)
    doc.save(str(out))
    return {"file": C.rel_path(out), "backup": C.rel_path(bak) if bak else None,
            **info, "validate": validate(out)}


def read_header_footer(docx_path: Path) -> dict:
    """读回每节的页眉页脚文字与域（验证用，不信自己的写入路径）。"""
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        names = zf.namelist()
        doc = etree.fromstring(zf.read("word/document.xml"))
        rels = {}
        rel_part = "word/_rels/document.xml.rels"
        if rel_part in names:
            for rel in etree.fromstring(zf.read(rel_part)):
                if str(rel.get("TargetMode")) == "External":
                    continue
                rels[rel.get("Id")] = _resolve_target("word", rel.get("Target", ""))
        out = []
        for sect in doc.iter(W + "sectPr"):
            item = {}
            for tag, kind in ((W + "headerReference", "header"), (W + "footerReference", "footer")):
                for ref in sect.findall(tag):
                    rid = ref.get(R + "id")
                    part = rels.get(rid)
                    if not part or part not in names:
                        continue
                    root = etree.fromstring(zf.read(part))
                    texts, fields = [], []
                    for t in root.iter(W + "t"):
                        if t.text:
                            texts.append(t.text)
                    for it in root.iter(W + "instrText"):
                        if it.text:
                            fields.append(it.text.strip())
                    item[kind] = {"part": part, "text": "".join(texts).strip(), "fields": fields}
            out.append(item)
    return {"file": C.rel_path(docx_path), "sections": out,
            "count": len(out)}


# ── 三线表 ─────────────────────────────────────────────────────────────────

def apply_table_style(doc, style: str) -> int:
    """`three-line`（学术三线表）或 `grid`（网格）。重跑幂等：边框整体重写。"""
    style = (style or "").lower()
    if style not in ("three-line", "threeline", "grid"):
        raise C.OfficeError("BadArg", f"不认识的表格样式：{style!r}",
                            next_steps=["支持 three-line（三线表）与 grid（网格表）"])
    style = "three-line" if style in ("three-line", "threeline") else "grid"
    changed = 0
    for tbl in doc.tables:
        tbl_pr = tbl._tbl.tblPr
        # 清掉表格样式，避免 style 里的边框盖过我们显式写的
        for el in list(tbl_pr.findall(W + "tblStyle")):
            tbl_pr.remove(el)
        if style == "three-line":
            _ooxml.set_table_borders(tbl_pr, top=12, bottom=12, inside_h=None, inside_v=None,
                                     left=None, right=None, color="000000")
            for row in tbl.rows:
                for cell in row.cells:
                    for edge in ("top", "bottom", "left", "right"):
                        _ooxml.set_cell_border(cell._tc, edge, None)
            for cell in tbl.rows[0].cells:   # 表头下的一条细线
                _ooxml.set_cell_border(cell._tc, "bottom", 6)
        else:
            _ooxml.set_table_borders(tbl_pr, top=6, bottom=6, inside_h=6, inside_v=6,
                                     left=6, right=6, color="C9D0D8")
            for row in tbl.rows:
                for cell in row.cells:
                    for edge in ("top", "bottom", "left", "right"):
                        _ooxml.set_cell_border(cell._tc, edge, None)
        changed += 1
    return changed


def set_table_style_file(docx_path: Path, out_docx: Path | None, style: str) -> dict:
    docx = _docx()
    out = out_docx or docx_path
    doc = docx.Document(str(docx_path))
    n = apply_table_style(doc, style)
    if not n:
        raise C.OfficeError("NoTable", f"{C.rel_path(docx_path)} 里没有表格可改",
                            next_steps=["先 `docx view --file a.docx` 确认文档里有表格"])
    bak = C.prepare_write(out)
    doc.save(str(out))
    return {"file": C.rel_path(out), "style": style, "tables": n,
            "backup": C.rel_path(bak) if bak else None, "validate": validate(out)}


# ── 分节 / 分栏 / 封面 ─────────────────────────────────────────────────────

def set_columns(doc, num: int, index: int | None = None) -> int:
    targets = [doc.sections[index]] if index is not None else list(doc.sections)
    for section in targets:
        _ooxml.section_columns(section._sectPr, num)
    return len(targets)


def set_columns_file(docx_path: Path, out_docx: Path | None, num: int,
                     index: int | None = None) -> dict:
    docx = _docx()
    out = out_docx or docx_path
    doc = docx.Document(str(docx_path))
    n = set_columns(doc, num, index)
    bak = C.prepare_write(out)
    doc.save(str(out))
    return {"file": C.rel_path(out), "columns": num, "sections_touched": n,
            "backup": C.rel_path(bak) if bak else None, "validate": validate(out)}


def add_cover(doc, title: str, subtitle: str | None = None, author: str | None = None,
              date_text: str | None = None) -> None:
    """封面页：大标题 + 副标题 + 作者 + 日期，纵向留白后分页。"""
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, RGBColor

    for _ in range(6):
        doc.add_paragraph()
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = par.add_run(title)
    run.bold = True
    run.font.size = Pt(30)
    _set_cjk(run)
    if subtitle:
        sp = doc.add_paragraph()
        sp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        srun = sp.add_run(subtitle)
        srun.font.size = Pt(14)
        srun.font.color.rgb = RGBColor(0x4A, 0x52, 0x60)
        _set_cjk(srun)
    for _ in range(6):
        doc.add_paragraph()
    for line in (author, date_text):
        if not line:
            continue
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(line)
        r.font.size = Pt(11)
        r.font.color.rgb = RGBColor(0x5A, 0x63, 0x70)
        _set_cjk(r)
    doc.add_page_break()


# ── 目录（TOC 域 + 真页码） ─────────────────────────────────────────────────

def _heading_paragraphs(doc, levels: tuple[int, int]) -> list[dict]:
    lo, hi = levels
    out = []
    for idx, par in enumerate(doc.paragraphs):
        name = (par.style.name or "") if par.style is not None else ""
        m = re.match(r"^Heading (\d)$", name)
        if m and lo <= int(m.group(1)) <= hi and par.text.strip():
            out.append({"index": idx, "level": int(m.group(1)), "text": par.text.strip(),
                        "para": par})
    return out


def _strip_existing_toc(doc) -> int:
    """摘掉上一次插的目录块（目录标题 + 整个 TOC 域，含域里的条目段）。"""
    from lxml import etree

    body = doc.element.body
    pars = list(body.findall(W + "p"))
    removed = 0
    for i, par in enumerate(pars):
        instr = "".join((it.text or "") for it in par.iter(W + "instrText")).strip()
        if not instr.upper().startswith("TOC"):
            continue
        start = i
        # 往上吞掉"目录"标题段
        if start - 1 >= 0:
            prev_text = "".join((t.text or "") for t in pars[start - 1].iter(W + "t")).strip()
            if prev_text in ("目录", "目 录", "Contents", "CONTENTS"):
                start -= 1
        # 从域开始往后找 fldChar end（目录条目在 begin→separate→end 之间）
        end = None
        depth = 0
        for j in range(i, len(pars)):
            for fc in pars[j].iter(W + "fldChar"):
                kind = fc.get(W + "fldCharType")
                if kind == "begin":
                    depth += 1
                elif kind == "end":
                    depth -= 1
                    if depth == 0:
                        end = j
                        break
            if end is not None:
                break
        if end is None:
            end = i
        for j in range(start, end + 1):
            if pars[j].getparent() is not None:
                pars[j].getparent().remove(pars[j])
                removed += 1
    return removed


def _toc_entry_paragraph(doc, text: str, page: str, level: int, anchor: str, right_twips: int):
    """一条目录目：超链接到书签 + 制表位 + PAGEREF 域（带缓存页码）。"""
    from lxml import etree

    from docx.shared import Pt

    par = doc.add_paragraph()
    par.paragraph_format.space_after = Pt(2)
    par.paragraph_format.left_indent = _docx().shared.Cm(0.0 + 0.6 * (level - 1))
    link = etree.SubElement(par._p, W + "hyperlink")
    link.set(W + "anchor", anchor)
    link.set(W + "history", "1")
    run = etree.SubElement(link, W + "r")
    rpr = etree.SubElement(run, W + "rPr")
    if level == 1:
        etree.SubElement(rpr, W + "b")
    t = etree.SubElement(run, W + "t")
    t.text = text
    t.set(XML_SPACE, "preserve")
    etree.SubElement(link, W + "r").append(etree.Element(W + "tab"))
    for el in _ooxml.field_runs(f" PAGEREF {anchor} \\h ", page):
        link.append(el)
    _ooxml.set_paragraph_tabs(par._p, right_twips)
    return par


def _pdf_page_texts(docx_path: Path) -> list[str] | None:
    """docx → PDF → 每页**正文区**文字。任何一步不可用就返回 None（调用方据此标 degraded）。

    为什么不整页取文字：页眉页脚会重复正文里的话（比如页眉写着文档标题，而正文一级标题
    就是同一个字符串），量页码时会把眉脚当成正文。这里按页面上下各留 7% 裁掉眉脚区。
    """
    import shutil
    import tempfile

    try:
        import pdfplumber

        import _lo
    except Exception:
        return None
    tmp = Path(tempfile.mkdtemp(prefix="office-toc-"))
    try:
        pdf = tmp / (docx_path.stem + ".pdf")
        _lo.convert(docx_path, pdf)
        out = []
        with pdfplumber.open(pdf) as doc:
            for page in doc.pages:
                text = ""
                try:
                    w, h = float(page.width), float(page.height)
                    body = page.crop((0, h * 0.07, w, h * 0.93))
                    text = body.extract_text() or ""
                except Exception:
                    text = page.extract_text() or ""
                out.append(text)
        return out
    except Exception:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _find_heading_pages(heads: list[dict], texts: list[str], skip: int = 0) -> dict[int, int]:
    """按文档顺序找每个标题落在第几页。

    取**从后往前**的第一次匹配（即最后一处出现）：封面的标题文字常与正文一级标题重名，
    取"第一次出现"会把封面当正文；目录页里的条目文字也同理（配合 `skip` 一起躲开）。
    实在找不到再退回"从前往后第一次"。
    """
    out: dict[int, int] = {}
    cursor = max(0, skip)
    for i, h in enumerate(heads):
        needle = re.sub(r"\s+", "", h["text"])[:24]
        if not needle:
            continue
        found = None
        for p in range(len(texts) - 1, cursor - 1, -1):
            if needle in re.sub(r"\s+", "", texts[p]):
                found = p
                break
        if found is None:
            for p in range(cursor, len(texts)):
                if needle in re.sub(r"\s+", "", texts[p]):
                    found = p
                    break
        if found is not None:
            out[i] = found + 1
            cursor = found
    return out


def insert_toc(docx_path: Path, out_docx: Path | None, levels: tuple[int, int] = (1, 3),
               after: str | None = None, with_pages: bool = True) -> dict:
    """插一份**真目录**：TOC 域（begin → 条目 → end，跨段）+ 每级标题书签 +
    PAGEREF 页码缓存 + `updateFields` 兜底。

    页码不是猜的：先量一遍（无目录）→ 插目录 → 再量一遍得出目录占了几页 →
    按位移修正页码 → 最后再量一遍**跳过目录页**核对（`verified`）。
    """
    from lxml import etree

    docx = _docx()
    out = out_docx or docx_path
    doc = docx.Document(str(docx_path))
    removed = _strip_existing_toc(doc)
    heads = _heading_paragraphs(doc, levels)
    if not heads:
        raise C.OfficeError(
            "NoHeadings",
            f"文档里没有 Heading {levels[0]}-{levels[1]} 级别的标题，目录没有内容可收",
            next_steps=["建文档时用 `## 标题`/`### 标题`；或先 `docx view` 看样式名"],
        )

    # 1) 标题挂书签（同一段已有 _Toc 书签就复用）
    used_ids = set()
    for el in doc.element.iter(W + "bookmarkStart"):
        try:
            used_ids.add(int(el.get(W + "id") or 0))
        except (TypeError, ValueError):
            pass
    next_id = max(used_ids, default=0) + 1
    for i, h in enumerate(heads):
        existing = None
        for bs in h["para"]._p.iter(W + "bookmarkStart"):
            if (bs.get(W + "name") or "").startswith("_Toc"):
                existing = bs.get(W + "name")
                break
        if existing:
            h["anchor"] = existing
            continue
        name = _ooxml.bookmark_name(h["text"], i)
        h["anchor"] = name
        _ooxml.wrap_with_bookmark(h["para"]._p, name, next_id)
        next_id += 1

    # 2) 先量一遍（还没有目录）
    probe = out.with_name(out.stem + ".toc-probe.docx")
    doc.save(str(probe))
    texts0 = _pdf_page_texts(probe) if with_pages else None
    probe.unlink(missing_ok=True)
    pages0 = _find_heading_pages(heads, texts0, 0) if texts0 else {}

    # 3) 造目录块：标题段 + 域开头段 + 条目段 + 域收尾段（每条都在 domain 的结果里）
    right_twips = int(_usable_cm(doc.sections[0]) / 2.54 * 1440) - 200
    title_par = doc.add_paragraph()
    trun = title_par.add_run("目录")
    trun.bold = True
    trun.font.size = _docx().shared.Pt(16)
    _set_cjk(trun)
    begin_par = doc.add_paragraph()
    for el in _ooxml.field_begin_runs(' TOC \\o "{}-{}" \\h \\z \\u '.format(*levels)):
        begin_par._p.append(el)
    entry_pars = [
        _toc_entry_paragraph(doc, h["text"], str(pages0.get(i, 1)), h["level"], h["anchor"],
                             right_twips)
        for i, h in enumerate(heads)
    ]
    end_par = doc.add_paragraph()
    for el in _ooxml.field_end_runs():
        end_par._p.append(el)

    # 4) 搬到第一个标题之前（有封面时自然落在封面之后），或锚点段之后
    move = [title_par._p, begin_par._p] + [p._p for p in entry_pars] + [end_par._p]
    if after:
        target = _find_paragraph(doc, after)
        if target is None:
            raise C.OfficeError("AnchorNotFound", f"找不到锚点段落：{after!r}",
                                next_steps=["先 docx view 看正文"])
        cur = target._p
        for el in move:
            cur.addnext(el)
            cur = el
    else:
        first_head = heads[0]["para"]._p
        for el in move:
            first_head.addprevious(el)

    settings = doc.settings.element
    _ooxml.ensure_update_fields(settings)
    bak = C.prepare_write(out)
    doc.save(str(out))

    # 5) 再量一遍：目录占了几页 → 页码整体位移 → 写回缓存值
    passes = 1
    pages_final = dict(pages0)
    if texts0:
        texts1 = _pdf_page_texts(out)
        if texts1:
            delta = len(texts1) - len(texts0)
            if delta:
                pages_final = {i: pages0[i] + delta for i in pages0}
                parts, names = _read_parts(out)
                root = etree.fromstring(parts["word/document.xml"])
                page_iter = iter(pages_final.get(i, 1) for i in range(len(heads)))
                for par in root.iter(W + "p"):
                    instrs = "".join((it.text or "") for it in par.iter(W + "instrText"))
                    if "PAGEREF" not in instrs:
                        continue
                    try:
                        newpage = str(next(page_iter))
                    except StopIteration:
                        break
                    for t in par.iter(W + "t"):
                        t.text = newpage
                parts["word/document.xml"] = _serialize(root)
                _write_parts(out, out, parts, names)
                passes = 2
    verified = None
    if texts0 and pages_final:
        texts_v = _pdf_page_texts(out)
        if texts_v:
            delta_v = len(texts_v) - len(texts0)
            pages_v = _find_heading_pages(heads, texts_v, skip=delta_v)
            verified = all(pages_v.get(i) == pages_final[i] for i in pages_final if i in pages_v)
    return {
        "file": C.rel_path(out),
        "backup": C.rel_path(bak) if bak else None,
        "entries": len(heads),
        "levels": list(levels),
        "removed_previous_toc": removed,
        "page_numbers": {i: pages_final.get(i) for i in sorted(pages_final)},
        "pages_measured": bool(texts0),
        "passes": passes,
        "verified": verified,
        "field": 'TOC \\o "{}-{}" \\h \\z \\u'.format(*levels),
        "validate": validate(out),
    }


# ── 脚注 ───────────────────────────────────────────────────────────────────

def _ensure_footnotes_part(parts: dict[str, bytes], names: list[str]) -> None:
    """确保 footnotes.xml 存在，并补齐内容类型/关系/样式。就地改 parts。"""
    from lxml import etree

    if "word/footnotes.xml" not in parts:
        parts["word/footnotes.xml"] = _serialize(_ooxml.footnotes_root())
        names.append("word/footnotes.xml")
    ct = etree.fromstring(parts["[Content_Types].xml"])
    if not any(str(o.get("PartName")) == "/word/footnotes.xml" for o in ct):
        o = etree.SubElement(ct, CT + "Override")
        o.set("PartName", "/word/footnotes.xml")
        o.set("ContentType", _ooxml.CT_FOOTNOTES)
        parts["[Content_Types].xml"] = _serialize(ct)
    rels_part = "word/_rels/document.xml.rels"
    if rels_part in parts:
        rroot = etree.fromstring(parts[rels_part])
        if not any(str(r.get("Type")) == _ooxml.REL_FOOTNOTES for r in rroot):
            rel = etree.SubElement(rroot, PR + "Relationship")
            rel.set("Id", _next_rid(rroot))
            rel.set("Type", _ooxml.REL_FOOTNOTES)
            rel.set("Target", "footnotes.xml")
            parts[rels_part] = _serialize(rroot)
    if "word/styles.xml" in parts:
        sroot = etree.fromstring(parts["word/styles.xml"])
        if _ooxml.ensure_footnote_styles(sroot):
            parts["word/styles.xml"] = _serialize(sroot)


def _footnote_ids(root) -> list[int]:
    out = []
    for fn in root.findall(W + "footnote"):
        fid = fn.get(W + "id")
        if fid is None:
            continue
        try:
            out.append(int(fid))
        except ValueError:
            continue
    return out


def add_footnote(docx_path: Path, anchor: str, text: str, out_docx: Path | None = None) -> dict:
    """在某段文字后面插一条**真脚注**（word/footnotes.xml + w:footnoteReference）。

    重跑幂等：同一条锚点 + 同一段文字已经存在时复用（不重复插）。
    """
    from lxml import etree

    out = out_docx or docx_path
    parts, names = _read_parts(docx_path)
    _ensure_footnotes_part(parts, names)
    root = etree.fromstring(parts["word/footnotes.xml"])
    existing = {}
    for fn in root.findall(W + "footnote"):
        if fn.get(W + "type"):
            continue
        existing.setdefault(str(fn.get(W + "id")), _para_text(fn))
    doc = etree.fromstring(parts["word/document.xml"])

    # 已经有一条同文字、且引用落在这段锚点所在段落里 → 复用
    for par in doc.iter(W + "p"):
        if anchor not in _para_text(par):
            continue
        for ref in par.iter(W + "footnoteReference"):
            fid = ref.get(W + "id")
            if existing.get(str(fid), "").strip() == text.strip():
                return {"file": C.rel_path(out), "footnote": {"id": fid, "text": text},
                        "reused": True, "footnotes_in_doc": len(existing),
                        "validate": validate(out)}

    target = None
    for par in doc.iter(W + "p"):
        if anchor in _para_text(par):
            target = par
            break
    if target is None:
        raise C.OfficeError(
            "AnchorNotFound", f"文档里找不到锚点文字：{anchor!r}",
            next_steps=["先 `docx view --file a.docx` 看真实文字，挑短而连续的一段"],
        )
    new_id = max([i for i in _footnote_ids(root) if i >= 0] or [0]) + 1
    _ooxml.add_footnote(root, new_id, text)
    # 锚点 run 之后插引用（找不到精确 run 就插在段末）
    ref_run = _ooxml.footnote_reference_run(new_id)
    placed = False
    for run in target.findall(W + "r"):
        if anchor in _para_text(run):
            run.addnext(ref_run)
            placed = True
            break
    if not placed:
        target.append(ref_run)
    parts["word/footnotes.xml"] = _serialize(root)
    parts["word/document.xml"] = _serialize(doc)
    _write_parts(docx_path, out, parts, names)

    readback = read_footnotes(out)
    mine = [f for f in readback["footnotes"] if f["id"] == str(new_id)]
    if not mine or mine[0]["text"].strip() != text.strip():
        raise C.OfficeError("FootnoteBroken", "脚注写进去了，但读回来对不上",
                            next_steps=["把这份 docx 与回执一起报给用户"],
                            detail={"footnotes": readback["footnotes"]})
    return {"file": C.rel_path(out), "footnote": {"id": str(new_id), "text": text,
                                                  "anchor": anchor, "placed_in_run": placed},
            "reused": False, "footnotes_in_doc": readback["count"],
            "references_in_body": readback["references"], "validate": validate(out)}


def read_footnotes(docx_path: Path) -> dict:
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        names = zf.namelist()
        if "word/footnotes.xml" not in names:
            return {"file": C.rel_path(docx_path), "count": 0, "footnotes": [],
                    "references": 0, "has_separators": False}
        root = etree.fromstring(zf.read("word/footnotes.xml"))
        doc = etree.fromstring(zf.read("word/document.xml"))
    seps = [fn.get(W + "type") for fn in root.findall(W + "footnote") if fn.get(W + "type")]
    out = []
    for fn in root.findall(W + "footnote"):
        if fn.get(W + "type"):
            continue
        out.append({"id": str(fn.get(W + "id")), "text": _para_text(fn).strip()})
    refs = [el.get(W + "id") for el in doc.iter(W + "footnoteReference")]
    return {"file": C.rel_path(docx_path), "count": len(out), "footnotes": out,
            "references": len(refs), "referenced_ids": refs,
            "has_separators": "separator" in seps and "continuationSeparator" in seps}


def _inject_footnote_markers(parts: dict[str, bytes], names: list[str],
                             notes: dict[str, str]) -> dict:
    """把正文里的 `⟦FN:id⟧` 占位换成真脚注引用，并把脚注写进 footnotes.xml。"""
    from lxml import etree

    if not notes:
        return {"injected": 0}
    _ensure_footnotes_part(parts, names)
    root = etree.fromstring(parts["word/footnotes.xml"])
    doc = etree.fromstring(parts["word/document.xml"])
    next_id = max([i for i in _footnote_ids(root) if i >= 0] or [0]) + 1
    by_key: dict[str, int] = {}
    injected = 0
    for t in list(doc.iter(W + "t")):
        text = t.text or ""
        if "\u27e6FN:" not in text:
            continue
        for key in list(notes):
            mark = FOOTNOTE_MARK.format(key)
            if mark not in text:
                continue
            before, _, after = text.partition(mark)
            run = t.getparent()
            parent = run.getparent()
            idx = parent.index(run)
            if key not in by_key:
                by_key[key] = next_id
                _ooxml.add_footnote(root, next_id, notes[key])
                next_id += 1
            if before:
                t.text = before
                anchor_el = run
            else:
                anchor_el = None
                parent.remove(run)
            ref = _ooxml.footnote_reference_run(by_key[key])
            if anchor_el is not None:
                anchor_el.addnext(ref)
                pos = parent.index(anchor_el) + 1
            else:
                parent.insert(idx, ref)
                pos = idx
            if after:
                tail = _clone_run_with_text(run, after)
                parent.insert(pos + 1, tail)
            injected += 1
            break
    parts["word/footnotes.xml"] = _serialize(root)
    parts["word/document.xml"] = _serialize(doc)
    return {"injected": injected, "footnote_ids": by_key}


def _clone_run_with_text(template, text: str):
    from copy import deepcopy
    from lxml import etree

    el = deepcopy(template)
    if el.getparent() is not None:
        el.getparent().remove(el)
    for child in list(el):
        if child.tag != W + "rPr":
            el.remove(child)
    t = etree.SubElement(el, W + "t")
    t.text = text
    t.set(XML_SPACE, "preserve")
    return el


# ── 书签 / 内链 ────────────────────────────────────────────────────────────

def add_bookmark(docx_path: Path, anchor: str, name: str | None = None,
                 out_docx: Path | None = None) -> dict:
    """给一段文字起书签（目录/内链的跳转目标）。重名会替换旧书签。"""
    from lxml import etree

    out = out_docx or docx_path
    parts, names = _read_parts(docx_path)
    doc = etree.fromstring(parts["word/document.xml"])
    target = None
    for par in doc.iter(W + "p"):
        if anchor in _para_text(par):
            target = par
            break
    if target is None:
        raise C.OfficeError("AnchorNotFound", f"文档里找不到锚点文字：{anchor!r}",
                            next_steps=["先 `docx view` 看正文"])
    used = []
    for bs in doc.iter(W + "bookmarkStart"):
        try:
            used.append(int(bs.get(W + "id") or 0))
        except (TypeError, ValueError):
            pass
    new_id = max(used, default=0) + 1
    bk_name = (name or _ooxml.bookmark_name(anchor, new_id)).strip().replace(" ", "_")[:40]
    # 同名旧书签先摘掉（幂等）
    replaced = 0
    for bs in list(doc.iter(W + "bookmarkStart")):
        if bs.get(W + "name") == bk_name:
            bid = bs.get(W + "id")
            parent = bs.getparent()
            if parent is not None:
                parent.remove(bs)
                replaced += 1
            for be in list(doc.iter(W + "bookmarkEnd")):
                if be.get(W + "id") == bid:
                    be.getparent().remove(be)
    wrapped = False
    for run in target.findall(W + "r"):
        if anchor in _para_text(run):
            start = etree.Element(W + "bookmarkStart")
            start.set(W + "id", str(new_id))
            start.set(W + "name", bk_name)
            end = etree.Element(W + "bookmarkEnd")
            end.set(W + "id", str(new_id))
            run.addprevious(start)
            run.addnext(end)
            wrapped = True
            break
    if not wrapped:
        _ooxml.wrap_with_bookmark(target, bk_name, new_id)
    parts["word/document.xml"] = _serialize(doc)
    _write_parts(docx_path, out, parts, names)
    return {"file": C.rel_path(out), "bookmark": {"name": bk_name, "id": str(new_id),
                                                  "anchor": anchor, "replaced": replaced,
                                                  "wrapped_run": wrapped},
            "validate": validate(out)}


def list_bookmarks(docx_path: Path) -> dict:
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        doc = etree.fromstring(zf.read("word/document.xml"))
    starts = {}
    for bs in doc.iter(W + "bookmarkStart"):
        starts[bs.get(W + "id")] = bs.get(W + "name")
    ends = {be.get(W + "id") for be in doc.iter(W + "bookmarkEnd")}
    out = [{"id": k, "name": v, "closed": k in ends} for k, v in starts.items()]
    return {"file": C.rel_path(docx_path), "count": len(out), "bookmarks": out}


# ── 公式（OMML）──────────────────────────────────────────────────────────

def add_equation(docx_path: Path, latex: str, anchor: str | None = None,
                 display: bool = True, out_docx: Path | None = None) -> dict:
    """插一条 Word 原生公式（OMML）。`display=True` 时独占一行。"""
    import _omml

    out = out_docx or docx_path
    try:
        math_el = _omml.to_omml(latex)
    except _omml.LatexError as exc:
        raise C.OfficeError(
            "BadLatex", f"这个公式我们解析不了：{exc}",
            next_steps=["支持的是 LaTeX 子集（上下标/分式/根式/求和积分/希腊字母/\\text{}）",
                        "矩阵与多行对齐（matrix/align/cases）请手写 OMML 或贴图"],
            detail={"latex": latex},
        ) from exc
    docx = _docx()
    doc = docx.Document(str(docx_path))
    if anchor:
        target = _find_paragraph(doc, anchor)
        if target is None:
            raise C.OfficeError("AnchorNotFound", f"找不到锚点段落：{anchor!r}",
                                next_steps=["先 docx view 看正文"])
        if display:
            from docx.enum.text import WD_ALIGN_PARAGRAPH
            from lxml import etree

            par = doc.add_paragraph()
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER
            para_el = etree.SubElement(par._p, M + "oMathPara")
            para_el.append(math_el)
            target._p.addnext(par._p)
        else:
            target._p.append(math_el)
    else:
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from lxml import etree

        par = doc.add_paragraph()
        if display:
            par.alignment = WD_ALIGN_PARAGRAPH.CENTER
            para_el = etree.SubElement(par._p, M + "oMathPara")
            para_el.append(math_el)
        else:
            par._p.append(math_el)
    bak = C.prepare_write(out)
    doc.save(str(out))
    count = count_equations(out)
    cjk = _omml.has_cjk(latex)
    return {"file": C.rel_path(out), "latex": latex, "display": display,
            "equations_in_doc": count, "cjk_in_formula": cjk,
            "backup": C.rel_path(bak) if bak else None, "validate": validate(out)}


def count_equations(docx_path: Path) -> int:
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        doc = etree.fromstring(zf.read("word/document.xml"))
    return len(list(doc.iter(M + "oMath")))


# ── 修订：删除 / 按 id 作者筛选 ─────────────────────────────────────────────

def track_delete(docx_path: Path, text: str, anchor: str | None, author: str,
                 out_docx: Path | None = None) -> dict:
    """把一段已有的文字标成**删除修订**（`w:del` + `w:delText`）。

    文字跨样式时会先按 XML 层把 run 一分为三，只把目标那段包进 `w:del`
    （不然整段都会被标成删除，那是另一回事）。
    """
    from copy import deepcopy
    from lxml import etree

    out = out_docx or docx_path
    doc = _doc_part(docx_path)
    target_run = None
    for run in doc.iter(W + "r"):
        if _para_text(run) == text:
            target_run = run
            break
    exact = target_run is not None
    if target_run is None:
        for run in doc.iter(W + "r"):
            if text in _para_text(run):
                target_run = run
                break
    if target_run is None:
        raise C.OfficeError(
            "AnchorNotFound", f"文档里找不到要删除的文字：{text!r}",
            next_steps=["先 `docx view` 看正文；跨样式的长句会被切成多个 run，挑一段短的"],
        )
    parent = target_run.getparent()
    new_id = _next_rev_id(doc)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _as_del(run_el):
        del_el = etree.Element(W + "del")
        del_el.set(W + "id", str(new_id))
        del_el.set(W + "author", author)
        del_el.set(W + "date", stamp)
        moved = deepcopy(run_el)
        for t in moved.findall(W + "t"):
            t.tag = W + "delText"
            t.set(XML_SPACE, "preserve")
        del_el.append(moved)
        return del_el

    if exact:
        target = _as_del(target_run)
        parent.replace(target_run, target)
        split = "exact-run"
    else:
        whole = _para_text(target_run)
        before, _, after = whole.partition(text)
        template = target_run
        pieces = []
        for chunk in (before, text, after):
            if not chunk:
                continue
            el = deepcopy(template)
            for child in list(el):
                if child.tag != W + "rPr":
                    el.remove(child)
            t = etree.SubElement(el, W + "t")
            t.text = chunk
            t.set(XML_SPACE, "preserve")
            pieces.append(el)
        # before | del(anchor) | after 依次插在原位置
        cur = target_run
        for el in pieces:
            if _para_text(el) == text:
                new_el = _as_del(el)
            else:
                new_el = el
            cur.addnext(new_el)
            cur = new_el
        parent.remove(target_run)
        split = "split-run"
    xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
    _rewrite(docx_path, out, {"word/document.xml": xml})
    revs = list_revisions(out)
    mine = [r for r in revs["revisions"] if r["id"] == str(new_id)]
    if not mine or mine[0]["kind"] != "delete":
        raise C.OfficeError("RevisionBroken", "删除修订写进去了，但读回来不是 delete",
                            next_steps=["把这份 docx 与回执报给用户"],
                            detail={"revisions": revs["revisions"]})
    return {"file": C.rel_path(out), "mode": "delete", "id": str(new_id), "author": author,
            "date": stamp, "text": text, "split": split,
            "deleted_text": mine[0]["text"], "revisions": revs}


def resolve_revisions_filtered(docx_path: Path, accept: bool, out_docx: Path | None = None,
                               ids: list[str] | None = None,
                               authors: list[str] | None = None) -> dict:
    """接受/拒绝修订，可按 `--id` / `--author` 挑（不给就是全部）。"""
    from lxml import etree

    out = out_docx or docx_path
    doc = _doc_part(docx_path)
    want_ids = {str(i) for i in (ids or [])}
    want_authors = {a for a in (authors or []) if a}
    kept, dropped, skipped = [], [], []
    for tag, kind in ((W + "ins", "insert"), (W + "del", "delete")):
        for el in list(doc.iter(tag)):
            rid = el.get(W + "id")
            author = el.get(W + "author") or ""
            if want_ids and str(rid) not in want_ids:
                skipped.append({"kind": kind, "id": rid, "author": author, "why": "id 不匹配"})
                continue
            if want_authors and author not in want_authors:
                skipped.append({"kind": kind, "id": rid, "author": author, "why": "作者不匹配"})
                continue
            text = _para_text(el)
            parent = el.getparent()
            if parent is not None and parent.tag == W + "rPr":
                parent.remove(el)
                continue
            action = ("accept" if accept else "drop") if kind == "insert" else \
                     ("drop" if accept else "accept")
            if action == "drop":
                if parent is not None:
                    parent.remove(el)
                    dropped.append({"kind": kind, "id": rid, "author": author, "text": text})
            else:
                if kind == "delete":
                    if parent is not None:
                        parent.remove(el)
                        dropped.append({"kind": kind, "id": rid, "author": author, "text": text})
                    continue
                if parent is not None:
                    idx = parent.index(el)
                    for child in list(el):
                        parent.insert(idx, child)
                        idx += 1
                    parent.remove(el)
                    kept.append({"kind": kind, "id": rid, "author": author, "text": text})
    xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
    _rewrite(docx_path, out, {"word/document.xml": xml})
    remaining = list_revisions(out)
    return {"file": C.rel_path(out), "mode": "accept" if accept else "reject",
            "filter": {"ids": sorted(want_ids), "authors": sorted(want_authors)},
            "kept": kept, "dropped": dropped, "skipped": skipped[:20],
            "skipped_count": len(skipped), "remaining": remaining["count"]}


# ── 批注批量计划 ───────────────────────────────────────────────────────────

def run_comment_ops(docx_path: Path, ops: list[dict], out_docx: Path | None = None,
                    dry_run: bool = False) -> dict:
    """一次跑一串批注操作：add / reply / resolve / unresolve（可选先预演）。

    每条操作都会先**验证**（锚点是否存在、批注 id 是否存在），预演时把结论列出来不落盘。
    """
    import shutil
    import tempfile

    out = out_docx or docx_path
    planned, done = [], []
    work = Path(tempfile.mkdtemp(prefix="office-cops-")) / "work.docx"
    shutil.copy2(docx_path, work)
    try:
        for idx, op in enumerate(ops):
            kind = str(op.get("op") or "").strip().lower()
            entry = {"index": idx, "op": kind}
            try:
                if kind == "add":
                    if not op.get("anchor"):
                        raise C.OfficeError("BadArg", "add 需要 anchor")
                    res = add_comment(work, op["anchor"], op.get("text", ""),
                                      op.get("author") or "Irmia", None)
                    entry.update(id=res["comment"]["id"], ok=True)
                elif kind == "reply":
                    res = add_reply(work, op.get("id"), op.get("text", ""),
                                    op.get("author") or "Irmia", None)
                    entry.update(id=res["reply"]["id"], parent=res["reply"]["parent"], ok=True)
                elif kind in ("resolve", "unresolve"):
                    res = resolve_comment(work, op.get("id"), undo=(kind == "unresolve"), out_docx=None)
                    entry.update(id=res["id"], resolved=res["resolved"], ok=True)
                else:
                    raise C.OfficeError("BadArg", f"不认识的操作：{kind!r}",
                                        next_steps=["支持 add / reply / resolve / unresolve"])
            except C.OfficeError as err:
                entry.update(ok=False, error={"code": err.code, "message": err.message,
                                              "next": err.next_steps})
            planned.append(entry)
            if not entry.get("ok") and not dry_run:
                raise C.OfficeError(
                    "CommentOpFailed",
                    f"第 {idx + 1} 条操作失败：{entry['error']['code']} {entry['error']['message']}",
                    next_steps=["先 --dry-run 看哪条不过，再改计划文件"],
                    detail={"plan": planned},
                )
            if entry.get("ok"):
                done.append(entry)
        if dry_run:
            return {"file": C.rel_path(docx_path), "dry_run": True, "plan": planned,
                    "ok_count": len(done), "fail_count": len(planned) - len(done),
                    "would_write": str(out) != str(docx_path)}
        bak = C.prepare_write(out)
        shutil.copy2(work, out)
        readback = read_comments(out)
        return {"file": C.rel_path(out), "dry_run": False, "plan": planned,
                "ok_count": len(done), "fail_count": 0,
                "backup": C.rel_path(bak) if bak else None,
                "comments_in_doc": readback["count"],
                "resolved_count": readback["resolved_count"],
                "replies": readback["replies"], "validate": validate(out)}
    finally:
        shutil.rmtree(work.parent, ignore_errors=True)


# ── 校验 ────────────────────────────────────────────────────────────────────


def validate(docx_path: Path) -> dict:
    """OPC 结构 + XML 良构 + 关系可达 + 语义抽查 → pass / pass_with_warnings / fail。"""
    from lxml import etree

    errors: list[str] = []
    warnings: list[str] = []
    info: dict = {}

    if docx_path.suffix.lower() != ".docx":
        warnings.append(f"扩展名是 {docx_path.suffix}，不是 .docx")
    try:
        zf = zipfile.ZipFile(docx_path)
    except zipfile.BadZipFile as exc:
        return {"status": "fail", "errors": [f"不是合法 ZIP：{exc}"], "warnings": [], "info": {}}

    names = set(zf.namelist())
    with zf:
        if "word/document.xml" not in names:
            errors.append("缺 word/document.xml —— 这不是一个 Word 文档")
        if "[Content_Types].xml" not in names:
            errors.append("缺 [Content_Types].xml —— OPC 包不完整")

        # ① XML 良构
        bad_xml = []
        for name in sorted(names):
            if not name.endswith((".xml", ".rels")):
                continue
            try:
                etree.fromstring(zf.read(name))
            except etree.XMLSyntaxError as exc:
                bad_xml.append(f"{name}: {exc}")
        if bad_xml:
            errors.extend(bad_xml[:5])

        # ② 内容类型覆盖
        overrides = {}
        defaults = {}
        if "[Content_Types].xml" in names:
            ct = etree.fromstring(zf.read("[Content_Types].xml"))
            for el in ct:
                if el.tag == CT + "Override":
                    overrides[el.get("PartName", "").lstrip("/")] = el.get("ContentType")
                elif el.tag == CT + "Default":
                    defaults[el.get("Extension", "").lower()] = el.get("ContentType")
            for name in names:
                if name == "[Content_Types].xml" or name.endswith("/"):
                    continue
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if name not in overrides and ext not in defaults:
                    warnings.append(f"{name} 没有内容类型声明（Word 可能拒绝打开）")
            info["content_types"] = {"overrides": len(overrides), "defaults": len(defaults)}

        # ③ 关系可达
        missing_targets = []
        rel_count = 0
        for name in names:
            if not name.endswith(".rels"):
                continue
            base = name.rsplit("/_rels/", 1)[0] if "/_rels/" in name else ""
            try:
                root = etree.fromstring(zf.read(name))
            except etree.XMLSyntaxError:
                continue
            for rel in root:
                if rel.tag != PR + "Relationship":
                    continue
                rel_count += 1
                if rel.get("TargetMode") == "External":
                    continue
                target = rel.get("Target", "")
                resolved = _resolve_target(base, target)
                if resolved not in names:
                    missing_targets.append(f"{name} → {target}")
        if missing_targets:
            errors.append(f"关系指向不存在的部件 {len(missing_targets)} 处：{missing_targets[:4]}")
        info["relationships"] = rel_count

        # ④ 语义抽查
        if "word/document.xml" in names:
            doc = etree.fromstring(zf.read("word/document.xml"))
            styles_defined = set()
            if "word/styles.xml" in names:
                sroot = etree.fromstring(zf.read("word/styles.xml"))
                styles_defined = {s.get(W + "styleId") for s in sroot.findall(W + "style")}
            used = {el.get(W + "val") for el in doc.iter(W + "pStyle")}
            used.discard(None)
            undefined = sorted(s for s in used if s not in styles_defined)
            if undefined:
                warnings.append(f"引用了未定义的段落样式：{undefined[:6]}（Word 会用默认样式顶上）")
            info["styles"] = {"defined": len(styles_defined), "used": len(used), "undefined": undefined}

            body = doc.find(W + "body")
            if body is None:
                errors.append("document.xml 里没有 w:body")
            else:
                if body.find(W + "sectPr") is None:
                    warnings.append("没有 w:sectPr —— 页面尺寸/页边距会走默认值")
                tables = body.findall(W + "tbl")
                paras = body.findall(W + "p")
                info["body"] = {"paragraphs": len(paras), "tables": len(tables),
                                "sections": len(body.findall(W + "sectPr"))}
                for ti, tbl in enumerate(tables):
                    grid = tbl.find(W + "tblGrid")
                    declared = len(grid.findall(W + "gridCol")) if grid is not None else 0
                    for ri, tr in enumerate(tbl.findall(W + "tr")):
                        cells = tr.findall(W + "tc")
                        span = sum(int(tc.find(W + "tcPr/" + W + "gridSpan").get(W + "val", "1"))
                                   if tc.find(W + "tcPr/" + W + "gridSpan") is not None else 1
                                   for tc in cells)
                        if declared and span > declared:
                            warnings.append(f"表 {ti + 1} 第 {ri + 1} 行有 {span} 列 > 声明的 {declared}")
                            break
            # 批注 / 修订的引用是否自洽
            comments_xml = "word/comments.xml"
            if comments_xml in names:
                croot = etree.fromstring(zf.read(comments_xml))
                ids = {c.get(W + "id") for c in croot.findall(W + "comment")}
                starts = {el.get(W + "id") for el in doc.iter(W + "commentRangeStart")}
                ends = {el.get(W + "id") for el in doc.iter(W + "commentRangeEnd")}
                dangling = sorted(x for x in starts | ends if x not in ids)
                if dangling:
                    errors.append(f"批注范围引用了不存在的批注 id：{dangling}")
                unclosed = sorted(x for x in starts if x not in ends)
                if unclosed:
                    warnings.append(f"批注范围只开不闭：{unclosed}")
                info["comments"] = len(ids)
            ins = list(doc.iter(W + "ins"))
            dele = list(doc.iter(W + "del"))
            if ins or dele:
                info["revisions"] = {"ins": len(ins), "del": len(dele)}

        # ⑤ 危险/异常痕量
        if "word/document.xml" in names:
            doc = etree.fromstring(zf.read("word/document.xml"))
            if doc.find(".//" + W + "altChunk") is not None:
                warnings.append("文档里有 altChunk（内嵌 HTML/MHT），多数阅读器会忽略")
            ext_rels = [n for n in names if n.endswith(".rels") and b'TargetMode="External"' in zf.read(n)]
            if ext_rels:
                warnings.append(f"{len(ext_rels)} 个关系文件里有外部链接（可能触发隐私提示）")

        # ⑥ 深检查：元素顺序 / sectPr 位置 / 批注扩展链 / 书签配对 / 缩放 / xml:space / 插图
        deep_err, deep_warn, deep_stats = _deep_checks(zf, names)
        errors.extend(deep_err)
        warnings.extend(deep_warn)
        info["deep"] = deep_stats

    info["parts"] = len(names)
    info["bytes"] = docx_path.stat().st_size
    status = "fail" if errors else ("pass_with_warnings" if warnings else "pass")
    return {"status": status, "errors": errors, "warnings": warnings, "info": info}


def _deep_checks(zf, names) -> tuple[list[str], list[str], dict]:
    """不跑 XSD，但把"XML 改坏了 Word 会拒绝打开/会弹修复"的那几类结构约束查掉。

    查这些（都有实测判据，见 docs/office-skill.md 的对齐表）：
      ① `w:pPr`/`w:rPr`/`w:tcPr`/`w:tblPr` 的内部**顺序**（ECMA-376 是 sequence，不是 all）
      ② `w:p` 里 `w:pPr` 必须第一个、`w:r` 里 `w:rPr` 必须第一个、`w:tbl` 里 `w:tblPr`/`w:tblGrid` 必须在前
      ③ `w:body` 的 `w:sectPr` 必须是最后一个块
      ④ 批注扩展链 `commentsExtended` 的 paraId 自洽（回复指向的父批注、重复 id、关系/内容类型）
      ⑤ 书签 start/end 配对、id 重复
      ⑥ `w:zoom` 缺 `w:percent`、`w:t` 首尾空格缺 `xml:space="preserve"`
      ⑦ 插图：有 drawing 就必须有 `word/media/*`；`wp:docPr` 有没有 alt 文本
    """
    from lxml import etree

    errors: list[str] = []
    warnings: list[str] = []
    stats: dict = {"checks": ["property_order", "first_child", "tbl_shape", "sectpr_position",
                             "comments_extended", "bookmarks", "zoom", "xml_space", "media"]}
    if "word/document.xml" not in names:
        return errors, warnings, stats
    doc = etree.fromstring(zf.read("word/document.xml"))

    # ① 属性容器的顺序
    order_bad: list[str] = []
    for tag, order in ((W + "pPr", PPR_ORDER), (W + "rPr", RPR_ORDER),
                       (W + "tcPr", TCPR_ORDER), (W + "tblPr", TBLPR_ORDER)):
        label = tag.rsplit("}", 1)[-1]
        stats[label] = 0
        for el in doc.iter(tag):
            stats[label] += 1
            order_bad.extend(_check_order(el, order, label, limit=1))
            if len(order_bad) >= 3:
                break
        if len(order_bad) >= 3:
            break
    if order_bad:
        warnings.append("有属性容器的子元素顺序不符合 schema（Word 可能提示「内容有问题」）："
                        + "；".join(order_bad[:3]) + "。改 XML 时按 pPr/rPr/tcPr 的 schema 顺序插")

    # ② 必需的首位元素
    ppr_bad = sum(1 for el in doc.iter(W + "p")
                  if len(el) and any(c.tag == W + "pPr" for c in el) and el[0].tag != W + "pPr")
    if ppr_bad:
        errors.append(f"{ppr_bad} 个段落里 w:pPr 不是第一个子元素（Word 会拒绝打开这类文档）")
    rpr_bad = sum(1 for el in doc.iter(W + "r")
                  if len(el) and any(c.tag == W + "rPr" for c in el) and el[0].tag != W + "rPr")
    if rpr_bad:
        errors.append(f"{rpr_bad} 个 run 里 w:rPr 不是第一个子元素")

    tbl_bad = []
    for tbl in doc.iter(W + "tbl"):
        kids = [c.tag for c in tbl]
        if W + "tblPr" in kids and kids.index(W + "tblPr") != 0:
            tbl_bad.append("w:tblPr 不在第一位")
        elif W + "tblGrid" in kids and kids.index(W + "tblGrid") > 1:
            tbl_bad.append("w:tblGrid 不在第二位")
    if tbl_bad:
        errors.append(f"{len(tbl_bad)} 张表的 tblPr/tblGrid 位置不对（Word 会报内容错误）")

    # ③ sectPr 位置
    body = doc.find(W + "body")
    if body is not None:
        children = list(body)
        sect_pos = [i for i, c in enumerate(children) if c.tag == W + "sectPr"]
        if sect_pos and sect_pos[-1] != len(children) - 1:
            errors.append("w:body 里 w:sectPr 后面还有别的块（schema 要求 sectPr 是最后一个）")

    # ④ 批注扩展链
    comments_part, ext_part = "word/comments.xml", "word/commentsExtended.xml"
    comment_para_ids: dict[str, str] = {}
    if comments_part in names:
        croot = etree.fromstring(zf.read(comments_part))
        for c in croot.findall(W + "comment"):
            ps = c.findall(W + "p")
            pid = ps[0].get(W14 + "paraId") if ps else None
            comment_para_ids[str(c.get(W + "id"))] = pid or ""
        if ext_part in names:
            known = {pid for pid in comment_para_ids.values() if pid}
            if len(known) != len([p for p in comment_para_ids.values() if p]):
                errors.append("comments.xml 里有两段批注用了同一个 w14:paraId")
            eroot = etree.fromstring(zf.read(ext_part))
            seen: set[str] = set()
            for ex in eroot:
                pid = ex.get(W15 + "paraId")
                parent = ex.get(W15 + "paraIdParent")
                done = ex.get(W15 + "done")
                if not pid:
                    errors.append("commentsExtended 里有一条没有 w15:paraId")
                    continue
                if pid in seen:
                    errors.append(f"commentsExtended 里 w15:paraId 重复：{pid}")
                seen.add(pid)
                if pid not in known:
                    errors.append(f"commentsExtended 的 paraId={pid} 在 comments.xml 里找不到对应批注段落")
                if parent and parent not in known:
                    errors.append(f"批注回复指向的 paraId={parent} 不存在（Word 会显示成孤立批注）")
                if done not in (None, "0", "1", "true", "false"):
                    warnings.append(f"批注 {pid} 的 w15:done 值不合法：{done!r}")
            no_entry = [cid for cid, pid in comment_para_ids.items() if pid and pid not in seen]
            if no_entry:
                warnings.append(f"{len(no_entry)} 条批注在 commentsExtended 里没有条目"
                                "（回复/已解决状态不会显示）")
            rels = "word/_rels/document.xml.rels"
            if rels in names:
                rroot = etree.fromstring(zf.read(rels))
                linked = any(str(r.get("Type")) == REL_COMMENTS_EXT
                             or str(r.get("Target")) == "commentsExtended.xml" for r in rroot)
                if not linked:
                    errors.append("commentsExtended.xml 存在但没有对应的关系项"
                                  "（word/_rels/document.xml.rels 里缺 commentsExtended 关系）")

    # ⑤ 书签配对
    starts = [el.get(W + "id") for el in doc.iter(W + "bookmarkStart")]
    ends = [el.get(W + "id") for el in doc.iter(W + "bookmarkEnd")]
    unclosed = sorted({s for s in starts if s not in set(ends)})
    orphan = sorted({e for e in ends if e not in set(starts)})
    dup = sorted({s for s in starts if starts.count(s) > 1})
    if unclosed:
        warnings.append(f"书签只开不闭：{unclosed[:6]}")
    if orphan:
        warnings.append(f"书签只有结束没有开始：{orphan[:6]}")
    if dup:
        errors.append(f"书签 w:id 重复：{dup[:6]}（Word 会报内容错误）")

    # ⑥ zoom / xml:space
    if "word/settings.xml" in names:
        sroot = etree.fromstring(zf.read("word/settings.xml"))
        for z in sroot.iter(W + "zoom"):
            if z.get(W + "percent") is None:
                warnings.append("w:zoom 缺 w:percent（Word 会按 100% 顶上，改缩放会失效）")
    lost_space = sum(1 for t in doc.iter(W + "t")
                     if (t.text or "") != (t.text or "").strip() and t.get(XML_SPACE) != "preserve")
    if lost_space:
        warnings.append(f"{lost_space} 个 w:t 首尾有空格但没写 xml:space=\"preserve\"（Word 会吞掉空格）")

    # ⑦ 插图
    drawings = list(doc.iter(W + "drawing"))
    media = [n for n in names if n.startswith("word/media/")]
    if drawings and not media:
        errors.append(f"文档里有 {len(drawings)} 个 w:drawing，但包里一个 word/media/* 都没有（图丢了）")
    no_alt = sum(1 for dp in doc.iter(WP + "docPr") if not (dp.get("descr") or dp.get("title")))
    if no_alt:
        warnings.append(f"{no_alt} 张插图没有 alt 文本（无障碍阅读器/纯文本导出只能看到占位）")
    stats["drawings"] = len(drawings)
    stats["media"] = len(media)
    stats["bookmarks"] = len(starts)
    stats["comments_extended"] = ext_part in names
    return errors, warnings, stats


def _resolve_target(base: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    parts = (base + "/" + target).split("/") if base else target.split("/")
    stack = []
    for p in parts:
        if p in ("", "."):
            continue
        if p == "..":
            if stack:
                stack.pop()
        else:
            stack.append(p)
    return "/".join(stack)


# ── 预览 / 拆包 ─────────────────────────────────────────────────────────────


def view(docx_path: Path) -> dict:
    """给模型读的文本视图：块序号 / 类型 / 样式 / 文字 / 表格尺寸。"""
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        if "word/document.xml" not in zf.namelist():
            raise C.OfficeError("NotADocx", f"{C.rel_path(docx_path)} 里没有 word/document.xml")
        doc = etree.fromstring(zf.read("word/document.xml"))
    body = doc.find(W + "body")
    lines: list[str] = []
    para_count = table_count = 0
    chars = 0
    has_cjk = False
    idx = 0
    for child in (body if body is not None else []):
        if child.tag == W + "p":
            para_count += 1
            idx += 1
            style_el = child.find(W + "pPr/" + W + "pStyle")
            style = style_el.get(W + "val") if style_el is not None else ""
            text = _para_text(child)
            chars += len(text)
            if re.search(r"[\u4e00-\u9fff]", text):
                has_cjk = True
            mark = f"[{idx:03d}] P"
            if text.strip():
                lines.append(f"{mark} {('<'+style+'> ') if style else ''}{text}")
        elif child.tag == W + "tbl":
            table_count += 1
            idx += 1
            rows = child.findall(W + "tr")
            cols = len(rows[0].findall(W + "tc")) if rows else 0
            lines.append(f"[{idx:03d}] TABLE {len(rows)}×{cols}")
            for ri, tr in enumerate(rows[:6]):
                cells = [_para_text(tc).strip() for tc in tr.findall(W + "tc")]
                lines.append("      | " + " | ".join(cells))
                if ri == 5 and len(rows) > 6:
                    lines.append(f"      … 还有 {len(rows) - 6} 行")
        elif child.tag == W + "sectPr":
            idx += 1
            lines.append(f"[{idx:03d}] SECTION-PROPS")
    text_view = "\n".join(lines)
    return {
        "file": C.rel_path(docx_path),
        "paragraph_count": para_count,
        "table_count": table_count,
        "chars": chars,
        "has_cjk": has_cjk,
        "blocks": idx,
        "view": text_view,
    }


def _para_text(el) -> str:
    out = []
    for node in el.iter():
        if node.tag == W + "t" and node.text:
            out.append(node.text)
        elif node.tag == W + "delText" and node.text:
            out.append(node.text)
        elif node.tag == W + "tab":
            out.append("\t")
        elif node.tag == W + "br":
            out.append("\n")
    return "".join(out)


def prep(docx_path: Path, out_dir: Path) -> dict:
    """拆包 + view.txt + manifest（每部件大小与 sha1），给"改 XML"那条路用。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    unpacked = out_dir / "unpacked"
    unpacked.mkdir(parents=True, exist_ok=True)
    manifest = []
    with zipfile.ZipFile(docx_path) as zf:
        for item in zf.infolist():
            if item.is_dir():
                continue
            data = zf.read(item.filename)
            dst = unpacked / item.filename
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            manifest.append({
                "part": item.filename,
                "bytes": len(data),
                "sha1": hashlib.sha1(data).hexdigest()[:16],
                "xml": item.filename.endswith((".xml", ".rels")),
            })
    viewinfo = view(docx_path)
    vp = out_dir / "view.txt"
    C.prepare_write(vp)
    vp.write_text(viewinfo["view"], encoding="utf-8")
    mp = out_dir / "manifest.json"
    C.prepare_write(mp)
    import json as _json

    mp.write_text(_json.dumps({"source": C.rel_path(docx_path), "parts": manifest,
                               "view_stats": {k: v for k, v in viewinfo.items() if k != "view"}},
                              ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "source": C.rel_path(docx_path),
        "unpacked_dir": C.rel_path(unpacked),
        "parts": len(manifest),
        "view_txt": C.rel_path(vp),
        "manifest": C.rel_path(mp),
        "view_stats": {k: v for k, v in viewinfo.items() if k != "view"},
    }


def xml_slice(docx_path: Path, part: str = "word/document.xml", xpath: str | None = None,
              start: int = 0, length: int = 8000, pretty: bool = False) -> dict:
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        names = zf.namelist()
        if part not in names:
            raise C.OfficeError(
                "PartNotFound",
                f"包里没有这个部件：{part}",
                next_steps=[f"可用部件前 10 个：{names[:10]}", "先跑 `docx prep` 看 manifest.json"],
            )
        raw = zf.read(part)
    if xpath:
        root = etree.fromstring(raw)
        ns = {"w": W[1:-1], "r": REL_NS, "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
        hits = root.xpath(xpath, namespaces=ns)
        text = "\n\n".join(
            etree.tostring(h, encoding="unicode", pretty_print=True) if hasattr(h, "tag") else str(h)
            for h in hits
        )
        return {"part": part, "xpath": xpath, "hits": len(hits),
                "xml": text[:length], "total_chars": len(text), "truncated": len(text) > length}
    if pretty:
        text = etree.tostring(etree.fromstring(raw), encoding="unicode", pretty_print=True)
    else:
        text = raw.decode("utf-8", "replace")
    return {"part": part, "bytes": len(raw), "slice": text[start : start + length],
            "total_chars": len(text), "start": start, "length": length}


# ── 打包 / 比对 ─────────────────────────────────────────────────────────────


def pack(unpacked_dir: Path, out_docx: Path) -> dict:
    """把 `docx prep` 拆出来的目录重新打成 docx，并立刻过一遍校验。

    改 XML 的流程就是：`prep` → 改 `unpacked/word/document.xml` → `pack` → `validate`。
    """
    if not (unpacked_dir / "[Content_Types].xml").exists():
        raise C.OfficeError(
            "NotAnOpcDir",
            f"{C.rel_path(unpacked_dir)} 里没有 [Content_Types].xml，这不像拆出来的 docx 目录",
            next_steps=["拆包用 `docx prep --file a.docx --out work/`，它会产出 work/unpacked/"],
        )
    if not (unpacked_dir / "word" / "document.xml").exists():
        raise C.OfficeError("NotAnOpcDir", "目录里没有 word/document.xml")
    C.prepare_write(out_docx)
    files = [p for p in unpacked_dir.rglob("*") if p.is_file()]
    # [Content_Types].xml 放第一个：不是硬性要求，但这样更像 Office 自己产出的包
    files.sort(key=lambda p: (p.relative_to(unpacked_dir).as_posix() != "[Content_Types].xml",
                              p.relative_to(unpacked_dir).as_posix()))
    with zipfile.ZipFile(out_docx, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(f, f.relative_to(unpacked_dir).as_posix())
    report = validate(out_docx)
    return {"out": C.rel_path(out_docx), "bytes": out_docx.stat().st_size,
            "parts": len(files), "validate": report}


def diff(before: Path, after: Path, max_items: int = 40) -> dict:
    """比对两个 docx：部件级增删改 + 正文文字级差异（改完 XML 后"到底动了什么"）。"""
    import difflib

    def _parts(path: Path) -> dict[str, str]:
        out = {}
        with zipfile.ZipFile(path) as zf:
            for item in zf.infolist():
                if item.is_dir():
                    continue
                out[item.filename] = hashlib.sha1(zf.read(item.filename)).hexdigest()
        return out

    a, b = _parts(before), _parts(after)
    added = sorted(set(b) - set(a))
    removed = sorted(set(a) - set(b))
    changed = sorted(k for k in set(a) & set(b) if a[k] != b[k])

    def _texts(path: Path) -> list[str]:
        try:
            doc = _doc_part(path)
        except Exception:
            return []
        body = doc.find(W + "body")
        if body is None:
            return []
        return [_para_text(p) for p in body.findall(W + "p")]

    ta, tb = _texts(before), _texts(after)
    delta = list(difflib.unified_diff(ta, tb, fromfile="before", tofile="after", lineterm="", n=0))
    return {
        "before": C.rel_path(before),
        "after": C.rel_path(after),
        "parts": {"added": added, "removed": removed, "changed": changed},
        "structure_changed": bool(added or removed),
        "text_diff_lines": delta[:max_items],
        "text_diff_truncated": len(delta) > max_items,
        "paragraphs": {"before": len(ta), "after": len(tb)},
        "identical": not (added or removed or changed),
    }


# ── 批注 ────────────────────────────────────────────────────────────────────


def _read_parts(path: Path) -> tuple[dict[str, bytes], list[str]]:
    with zipfile.ZipFile(path) as zf:
        names = [i.filename for i in zf.infolist() if not i.is_dir()]
        parts = {n: zf.read(n) for n in names}
    return parts, names


def _atomic_replace(tmp: Path, out: Path, tries: int = 6) -> None:
    """Windows 上 `os.replace` 偶尔会因为杀软/索引器短暂持有句柄而报 WinError 5。

    重试几次就好；实在不行给一条能看懂的错（别丢 `InternalError` 那种没头绪的）。
    """
    import time

    last: Exception | None = None
    for attempt in range(tries):
        try:
            tmp.replace(out)
            return
        except PermissionError as exc:
            last = exc
            time.sleep(0.12 * (attempt + 1))
        except OSError as exc:
            last = exc
            time.sleep(0.12 * (attempt + 1))
    raise C.OfficeError(
        "WriteFailed",
        f"替换输出文件失败：{C.rel_path(out)}（{type(last).__name__}: {last}）",
        next_steps=["把目标文件在 Word/预览器里关掉再重跑",
                    "或者换一个 --out 文件名",
                    "杀软/同步盘（OneDrive）在扫这个目录时也会短暂锁文件"],
    )


def _write_parts(src: Path, out: Path, parts: dict[str, bytes], names: list[str]) -> Path:
    """按原顺序重打一个包（新增的部件追加在后面，[Content_Types].xml 放最前）。"""
    order = [n for n in names if n in parts]
    order += [n for n in parts if n not in order]
    if "[Content_Types].xml" in order:
        order.remove("[Content_Types].xml")
        order.insert(0, "[Content_Types].xml")
    C.ensure_parent(out)
    tmp = out.with_name(out.name + ".tmp-pkg")
    tmp.unlink(missing_ok=True)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in order:
            zf.writestr(name, parts[name])
    C.prepare_write(out)
    _atomic_replace(tmp, out)
    return out


def _serialize(root) -> bytes:
    from lxml import etree

    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _para_id(cid) -> str:
    """批注段落的 w14:paraId。**由批注 id 派生**，所以重跑得到同一个值（幂等）。

    w14:paraId 是 ST_LongHexNumber，Word 自己用的都在 0x1xxxxxxx 一带；0 非法。
    """
    try:
        n = int(str(cid))
    except (TypeError, ValueError):
        n = abs(hash(str(cid))) % 0xFFFF
    return f"{(0x1A2B0000 + n * 2 + 1) & 0x7FFFFFFF:08X}"


def _next_rid(rels) -> str:
    top = 0
    for r in rels:
        rid = str(r.get("Id") or "")
        if rid.startswith("rId") and rid[3:].isdigit():
            top = max(top, int(rid[3:]))
    return f"rId{top + 1}"


def _comments_extended_root(parts: dict[str, bytes]):
    """取（或建）`word/commentsExtended.xml` 的根。"""
    from lxml import etree

    part = "word/commentsExtended.xml"
    if part in parts:
        return etree.fromstring(parts[part])
    root = etree.Element(W15 + "commentsEx",
                         nsmap={"w15": W15[1:-1], "mc": MC[1:-1]})
    root.set(MC + "Ignorable", "w15")
    return root


def ensure_comments_extended(parts: dict[str, bytes], parent_of: dict[str, str] | None = None,
                            done_of: dict[str, bool] | None = None) -> dict[str, bytes]:
    """把 comments.xml / commentsExtended.xml 的 paraId 链补全，并写好内容类型与关系。

    - 每条批注的第一个 `w:p` 都要有 `w14:paraId`（缺了就按 id 派生补上）
    - 回复用 `w15:paraIdParent` 指回父批注的 paraId
    - 已解决用 `w15:done="1"`
    """
    from lxml import etree

    croot = etree.fromstring(parts["word/comments.xml"])
    cid_to_pid: dict[str, str] = {}
    for c in croot.findall(W + "comment"):
        cid = str(c.get(W + "id"))
        ps = c.findall(W + "p")
        if not ps:
            p = etree.SubElement(c, W + "p")
            ps = [p]
        pid = ps[0].get(W14 + "paraId")
        if not pid:
            pid = _para_id(cid)
            ps[0].set(W14 + "paraId", pid)
        cid_to_pid[cid] = pid

    eroot = _comments_extended_root(parts)
    by_pid = {}
    for ex in list(eroot):
        pid = ex.get(W15 + "paraId")
        if pid:
            by_pid[pid] = ex
    for cid, pid in cid_to_pid.items():
        if pid not in by_pid:
            ex = etree.SubElement(eroot, W15 + "commentEx")
            ex.set(W15 + "paraId", pid)
            ex.set(W15 + "done", "0")
            by_pid[pid] = ex

    for cid, parent_cid in (parent_of or {}).items():
        pid = cid_to_pid.get(str(cid))
        parent_pid = cid_to_pid.get(str(parent_cid))
        if pid and parent_pid and pid in by_pid:
            by_pid[pid].set(W15 + "paraIdParent", parent_pid)
    for cid, done in (done_of or {}).items():
        pid = cid_to_pid.get(str(cid))
        if pid and pid in by_pid:
            by_pid[pid].set(W15 + "done", "1" if done else "0")

    parts["word/comments.xml"] = _serialize(croot)
    parts["word/commentsExtended.xml"] = _serialize(eroot)

    # 内容类型
    ct = etree.fromstring(parts["[Content_Types].xml"])
    if not any(str(o.get("PartName")) == "/word/commentsExtended.xml" for o in ct):
        o = etree.SubElement(ct, CT + "Override")
        o.set("PartName", "/word/commentsExtended.xml")
        o.set("ContentType", CT_COMMENTS_EXT)
        parts["[Content_Types].xml"] = _serialize(ct)

    # 关系（document.xml.rels 指向 commentsExtended.xml）
    rels_part = "word/_rels/document.xml.rels"
    if rels_part in parts:
        rroot = etree.fromstring(parts[rels_part])
        linked = any(str(r.get("Type")) == REL_COMMENTS_EXT
                     or str(r.get("Target")) == "commentsExtended.xml" for r in rroot)
        if not linked:
            rel = etree.SubElement(rroot, PR + "Relationship")
            rel.set("Id", _next_rid(rroot))
            rel.set("Type", REL_COMMENTS_EXT)
            rel.set("Target", "commentsExtended.xml")
            parts[rels_part] = _serialize(rroot)
    return parts


def _new_comment_element(croot, text: str, author: str, stamp: str, cid: str):
    """造一条批注（与 python-docx 产出的形状一致：annotationRef + 文字 run）。"""
    from lxml import etree

    comment = etree.SubElement(croot, W + "comment")
    comment.set(W + "id", str(cid))
    comment.set(W + "author", author)
    comment.set(W + "initials", (author[:2] or "QA"))
    comment.set(W + "date", stamp)
    p = etree.SubElement(comment, W + "p")
    r1 = etree.SubElement(p, W + "r")
    rpr = etree.SubElement(r1, W + "rPr")
    style = etree.SubElement(rpr, W + "rStyle")
    style.set(W + "val", "CommentReference")
    etree.SubElement(r1, W + "annotationRef")
    r2 = etree.SubElement(p, W + "r")
    t = etree.SubElement(r2, W + "t")
    t.text = text
    t.set(XML_SPACE, "preserve")
    return comment


def add_comment(docx_path: Path, anchor: str | None, text: str, author: str,
                out_docx: Path | None = None, reply_to=None) -> dict:
    """加一条批注；给了 `reply_to` 就变成**回复**（不再需要锚点）。"""
    if reply_to is not None:
        return add_reply(docx_path, reply_to, text, author, out_docx)
    if not (anchor or "").strip():
        # 空锚点会 "in" 命中每一段（"" in text 恒真），所以必须在这里拦住
        raise C.OfficeError(
            "Usage",
            "加批注必须给锚点文字（--anchor），或者用 --reply-to 回复已有批注",
            next_steps=['先 `docx view --file a.docx` 看正文，挑一段短而连续的文字当锚点'],
        )

    docx = _docx()
    out = out_docx or docx_path
    doc = docx.Document(str(docx_path))
    target = _find_paragraph(doc, anchor or "")
    if target is None:
        raise C.OfficeError(
            "AnchorNotFound",
            f"文档里找不到锚点文字：{anchor!r}",
            next_steps=["先跑 `docx view` 看真实文字（可能被换行/空格切开）", "锚点取短一点、连续的一段"],
            detail={"hint": "view 的输出里每段前缀是 [序号] P"},
        )
    how = _isolate_anchor(target, anchor)
    # 重新取一遍 run 包装（包装对象要新拿，_parent 才是对的）
    anchor_runs = [r for r in target.runs if r.text == anchor]
    if not anchor_runs:
        anchor_runs = list(target.runs)
        how = "paragraph"
    comment = doc.add_comment(anchor_runs, text=text, author=author, initials=(author[:2] or "QA"))
    bak = C.prepare_write(out)
    doc.save(str(out))

    readback = read_comments(out)
    mine = [c for c in readback["comments"] if c["text"] == text]
    if not mine or not (mine[0]["anchor"] or "").strip():
        raise C.OfficeError(
            "CommentRangeMissing",
            "批注写进去了，但没挂上范围（读回的锚点是空的）——这会让 Word 显示成「孤立批注」",
            next_steps=["换一个更短、只落在一个 run 里的锚点", "或者先 `docx view` 确认这段文字没有被加粗/代码等行内样式打断"],
            detail={"comments": readback["comments"]},
        )
    return {
        "file": C.rel_path(out),
        "backup": C.rel_path(bak) if bak else None,
        "comment": {"text": text, "author": author, "id": mine[0]["id"], "anchor": mine[0]["anchor"],
                    "matched_by": how},
        "comments_in_doc": readback["count"],
    }


def add_reply(docx_path: Path, reply_to, text: str, author: str, out_docx: Path | None = None) -> dict:
    """回复某条批注：comments.xml 里加一条批注 + commentsExtended 里写 `w15:paraIdParent`。

    Word/WPS 从 2013 起就是这个结构：没有 paraIdParent 的第二条批注只会被当成"另一条批注"，
    不会显示成回复——这正是 python-docx 缺的那一层。
    """
    from lxml import etree

    out = out_docx or docx_path
    parts, names = _read_parts(docx_path)
    if "word/comments.xml" not in parts:
        raise C.OfficeError(
            "CommentNotFound",
            "这份文档里还没有任何批注，没有东西可以回复",
            next_steps=['先建一条：docx comment --file a.docx --anchor "正文一段" --text "批注"'],
        )
    croot = etree.fromstring(parts["word/comments.xml"])
    ids = [str(c.get(W + "id")) for c in croot.findall(W + "comment")]
    target = str(reply_to).strip().lstrip("cC")
    if target not in ids:
        raise C.OfficeError(
            "CommentNotFound",
            f"没有 id={target} 的批注",
            next_steps=[f"现有批注 id：{ids}", "`docx comments --file a.docx` 会列出 id 与正文"],
        )
    new_id = str(max([int(i) for i in ids if i.isdigit()] or [0]) + 1)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _new_comment_element(croot, text, author, stamp, new_id)
    parts["word/comments.xml"] = _serialize(croot)
    parts = ensure_comments_extended(parts, parent_of={new_id: target})
    _write_parts(docx_path, out, parts, names)

    readback = read_comments(out)
    mine = [c for c in readback["comments"] if c["id"] == new_id]
    if not mine or mine[0].get("parent") != target:
        raise C.OfficeError(
            "ReplyChainBroken",
            "回复写进去了，但读回来没挂上父批注（Word 会显示成另一条独立批注）",
            next_steps=["把这份 docx 交给用户看：commentsExtended.xml 的 paraIdParent 可能没写对",
                        "临时替代：直接在原批注正文里补一句，而不是回复"],
            detail={"comments": readback["comments"]},
        )
    info = mine[0]
    return {
        "file": C.rel_path(out),
        "mode": "reply",
        "reply": {"id": new_id, "parent": target, "text": text, "author": author,
                  "para_id": info.get("para_id"), "parent_para_id": info.get("parent_para_id")},
        "comments_in_doc": readback["count"],
        "resolved_count": readback.get("resolved_count", 0),
    }


def resolve_comment(docx_path: Path, comment_id, undo: bool = False,
                    out_docx: Path | None = None) -> dict:
    """标记批注「已解决」/ 撤销（`w15:done`）。"""
    from lxml import etree

    out = out_docx or docx_path
    parts, names = _read_parts(docx_path)
    if "word/comments.xml" not in parts:
        raise C.OfficeError("CommentNotFound", "这份文档里没有批注",
                            next_steps=["先 `docx comment …` 建一条"])
    croot = etree.fromstring(parts["word/comments.xml"])
    ids = [str(c.get(W + "id")) for c in croot.findall(W + "comment")]
    target = str(comment_id).strip().lstrip("cC")
    if target not in ids:
        raise C.OfficeError("CommentNotFound", f"没有 id={target} 的批注",
                            next_steps=[f"现有批注 id：{ids}"])
    parts = ensure_comments_extended(parts, done_of={target: not undo})
    _write_parts(docx_path, out, parts, names)
    readback = read_comments(out)
    mine = [c for c in readback["comments"] if c["id"] == target]
    got = bool(mine and mine[0].get("resolved"))
    if got == bool(undo):
        raise C.OfficeError(
            "ResolveStateMismatch",
            f"标记没生效：要的就是 {'未解决' if undo else '已解决'}，读回来还是 {'已解决' if got else '未解决'}",
            next_steps=["把这份 docx 与回执一起报给用户；commentsExtended.xml 可能被别的工具覆盖了"],
            detail={"comments": readback["comments"]},
        )
    return {
        "file": C.rel_path(out),
        "mode": "unresolve" if undo else "resolve",
        "id": target,
        "resolved": got,
        "comments_in_doc": readback["count"],
        "resolved_count": readback.get("resolved_count", 0),
    }


def _find_paragraph(doc, anchor: str):
    for par in doc.paragraphs:
        if anchor in par.text:
            return par
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for par in cell.paragraphs:
                    if anchor in par.text:
                        return par
    return None


def _isolate_anchor(par, anchor: str) -> str:
    """让锚点文字成为**独立的一个 run**（必要时在 XML 层把原 run 一分为三）。

    返回这次用的是哪种方式：exact / split-run / paragraph。
    """
    from copy import deepcopy
    from lxml import etree

    W_T = W + "t"
    runs = par.runs
    if not runs:
        return "paragraph"
    for run in runs:
        if run.text == anchor:
            return "exact"
    if (par.text or "").strip() == anchor.strip():
        return "paragraph"
    for run in runs:
        if anchor not in run.text:
            continue
        before, _, after = run.text.partition(anchor)
        template = deepcopy(run._r)

        def mk(text: str):
            el = deepcopy(template)
            for child in list(el):
                if child.tag != W + "rPr":
                    el.remove(child)
            t = etree.SubElement(el, W_T)
            t.text = text
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            return el

        anchor_el = mk(anchor)
        after_el = mk(after) if after else None
        run._r.addnext(anchor_el)
        if after_el is not None:
            anchor_el.addnext(after_el)
        if before:
            # 原 run 只保留前半段
            for child in list(run._r):
                if child.tag != W + "rPr":
                    run._r.remove(child)
            t = etree.SubElement(run._r, W_T)
            t.text = before
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        else:
            par._p.remove(run._r)
        return "split-run"
    return "paragraph"


def read_comments(docx_path: Path) -> dict:
    """从 zip 里直接读 comments.xml / commentsExtended.xml，并在 document.xml 里找批注范围覆盖的文字。"""
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        names = zf.namelist()
        if "word/comments.xml" not in names:
            return {"file": C.rel_path(docx_path), "count": 0, "comments": [],
                    "resolved_count": 0, "extended": False}
        croot = etree.fromstring(zf.read("word/comments.xml"))
        doc = etree.fromstring(zf.read("word/document.xml"))
        ext_raw = zf.read("word/commentsExtended.xml") if "word/commentsExtended.xml" in names else None
    anchors: dict[str, str] = {}
    open_ids: set[str] = set()
    buffer: dict[str, list[str]] = {}
    for el in doc.iter():
        if el.tag == W + "commentRangeStart":
            cid = el.get(W + "id")
            open_ids.add(cid)
            buffer[cid] = []
        elif el.tag == W + "commentRangeEnd":
            cid = el.get(W + "id")
            if cid in buffer:
                anchors[cid] = _para_text_join(buffer.pop(cid))
                open_ids.discard(cid)
        elif el.tag == W + "t" and el.text:
            for cid in open_ids:
                buffer.setdefault(cid, []).append(el.text)

    para_id_of: dict[str, str] = {}
    for c in croot.findall(W + "comment"):
        ps = c.findall(W + "p")
        pid = ps[0].get(W14 + "paraId") if ps else None
        if pid:
            para_id_of[str(c.get(W + "id"))] = pid
    pid_to_cid = {pid: cid for cid, pid in para_id_of.items()}
    ext: dict[str, dict] = {}
    if ext_raw is not None:
        try:
            for e in etree.fromstring(ext_raw):
                pid = e.get(W15 + "paraId")
                if pid:
                    ext[pid] = {"done": e.get(W15 + "done"), "parent": e.get(W15 + "paraIdParent")}
        except etree.XMLSyntaxError:
            ext = {}

    comments = []
    for c in croot.findall(W + "comment"):
        cid = str(c.get(W + "id"))
        pid = para_id_of.get(cid)
        e = ext.get(pid or "") or {}
        done = e.get("done")
        comments.append({
            "id": cid,
            "author": c.get(W + "author"),
            "date": c.get(W + "date"),
            "text": _para_text(c),
            "anchor": anchors.get(cid, ""),
            "para_id": pid,
            "resolved": (done in ("1", "true")) if done is not None else None,
            "parent": pid_to_cid.get(e.get("parent") or ""),
            "parent_para_id": e.get("parent"),
        })
    return {
        "file": C.rel_path(docx_path),
        "count": len(comments),
        "resolved_count": sum(1 for c in comments if c["resolved"]),
        "replies": sum(1 for c in comments if c["parent"]),
        "extended": ext_raw is not None,
        "comments": comments,
    }


def _para_text_join(parts: list[str]) -> str:
    return "".join(parts).strip()


# ── 修订 ────────────────────────────────────────────────────────────────────


def _doc_part(docx_path: Path):
    from lxml import etree

    with zipfile.ZipFile(docx_path) as zf:
        return etree.fromstring(zf.read("word/document.xml"))


def _rewrite(docx_path: Path, out_path: Path, replacements: dict[str, bytes]) -> Path:
    """把替换过的部件写回一个新包（其余部件逐字节照搬）。"""
    tmp = out_path.with_suffix(".tmp-build.docx")
    C.ensure_parent(out_path)
    with zipfile.ZipFile(docx_path) as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename in replacements:
                data = replacements[item.filename]
            dst.writestr(item, data)
    C.prepare_write(out_path)
    tmp.replace(out_path)
    return out_path


def list_revisions(docx_path: Path) -> dict:
    doc = _doc_part(docx_path)
    out = []
    for tag, kind in ((W + "ins", "insert"), (W + "del", "delete")):
        for el in doc.iter(tag):
            parent = el.getparent()
            if parent is not None and parent.tag == W + "rPr":
                continue  # 段落标记的修订，不算内容
            text = _para_text(el)
            out.append({
                "kind": kind,
                "id": el.get(W + "id"),
                "author": el.get(W + "author"),
                "date": el.get(W + "date"),
                "text": text,
            })
    return {"file": C.rel_path(docx_path), "count": len(out), "revisions": out}


def track_insert(docx_path: Path, text: str, anchor: str | None, author: str,
                 out_docx: Path | None = None, as_paragraph: bool = False) -> dict:
    """插入一条**真正的** w:ins 修订（Word 里会显示成"插入"）。"""
    from lxml import etree

    out = out_docx or docx_path
    doc = _doc_part(docx_path)
    body = doc.find(W + "body")
    if body is None:
        raise C.OfficeError("NoBody", "document.xml 没有 w:body")
    target_par = None
    for par in body.findall(W + "p"):
        if anchor is None or anchor in _para_text(par):
            target_par = par
            break
    if target_par is None:
        raise C.OfficeError("AnchorNotFound", f"找不到锚点段落：{anchor!r}",
                            next_steps=["先 `docx view` 看文字，再挑一段连续文字当锚点"])
    new_id = _next_rev_id(doc)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ins = etree.SubElement(target_par, W + "ins") if not as_paragraph else None
    if as_paragraph:
        new_par = etree.SubElement(body, W + "p")
        target_par.addnext(new_par)
        ins = etree.SubElement(new_par, W + "ins")
    ins.set(W + "id", str(new_id))
    ins.set(W + "author", author)
    ins.set(W + "date", stamp)
    run = etree.SubElement(ins, W + "r")
    t = etree.SubElement(run, W + "t")
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
    _rewrite(docx_path, out, {"word/document.xml": xml})
    return {"file": C.rel_path(out), "author": author, "date": stamp, "id": str(new_id),
            "text": text, "revisions": list_revisions(out)}


def _next_rev_id(doc) -> int:
    ids = [0]
    for tag in (W + "ins", W + "del", W + "comment"):
        for el in doc.iter(tag):
            try:
                ids.append(int(el.get(W + "id") or 0))
            except (TypeError, ValueError):
                pass
    return max(ids) + 1


def resolve_revisions(docx_path: Path, accept: bool, out_docx: Path | None = None) -> dict:
    """接受或拒绝全部修订（只动 document.xml，其余部件照搬）。"""
    from lxml import etree

    out = out_docx or docx_path
    doc = _doc_part(docx_path)
    kept, dropped = [], []
    for tag, kind in ((W + "ins", "insert"), (W + "del", "delete")):
        for el in list(doc.iter(tag)):
            text = _para_text(el)
            parent = el.getparent()
            if parent is not None and parent.tag == W + "rPr":
                parent.remove(el)
                continue
            action = None
            if kind == "insert":
                action = "accept" if accept else "drop"
            else:
                action = "drop" if accept else "accept"
            if action == "drop":
                parent = el.getparent()
                if parent is not None:
                    parent.remove(el)
                    dropped.append({"kind": kind, "text": text})
            else:
                # 接受：把子节点提上来；对 w:del 里被删的文字（w:delText）不保留
                if kind == "delete":
                    parent = el.getparent()
                    if parent is not None:
                        parent.remove(el)
                        dropped.append({"kind": kind, "text": text})
                    continue
                parent = el.getparent()
                idx = parent.index(el)
                for child in list(el):
                    parent.insert(idx, child)
                    idx += 1
                parent.remove(el)
                kept.append({"kind": kind, "text": text})
    xml = etree.tostring(doc, xml_declaration=True, encoding="UTF-8", standalone=True)
    _rewrite(docx_path, out, {"word/document.xml": xml})
    remaining = list_revisions(out)
    return {"file": C.rel_path(out), "mode": "accept" if accept else "reject",
            "kept": kept, "dropped": dropped, "remaining": remaining["count"]}


# ── 出图 ────────────────────────────────────────────────────────────────────


def render(docx_path: Path, out_dir: Path, dpi: int = 144, pages: str | None = None,
           cols: int = 2, engine: str = "pdf") -> dict:
    import _render

    out_dir.mkdir(parents=True, exist_ok=True)
    if engine == "kit":
        import _lo

        res = _lo.render(docx_path, out_dir / "_kit", dpi=dpi, pages=pages)
        images = res["images"]
        route = "libreoffice-kit（实测有 4/3 放大裁切，仅作对照）"
        missing_fonts = res.get("missingFonts", [])
    else:
        res = _render.render_office_via_pdf(docx_path, out_dir, dpi=dpi, pages=pages)
        images = res["images"]
        route = "libreoffice→pdf→pdfium"
        missing_fonts = []
    if not images:
        raise C.OfficeError("RenderEmpty", "没吐出任何页面图",
                            next_steps=["拿 docx 去 Word 里打开确认没坏，再跑一次"])
    stats = _render.summarize_pages(images)
    sheet = _render.contact_sheet(
        images, out_dir / "contact-sheet.png", cols=cols,
        title=f"{docx_path.name} · {len(images)} 页 · {dpi}dpi",
        labels=[f"第 {i.get('page', n + 1)} 页" for n, i in enumerate(images)],
    )
    return {
        "file": C.rel_path(docx_path),
        "route": route,
        "dpi": dpi,
        "page_count": len(images),
        "images": [{**i, "path": C.rel_path(i["path"])} for i in images],
        "contact_sheet": C.rel_path(sheet["path"]),
        "missing_fonts": missing_fonts,
        "pages": [{**s, "path": C.rel_path(s["path"])} for s in stats],
        "blank_pages": [s["page"] for s in stats if s["blank"]],
        "mean_ink_ratio": round(sum(s["ink_ratio"] for s in stats) / len(stats), 5) if stats else 0.0,
    }
