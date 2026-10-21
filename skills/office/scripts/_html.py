"""HTML → 块模型：把一份 HTML 读成 `_md.Block` 列表，交给现有的排版器。

这是「HTML → PDF」的**本地实现**：不引 Playwright、不引浏览器、不引 Paged.js、
也不引 xhtml2pdf。用 lxml 解析（本来就要用），落回我们自己的块模型，
于是中文那套保证（cmap 字形预检、字体嵌入审计、文本往返、出图人眼检查）全部复用。

支持的是"文档级 HTML"那一档（够写报告/通知/说明）：
  结构：h1..h6 / p / div / section / article / header / footer / figure / figcaption /
        ul / ol / li（含嵌套）/ table / caption / thead / tbody / tr / th / td /
        pre / blockquote / hr / img / br
  行内：strong,b / em,i / code / a[href] / u / s,del,strike
  表格：`colspan` / `rowspan`（跨行跨列真的会合，交给排版器处理）
  CSS 分页（认一个子集）：`@page { size / margin }`、`page-break-before/after: always`
        （选择器支持 `h1`、`h1,h2`、`.cls`、`#id`）
  丢弃：`<style>` `<script>` `<noscript>` `<head>` —— **不做完整 CSS 布局引擎**
不认（会明说）：浮动、多栏、绝对定位、JS、外部字体、`@media print` 之外的媒体查询。
"""

from __future__ import annotations

import re

import _common as C
from _md import Block

_BLOCK_CONTAINERS = {
    "div", "section", "article", "main", "header", "footer", "nav", "aside",
    "figure", "center", "html", "body", "font", "span", "dl", "dd", "dt",
    "details", "summary", "form", "fieldset",
}
_SKIP = {"style", "script", "noscript", "head", "meta", "link", "title", "template"}

_PAGE_BREAK_RE = re.compile(r"page-break-(before|after)\s*:\s*(always|page)", re.I)
_AT_PAGE_RE = re.compile(r"@page\s*(?:[^{]*)\{(.*?)\}", re.I | re.S)


def _parse_css(html_text: str) -> dict:
    """从 `<style>` 里抠出"我们能认的那一点"：@page 的 size/margin + 分页规则。"""
    css = {"page": {}, "breaks": {}, "rules": 0}
    styles = re.findall(r"<style[^>]*>(.*?)</style>", html_text, re.I | re.S)
    if not styles:
        return css
    text = "\n".join(styles)
    for block in _AT_PAGE_RE.findall(text):
        for decl in block.split(";"):
            if ":" not in decl:
                continue
            key, _, value = decl.partition(":")
            key, value = key.strip().lower(), value.strip()
            if key == "size":
                css["page"]["size"] = value.split()[0].upper() if value else ""
            elif key == "margin":
                css["page"]["margin"] = value
    for match in re.finditer(r"([^{}]+)\{([^{}]*)\}", text):
        selectors, body = match.group(1).strip(), match.group(2)
        for selector in [s.strip() for s in selectors.split(",") if s.strip()]:
            for kind, _ in _PAGE_BREAK_RE.findall(body):
                css["breaks"].setdefault(selector, set()).add(kind)
                css["rules"] += 1
    return css


def _matches(el, selector: str) -> bool:
    sel = selector.strip()
    if not sel or sel.startswith("@"):
        return False
    tag = _tag(el)
    if sel.startswith("."):
        return sel[1:] in (el.get("class") or "").split()
    if sel.startswith("#"):
        return sel[1:] == (el.get("id") or "")
    m = re.match(r"^([A-Za-z0-9]+)(?:\.([\w-]+))?$", sel)
    if m:
        if tag != m.group(1).lower():
            return False
        return (m.group(2) in (el.get("class") or "").split()) if m.group(2) else True
    return tag == sel.lower()


def _break_for(el, css: dict) -> tuple[bool, bool]:
    before = after = False
    for selector, kinds in (css.get("breaks") or {}).items():
        if _matches(el, selector):
            if "before" in kinds:
                before = True
            if "after" in kinds:
                after = True
    return before, after


def _tag(el) -> str:
    return el.tag.lower() if isinstance(el.tag, str) else ""


def _clean(text: str) -> str:
    return re.sub(r"[ \t\r\n\u00a0]+", " ", text or "").strip()


def inline(el) -> str:
    """把一个元素的内容转成"带 Markdown 行内标记"的文本（交给 `_md.inline_runs` 再切）。"""
    parts: list[str] = [el.text or ""]
    for child in el:
        tag = _tag(child)
        inner = inline(child)
        if not inner.strip():
            if child.tail:
                parts.append(child.tail)
            continue
        if tag in ("strong", "b"):
            parts.append(f"**{inner.strip()}**")
        elif tag in ("em", "i"):
            parts.append(f"*{inner.strip()}*")
        elif tag == "code":
            parts.append(f"`{inner.strip()}`")
        elif tag in ("del", "s", "strike", "u", "small", "sub", "sup"):
            parts.append(inner)
        elif tag == "a":
            href = (child.get("href") or "").strip()
            parts.append(f"[{inner.strip()}]({href})" if href and not href.startswith("#") else inner)
        elif tag == "br":
            parts.append(" ")
        elif tag == "img":
            parts.append("")  # 图在块级单列，不塞进段落
        else:
            parts.append(inner)
        if child.tail:
            parts.append(child.tail)
    return _clean("".join(parts))


def _images_in(el) -> list[tuple[str, str]]:
    out = []
    for img in el.iter("img"):
        src = (img.get("src") or "").strip()
        if src and not src.lower().startswith(("http://", "https://", "data:")):
            out.append((src, (img.get("alt") or "").strip()))
    return out


def _list_items(el, level: int = 0) -> list[tuple[int, str]]:
    """把 ul/ol 摊平成 [(层级, 文字)]，嵌套列表进一级。"""
    items: list[tuple[int, str]] = []
    ordered = _tag(el) == "ol"
    n = 0
    for li in el:
        if _tag(li) != "li":
            continue
        n += 1
        text = inline(li)
        prefix = f"{n}. " if ordered else ""
        items.append((level, prefix + text if text else ""))
        for sub in li:
            if _tag(sub) in ("ul", "ol"):
                items.extend(_list_items(sub, level + 1))
    return items


def _int_attr(el, name: str, default: int = 1) -> int:
    try:
        return max(1, min(50, int(str(el.get(name) or default).strip() or default)))
    except (TypeError, ValueError):
        return default


def _table_rows(el) -> tuple[list[list[str]], list[tuple[int, int, int, int]]]:
    """表格 → (矩形矩阵, 合并区)。`colspan`/`rowspan` 会真的占掉格子（被占的格是空串）。"""
    grid: dict[tuple[int, int], str] = {}
    spans: list[tuple[int, int, int, int]] = []
    rows_n = 0
    for r, tr in enumerate(el.iter("tr")):
        rows_n = max(rows_n, r + 1)
        c = 0
        for cell in tr:
            if _tag(cell) not in ("td", "th"):
                continue
            while (r, c) in grid:
                c += 1
            rowspan = _int_attr(cell, "rowspan")
            colspan = _int_attr(cell, "colspan")
            grid[(r, c)] = inline(cell)
            if rowspan > 1 or colspan > 1:
                spans.append((r, c, rowspan, colspan))
            for dr in range(rowspan):
                for dc in range(colspan):
                    if dr == 0 and dc == 0:
                        continue
                    grid.setdefault((r + dr, c + dc), "")
            c += colspan
    if not grid:
        return [], []
    width = max(c for (_, c) in grid) + 1
    height = max(r for (r, _) in grid) + 1
    rows = [[grid.get((r, c), "") for c in range(width)] for r in range(height)]
    return rows, spans


def parse(html_text: str, max_blocks: int = 20000) -> list[Block]:
    """HTML 文本 → `_md.Block` 列表（兼容老调用）。"""
    return parse_ex(html_text, max_blocks)[0]


def parse_ex(html_text: str, max_blocks: int = 20000) -> tuple[list[Block], dict]:
    """HTML 文本 → (块列表, meta)。meta 里有 CSS 里认出来的页面设置与分页规则。"""
    from lxml import html as LH

    css = _parse_css(html_text)
    try:
        # 传 str 而不是 bytes：libxml2 的 HTML 解析器在没有 <meta charset> 时
        # 会按 latin-1 猜，中文就成乱码了（我们已经在外面解码好了）
        root = LH.fromstring(html_text)
    except Exception as exc:  # noqa: BLE001
        raise C.OfficeError(
            "BadHtml",
            f"HTML 解析失败：{type(exc).__name__}: {exc}",
            next_steps=["确认文件是 UTF-8 编码的 HTML（可以先 `Get-Content -Encoding utf8 a.html | Select -First 5` 看一眼）",
                        "片段式 HTML（没有 html/body 外层）也能解析；但空文件不行"],
        ) from exc
    for bad in list(root.iter()):
        if _tag(bad) in _SKIP:
            parent = bad.getparent()
            if parent is not None:
                parent.remove(bad)
    blocks: list[Block] = []
    _walk(root, blocks, max_blocks, css)
    meta = {"css": css, "page": css.get("page", {}),
            "page_breaks": css.get("rules", 0), "rows": 0}
    return blocks, meta


def _walk(el, blocks: list[Block], max_blocks: int, css: dict | None = None) -> None:
    if len(blocks) >= max_blocks:
        return
    css = css or {}

    def _break(kind: str = "before") -> None:
        """插分页，但**开头的分页与连续分页要吞掉**（浏览器也不会为首元素的分页留一张空白页）。"""
        if not blocks:
            return
        if blocks and blocks[-1].kind == "pagebreak":
            return
        blocks.append(Block("pagebreak"))

    before, after = _break_for(el, css)
    if before:
        _break()
    tag = _tag(el)
    if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
        text = inline(el)
        if text:
            blocks.append(Block("heading", text=text, level=int(tag[1])))
        if after:
            _break("after")
        return
    if tag == "p":
        text = inline(el)
        if text:
            blocks.append(Block("para", text=text))
        for src, alt in _images_in(el):
            blocks.append(Block("image", text=src, alt=alt))
        if after:
            _break("after")
        return
    if tag == "pre":
        body = el.text_content().replace("\r\n", "\n").strip("\n")
        if body.strip():
            blocks.append(Block("code", text=body, lang=(el.get("data-lang") or "")))
        if after:
            _break("after")
        return
    if tag == "blockquote":
        text = "\n".join(_clean(x) for x in el.itertext() if x.strip())
        if text:
            blocks.append(Block("quote", text=text))
        return
    if tag in ("ul", "ol"):
        items = _list_items(el)
        if items:
            blocks.append(Block("ordered" if tag == "ol" else "bullet", items=items))
        return
    if tag == "table":
        rows, spans = _table_rows(el)
        if rows:
            blocks.append(Block("table", rows=rows, spans=spans))
        return
    if tag == "img":
        src = (el.get("src") or "").strip()
        if src and not src.lower().startswith(("http://", "https://", "data:")):
            blocks.append(Block("image", text=src, alt=(el.get("alt") or "").strip()))
        return
    if tag == "hr":
        blocks.append(Block("hr"))
        return
    if tag == "figcaption" or tag == "caption":
        text = inline(el)
        if text:
            blocks.append(Block("para", text=f"*{text}*"))
        return
    if tag == "br":
        return
    if tag in _BLOCK_CONTAINERS or tag in ("li", "td", "th", "tr", "thead", "tbody", "tfoot", "dl"):
        if tag == "li":  # 孤立 li（父级不是 ul/ol）
            text = inline(el)
            if text:
                blocks.append(Block("bullet", items=[(0, text)]))
            return
        for child in el:
            _walk(child, blocks, max_blocks, css)
        # 容器里只有纯文字（比如 <div>一段话</div>）也要留住
        if _tag(el) in ("div", "section", "article", "header", "footer", "figure", "body", "html"):
            own = _clean("".join(t for t in el.itertext() if t.strip()))
            if own and not list(el) and not blocks:
                blocks.append(Block("para", text=own))
        if after:
            _break("after")
        return
    # 其它未知标签：继续往里走
    for child in el:
        _walk(child, blocks, max_blocks, css)
    if after:
        _break("after")
