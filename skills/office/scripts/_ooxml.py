"""OOXML 底层件：命名空间、schema 顺序表、域（field）、边框、书签、脚注部件。

为什么单独一层：`docx_ops.py` 已经很大，而"页眉页脚/页码/目录域/脚注/三线表/书签"
这些**都是同一类活**——往 `document.xml`（或它的兄弟部件）里按 schema 顺序塞正确的元素。
把它们收在这里，`docx_ops.py` 只负责"决定塞什么"，不重复处理顺序与命名空间。

只做 TTF/WML 这一档，不碰 DrawingML/PML。
"""

from __future__ import annotations

import hashlib

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CT = "{http://schemas.openxmlformats.org/package/2006/content-types}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"
W14 = "{http://schemas.microsoft.com/office/word/2010/wordml}"
W15 = "{http://schemas.microsoft.com/office/word/2011/wordml}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_COMMENTS_EXT = ("application/vnd.openxmlformats-officedocument.wordprocessingml."
                   "commentsExtended+xml")
REL_COMMENTS_EXT = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended"
CT_FOOTNOTES = "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"
REL_FOOTNOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes"
CT_SETTINGS_UPDATE = "w:updateFields"

# ECMA-376 里这几个容器是**有序**的（sequence，不是 all）。手工改 XML 最容易把顺序弄反，
# Word 打开时会报"内容有问题"。表按 schema 顺序写，校验与插入都用同一份。
PPR_ORDER = (
    "pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers "
    "pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE "
    "autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents "
    "suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle "
    "rPr sectPr pPrChange"
).split()
RPR_ORDER = (
    "rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof "
    "snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd "
    "fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath"
).split()
TCPR_ORDER = (
    "cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText "
    "vAlign hideMark headers cellIns cellDel cellMerge tcPrChange"
).split()
TBLPR_ORDER = (
    "tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize tblStyleColBandSize tblW jc "
    "tblCellSpacing tblInd tblBorders shd tblLayout tblCellMar tblLook tblPrChange"
).split()
SECTPR_ORDER = (
    "footnotePr endnotePr type pgSz pgMar paperSrc pgBorders lnNumType pgNumType cols formProt "
    "vAlign noEndnote titlePg textDirection bidi rtlGutter docGrid printerSettings sectPrChange"
).split()


def order_of(tag: str, order: list[str]) -> int | None:
    local = tag.rsplit("}", 1)[-1]
    try:
        return order.index(local)
    except ValueError:
        return None


def check_order(parent, order: list[str], label: str, limit: int = 3) -> list[str]:
    """返回 parent 子元素里**顺序不对**的描述（空列表=顺序正确）。"""
    last, last_tag = -1, ""
    bad: list[str] = []
    for child in parent:
        idx = order_of(child.tag, order)
        if idx is None:
            continue
        if idx < last:
            bad.append(f"{label} 里 {child.tag.rsplit('}', 1)[-1]} 排在了 "
                       f"{last_tag} 之后（schema 要求它在前面）")
            if len(bad) >= limit:
                return bad
        else:
            last, last_tag = idx, child.tag.rsplit("}", 1)[-1]
    return bad


def insert_ordered(parent, child, order: list[str]) -> None:
    """把 child 插进 parent 的**正确顺序位置**（不是简单 append）。"""
    idx = order_of(child.tag, order)
    if idx is None:
        parent.append(child)
        return
    for pos, existing in enumerate(parent):
        e_idx = order_of(existing.tag, order)
        if e_idx is not None and e_idx > idx:
            parent.insert(pos, child)
            return
    parent.append(child)


# ── 域（field）────────────────────────────────────────────────────────────

def _run(rpr_builder=None):
    from lxml import etree

    r = etree.Element(W + "r")
    if rpr_builder is not None:
        rpr = etree.SubElement(r, W + "rPr")
        rpr_builder(rpr)
    return r


def field_runs(instr: str, cached: str = "", rpr_builder=None) -> list:
    """造一个**完整**的域（begin / instrText / separate / 缓存值 / end）。

    `cached` 是"Word 打开且还没刷新时显示什么"。不写缓存值的域在多数阅读器里是空白，
    所以目录页码这种必须给缓存值（我们算得出真页码，见 `docx_ops.toc_page_numbers`）。
    """
    from lxml import etree

    begin = _run(rpr_builder)
    etree.SubElement(begin, W + "fldChar").set(W + "fldCharType", "begin")
    instr_run = _run(rpr_builder)
    it = etree.SubElement(instr_run, W + "instrText")
    it.set(XML_SPACE, "preserve")
    it.text = instr
    sep = _run(rpr_builder)
    etree.SubElement(sep, W + "fldChar").set(W + "fldCharType", "separate")
    shown = _run(rpr_builder)
    t = etree.SubElement(shown, W + "t")
    t.text = cached
    t.set(XML_SPACE, "preserve")
    end = _run(rpr_builder)
    etree.SubElement(end, W + "fldChar").set(W + "fldCharType", "end")
    return [begin, instr_run, sep, shown, end]


def simple_field(instr: str, cached: str = "") -> str:
    """`w:fldSimple` 的 XML 片段（有些阅读器更认这种简式）。"""
    return f'<w:fldSimple w:instr="{instr}"><w:r><w:t>{cached}</w:t></w:r></w:fldSimple>'


def instr_texts(document) -> list[str]:
    """document.xml 里所有域指令（用于判断"已经有没有目录域"）。"""
    out = []
    for el in document.iter(W + "instrText"):
        if el.text:
            out.append(el.text.strip())
    for el in document.iter(W + "fldSimple"):
        v = el.get(W + "instr")
        if v:
            out.append(v.strip())
    return out


# ── 边框 / 底纹 / 表格 ─────────────────────────────────────────────────────

def _border_el(parent, edge: str, val: str, sz: int, color: str, space: int = 0):
    from lxml import etree

    b = etree.SubElement(parent, W + edge)
    b.set(W + "val", val)
    b.set(W + "sz", str(sz))
    b.set(W + "space", str(space))
    b.set(W + "color", color)
    return b


def set_table_borders(tbl_pr, *, top: int | None = None, bottom: int | None = None,
                      inside_h: int | None = None, inside_v: int | None = None,
                      left: int | None = None, right: int | None = None,
                      color: str = "000000") -> None:
    """按"三线表/网格表"的规格重写 `w:tblBorders`（幂等：先删旧的）。"""
    from lxml import etree

    old = tbl_pr.find(W + "tblBorders")
    if old is not None:
        tbl_pr.remove(old)
    borders = etree.Element(W + "tblBorders")
    spec = (("top", top), ("left", left), ("bottom", bottom), ("right", right),
            ("insideH", inside_h), ("insideV", inside_v))
    for edge, sz in spec:
        if sz is None:
            _border_el(borders, edge, "none", 0, "auto")
        else:
            _border_el(borders, edge, "single", int(sz), color)
    insert_ordered(tbl_pr, borders, TBLPR_ORDER)


def set_cell_border(cell_tc, edge: str, sz: int | None, color: str = "000000") -> None:
    from lxml import etree

    tc_pr = cell_tc.get_or_add_tcPr()
    borders = tc_pr.find(W + "tcBorders")
    if borders is None:
        borders = etree.Element(W + "tcBorders")
        insert_ordered(tc_pr, borders, TCPR_ORDER)
    old = borders.find(W + edge)
    if old is not None:
        borders.remove(old)
    _border_el(borders, edge, "single" if sz else "none", sz or 0, color if sz else "auto")


# ── 书签 ───────────────────────────────────────────────────────────────────

def bookmark_name(seed: str, seq: int) -> str:
    """书签名：Word 要求 ≤40 字符、无空格、字母/数字/下划线，且文档内唯一。

    用 `_Toc` 前缀是为了和 Word 自己生成的目录书签同一套命名习惯（Word 刷新目录会复用它们）。
    """
    digest = hashlib.sha1(f"{seed}|{seq}".encode("utf-8")).hexdigest()[:8]
    return f"_Toc{digest}{seq:03d}"[:40]


def wrap_with_bookmark(par_el, name: str, bk_id: int) -> None:
    """把整段包进 bookmarkStart/End（Word 的目录域就靠这个锚点跳转）。

    注意：`w:bookmarkStart` 必须排在 `w:pPr` **之后**（pPr 是段的第一个子元素）。
    """
    from lxml import etree

    start = etree.Element(W + "bookmarkStart")
    start.set(W + "id", str(bk_id))
    start.set(W + "name", name)
    end = etree.Element(W + "bookmarkEnd")
    end.set(W + "id", str(bk_id))
    pos = 1 if par_el.find(W + "pPr") is not None else 0
    par_el.insert(pos, start)
    par_el.append(end)


def field_begin_runs(instr: str, rpr_builder=None) -> list:
    """域的开头三个 run：begin / instrText / separate（域的结果跟在后面，可以跨段）。"""
    from lxml import etree

    begin = _run(rpr_builder)
    etree.SubElement(begin, W + "fldChar").set(W + "fldCharType", "begin")
    instr_run = _run(rpr_builder)
    it = etree.SubElement(instr_run, W + "instrText")
    it.set(XML_SPACE, "preserve")
    it.text = instr
    sep = _run(rpr_builder)
    etree.SubElement(sep, W + "fldChar").set(W + "fldCharType", "separate")
    return [begin, instr_run, sep]


def field_end_runs(rpr_builder=None) -> list:
    """域的收尾：`fldChar end`。"""
    from lxml import etree

    end = _run(rpr_builder)
    etree.SubElement(end, W + "fldChar").set(W + "fldCharType", "end")
    return [end]


# ── 段落属性小工具 ─────────────────────────────────────────────────────────

def set_paragraph_tabs(par_el, right_pos_twips: int, leader: str = "dot") -> None:
    """给段落加一个右对齐、点状前导的制表位（目录条目用）。"""
    from lxml import etree

    p_pr = par_el.find(W + "pPr")
    if p_pr is None:
        p_pr = etree.Element(W + "pPr")
        par_el.insert(0, p_pr)
    tabs = p_pr.find(W + "tabs")
    if tabs is None:
        tabs = etree.Element(W + "tabs")
        insert_ordered(p_pr, tabs, PPR_ORDER)
    for old in list(tabs):
        tabs.remove(old)
    tab = etree.SubElement(tabs, W + "tab")
    tab.set(W + "val", "right")
    tab.set(W + "leader", leader)
    tab.set(W + "pos", str(int(right_pos_twips)))


def add_tab_run(run_parent):
    """一个制表符 run（目录条目里"标题 …… 页码"的那个 tab）。"""
    from lxml import etree

    r = etree.SubElement(run_parent, W + "r")
    etree.SubElement(r, W + "tab")
    return r


# ── 设置：updateFields ─────────────────────────────────────────────────────

def ensure_update_fields(settings_root) -> bool:
    """在 settings.xml 里加 `<w:updateFields w:val="true"/>`（目录/页码刷新的后手）。"""
    from lxml import etree

    for el in settings_root.iter(W + "updateFields"):
        if el.get(W + "val") in ("true", "1", None):
            return False
    el = etree.SubElement(settings_root, W + "updateFields")
    el.set(W + "val", "true")
    return True


# ── 脚注部件 ───────────────────────────────────────────────────────────────

def footnotes_root():
    """造一个空的 footnotes.xml 根，带 Word 必需的 separator / continuationSeparator。"""
    from lxml import etree

    root = etree.Element(W + "footnotes",
                         nsmap={"w": W[1:-1], "r": R[1:-1]})
    for fid, kind, tag in ((-1, "separator", "separator"),
                           (0, "continuationSeparator", "continuationSeparator")):
        fn = etree.SubElement(root, W + "footnote")
        fn.set(W + "type", kind)
        fn.set(W + "id", str(fid))
        p = etree.SubElement(fn, W + "p")
        p_pr = etree.SubElement(p, W + "pPr")
        spacing = etree.SubElement(p_pr, W + "spacing")
        spacing.set(W + "after", "0")
        spacing.set(W + "line", "240")
        spacing.set(W + "lineRule", "auto")
        r = etree.SubElement(p, W + "r")
        etree.SubElement(r, W + tag)
    return root


def add_footnote(root, fid: int, text: str) -> None:
    """往 footnotes.xml 根里加一条脚注（`w:footnoteRef` + 正文）。"""
    from lxml import etree

    fn = etree.SubElement(root, W + "footnote")
    fn.set(W + "id", str(fid))
    p = etree.SubElement(fn, W + "p")
    p_pr = etree.SubElement(p, W + "pPr")
    style = etree.SubElement(p_pr, W + "pStyle")
    style.set(W + "val", "FootnoteText")
    ref = etree.SubElement(p, W + "r")
    r_pr = etree.SubElement(ref, W + "rPr")
    r_style = etree.SubElement(r_pr, W + "rStyle")
    r_style.set(W + "val", "FootnoteReference")
    etree.SubElement(ref, W + "footnoteRef")
    run = etree.SubElement(p, W + "r")
    t = etree.SubElement(run, W + "t")
    t.text = " " + text
    t.set(XML_SPACE, "preserve")


def footnote_reference_run(fid: int, rpr_builder=None):
    """正文里的脚注引用 run：`<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>
    <w:footnoteReference w:id="N"/></w:r>`。"""
    from lxml import etree

    r = etree.Element(W + "r")
    r_pr = etree.SubElement(r, W + "rPr")
    style = etree.SubElement(r_pr, W + "rStyle")
    style.set(W + "val", "FootnoteReference")
    etree.SubElement(r, W + "footnoteReference").set(W + "id", str(fid))
    return r


def ensure_footnote_styles(styles_root) -> list[str]:
    """补上 FootnoteText / FootnoteReference 两个样式（缺了 Word 会用默认，但脚注会难看）。"""
    from lxml import etree

    have = {s.get(W + "styleId") for s in styles_root.findall(W + "style")}
    added = []
    if "FootnoteText" not in have:
        st = etree.SubElement(styles_root, W + "style")
        st.set(W + "type", "paragraph")
        st.set(W + "styleId", "FootnoteText")
        st.set(W + "default", "1")
        etree.SubElement(st, W + "name").set(W + "val", "footnote text")
        rpr = etree.SubElement(st, W + "rPr")
        etree.SubElement(rpr, W + "sz").set(W + "val", "18")  # 9pt
        added.append("FootnoteText")
    if "FootnoteReference" not in have:
        st = etree.SubElement(styles_root, W + "style")
        st.set(W + "type", "character")
        st.set(W + "styleId", "FootnoteReference")
        etree.SubElement(st, W + "name").set(W + "val", "footnote reference")
        rpr = etree.SubElement(st, W + "rPr")
        etree.SubElement(rpr, W + "vertAlign").set(W + "val", "superscript")
        added.append("FootnoteReference")
    return added


def section_columns(sect_pr, num: int, space_twips: int = 425) -> None:
    """设置 `w:sectPr/w:cols`（分栏）。num=1 表示回到单栏。"""
    from lxml import etree

    cols = sect_pr.find(W + "cols")
    if cols is None:
        cols = etree.Element(W + "cols")
        insert_ordered(sect_pr, cols, SECTPR_ORDER)
    for child in list(cols):
        cols.remove(child)
    cols.set(W + "num", str(int(num)))
    cols.set(W + "space", str(int(space_twips)))


def page_number_type(sect_pr, fmt: str = "decimal", start: int | None = None) -> None:
    """`w:pgNumType`：页码格式与起始值（多节文档常用"封面不编号、正文从 1 开始"）。"""
    from lxml import etree

    el = sect_pr.find(W + "pgNumType")
    if el is None:
        el = etree.Element(W + "pgNumType")
        insert_ordered(sect_pr, el, SECTPR_ORDER)
    el.set(W + "fmt", fmt)
    if start is not None:
        el.set(W + "start", str(int(start)))
