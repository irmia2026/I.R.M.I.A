"""极简 Markdown → 块模型（不依赖 markdown2 / pandoc，中文原样保留）。

只实现"写文档真正会用到"的那一档：标题 / 段落 / 无序列表 / 有序列表 /
表格 / 代码块 / 引用 / 分隔线 / 分页符 / **插图 / 公式 / 分节 / 分栏 / 脚注**。
行内支持 **粗** `*斜*` `` `码` `` [文字](链接) `[^脚注]`。

插图块：整行只有一个 `![替代文字](图片路径)`（可选 `"标题"`），路径相对当前工作目录，
找不到时回退到 Markdown 文件所在目录——docx 与 pdf 两条建文档的路都认这一种写法。

块级标记（HTML 注释写法，不会出现在正文里）：
  `<!-- pagebreak -->`     分页
  `<!-- sectionbreak -->`  新起一节（新页；docx 会真的多一个 sectPr）
  `<!-- columns: 2 -->`    当前节改成分栏（docx 落成 w:cols）

公式：整行 `$$ … $$`（可跨行）→ 独立公式块。脚注：正文写 `[^id]`，文末写
`[^id]: 脚注内容`；定义行不进正文。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

PAGEBREAK_MARK = "<!-- pagebreak -->"
SECTIONBREAK_MARK = "<!-- sectionbreak -->"
_COLUMNS_MARK = re.compile(r"^<!--\s*columns\s*:\s*(\d+)\s*-->$")

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_BULLET = re.compile(r"^(\s*)[-*+]\s+(.*\S)\s*$")
_ORDERED = re.compile(r"^(\s*)(\d+)[.)]\s+(.*\S)\s*$")
_HR = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_FENCE = re.compile(r"^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$")
_INLINE = re.compile(r"(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|\[\^[^\]]+\]|\[[^\]]+\]\([^)]+\))")
_IMAGE = re.compile(r"""^!\[([^\]]*)\]\(\s*([^)\s]+)\s*(?:"([^"]*)")?\s*\)$""")
_FOOTDEF = re.compile(r"^\[\^([^\]]+)\]:\s*(.*\S)\s*$")
_MATH_ONE = re.compile(r"^\$\$(.+?)\$\$\s*$")
_ANCHOR_SUFFIX = re.compile(r"\s*\{#([A-Za-z0-9_-]+)\}\s*$")


def strip_anchor(text: str) -> str:
    """去掉标题尾部的 `{#锚点}`（那是给书签/内链用的，不是正文）。"""
    return _ANCHOR_SUFFIX.sub("", text or "")


def split_anchor(text: str) -> tuple[str, str | None]:
    """`标题 {#名字}` → (`标题`, `名字`)。"""
    m = _ANCHOR_SUFFIX.search(text or "")
    if not m:
        return text or "", None
    return _ANCHOR_SUFFIX.sub("", text or ""), m.group(1)


@dataclass
class Block:
    kind: str  # heading|para|bullet|ordered|table|code|quote|hr|pagebreak|image|equation|sectionbreak|columns
    text: str = ""
    level: int = 0
    items: list = field(default_factory=list)  # [(level, text)]
    rows: list = field(default_factory=list)  # [[cell, ...], ...] 第一行是表头
    aligns: list = field(default_factory=list)
    lang: str = ""
    alt: str = ""    # image 的替代文字（也是 docx/pdf 里的图注）
    title: str = ""  # image 的 title 属性
    spans: list = field(default_factory=list)  # 表格合并：[(row, col, rowspan, colspan)]


def _split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    cells, buf, in_code = [], "", False
    for ch in s:
        if ch == "`":
            in_code = not in_code
            buf += ch
        elif ch == "|" and not in_code:
            cells.append(buf.strip())
            buf = ""
        else:
            buf += ch
    cells.append(buf.strip())
    return cells


def _aligns(line: str) -> list[str]:
    out = []
    for cell in _split_row(line):
        c = cell.strip()
        left, right = c.startswith(":"), c.endswith(":")
        if left and right:
            out.append("center")
        elif right:
            out.append("right")
        elif left:
            out.append("left")
        else:
            out.append("")
    return out


def parse(md_text: str) -> list[Block]:
    """只要块（脚注定义被丢弃，见 `parse_ex`）。"""
    return parse_ex(md_text)[0]


def parse_ex(md_text: str) -> tuple[list[Block], dict[str, str]]:
    """解析成 (块列表, 脚注定义表)。脚注定义行（`[^id]: …`）不进正文。"""
    text = md_text.replace("\r\n", "\n").replace("\r", "\n")
    raw_lines = text.split("\n")
    notes: dict[str, str] = {}
    lines: list[str] = []
    for ln in raw_lines:
        m = _FOOTDEF.match(ln)
        if m:
            notes[m.group(1).strip()] = m.group(2).strip()
            lines.append("")  # 保住块边界
        else:
            lines.append(ln)
    blocks: list[Block] = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]

        if not line.strip():
            i += 1
            continue

        if line.strip() == PAGEBREAK_MARK or line.strip() == "<!--pagebreak-->":
            blocks.append(Block("pagebreak"))
            i += 1
            continue

        if line.strip() == SECTIONBREAK_MARK:
            blocks.append(Block("sectionbreak"))
            i += 1
            continue

        m = _COLUMNS_MARK.match(line.strip())
        if m:
            blocks.append(Block("columns", level=max(1, min(6, int(m.group(1))))))
            i += 1
            continue

        if line.strip().startswith("$$"):
            one = _MATH_ONE.match(line.strip())
            if one:
                blocks.append(Block("equation", text=one.group(1).strip()))
                i += 1
                continue
            body = [line.strip()[2:]]
            i += 1
            while i < n and not lines[i].strip().endswith("$$"):
                body.append(lines[i])
                i += 1
            if i < n:
                body.append(lines[i].strip()[:-2])
                i += 1
            tex = "\n".join(body).strip()
            if tex:
                blocks.append(Block("equation", text=tex))
            continue

        m = _IMAGE.match(line.strip())
        if m:
            blocks.append(Block("image", text=m.group(2), alt=m.group(1), title=m.group(3) or ""))
            i += 1
            continue

        m = _FENCE.match(line)
        if m:
            fence, lang = m.group(1), m.group(2)
            body = []
            i += 1
            while i < n and not re.match(r"^\s*" + re.escape(fence[0]) + "{3,}\s*$", lines[i]):
                body.append(lines[i])
                i += 1
            i += 1  # 跳过收尾围栏
            blocks.append(Block("code", text="\n".join(body), lang=lang))
            continue

        m = _HEADING.match(line)
        if m:
            blocks.append(Block("heading", text=m.group(2).strip(), level=len(m.group(1))))
            i += 1
            continue

        if _HR.match(line):
            blocks.append(Block("hr"))
            i += 1
            continue

        # 表格：本行带 | 且下一行是分隔行
        if "|" in line and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
            header = _split_row(line)
            aligns = _aligns(lines[i + 1])
            rows = []
            i += 2
            while i < n and "|" in lines[i] and lines[i].strip():
                cells = _split_row(lines[i])
                if not any(cells):
                    break
                rows.append(cells)
                i += 1
            width = max([len(header)] + [len(r) for r in rows]) if rows else len(header)
            header = header + [""] * (width - len(header))
            rows = [r + [""] * (width - len(r)) for r in rows]
            blocks.append(Block("table", rows=[header] + rows, aligns=aligns))
            continue

        if line.lstrip().startswith(">"):
            body = []
            while i < n and lines[i].lstrip().startswith(">"):
                body.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            blocks.append(Block("quote", text="\n".join(body).strip()))
            continue

        m = _BULLET.match(line)
        if m:
            items = []
            while i < n:
                mm = _BULLET.match(lines[i])
                if mm:
                    items.append((len(mm.group(1).replace("\t", "  ")) // 2, mm.group(2)))
                    i += 1
                    continue
                if lines[i].strip() and not _ORDERED.match(lines[i]) and items and not _HEADING.match(lines[i]):
                    # 懒续行：并进上一条
                    lv, t = items[-1]
                    items[-1] = (lv, t + " " + lines[i].strip())
                    i += 1
                    continue
                break
            blocks.append(Block("bullet", items=items))
            continue

        m = _ORDERED.match(line)
        if m:
            items = []
            while i < n:
                mm = _ORDERED.match(lines[i])
                if mm:
                    items.append((len(mm.group(1).replace("\t", "  ")) // 2, mm.group(3)))
                    i += 1
                    continue
                if lines[i].strip() and not _BULLET.match(lines[i]) and items and not _HEADING.match(lines[i]):
                    lv, t = items[-1]
                    items[-1] = (lv, t + " " + lines[i].strip())
                    i += 1
                    continue
                break
            blocks.append(Block("ordered", items=items))
            continue

        # 普通段落：吃到空行 / 下一个块起始
        body = [line.strip()]
        i += 1
        while i < n:
            nxt = lines[i]
            if not nxt.strip():
                break
            if _HEADING.match(nxt) or _FENCE.match(nxt) or _BULLET.match(nxt) or _ORDERED.match(nxt) or _HR.match(nxt):
                break
            if _IMAGE.match(nxt.strip()):
                break
            if nxt.lstrip().startswith(">"):
                break
            if "|" in nxt and i + 1 < n and _TABLE_SEP.match(lines[i + 1]):
                break
            body.append(nxt.strip())
            i += 1
        blocks.append(Block("para", text="".join(body) if _is_cjk_joinable(body) else " ".join(body)))
    return blocks, notes


def _is_cjk_joinable(parts: list[str]) -> bool:
    """中文换行不该补空格（补了会出"中 文"）。全部片段首尾都是 CJK 时直接拼。"""
    if len(parts) < 2:
        return True
    for a, b in zip(parts, parts[1:]):
        if not (_is_cjk(a[-1:]) and _is_cjk(b[:1])):
            return False
    return True


def _is_cjk(ch: str) -> bool:
    if not ch:
        return False
    cp = ord(ch)
    return 0x2E80 <= cp <= 0x9FFF or 0xF900 <= cp <= 0xFAFF or 0xFF00 <= cp <= 0xFFEF or 0x3000 <= cp <= 0x303F


def inline_runs(text: str) -> list[tuple[str, dict]]:
    """行内样式切分 → [(文字, {bold, italic, code, link, footnote})]。"""
    runs: list[tuple[str, dict]] = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append((text[pos : m.start()], {}))
        tok = m.group(0)
        if tok.startswith("**") or tok.startswith("__"):
            runs.append((tok[2:-2], {"bold": True}))
        elif tok.startswith("`"):
            runs.append((tok[1:-1], {"code": True}))
        elif tok.startswith("*"):
            runs.append((tok[1:-1], {"italic": True}))
        elif tok.startswith("[^"):
            # 脚注标记：文字部分为空，渲染时换成脚注引用（不能进 preflight 文本）
            runs.append(("", {"footnote": tok[2:-1].strip()}))
        else:
            mm = re.match(r"\[([^\]]+)\]\(([^)]+)\)", tok)
            if mm:
                runs.append((mm.group(1), {"link": mm.group(2)}))
            else:
                runs.append((tok, {}))
        pos = m.end()
    if pos < len(text):
        runs.append((text[pos:], {}))
    return runs or [("", {})]


def footnote_refs(text: str) -> list[str]:
    """一段文字里出现的脚注 id（保序去重）。"""
    out: list[str] = []
    for _, fmt in inline_runs(text):
        fid = fmt.get("footnote")
        if fid and fid not in out:
            out.append(fid)
    return out


def plain_text(text: str) -> str:
    """去掉行内标记，只留文字（用于统计/预览）。"""
    return "".join(t for t, _ in inline_runs(text))


def all_text(blocks: list[Block], include_equations: bool = True) -> str:
    """文档全部可读文字，给"字体覆盖预检 / 文本往返"用。

    `include_equations=False` 时把公式源码排除掉 —— 公式在 PDF 里是**图片**，
    抽回来的文字当然没有它，拿它做往返比对会假报警。
    """
    out = []
    for b in blocks:
        if b.kind in ("heading", "para", "quote", "code"):
            out.append(plain_text(strip_anchor(b.text)))
        elif b.kind == "image":
            out.append(b.alt or "")
            out.append(b.title or "")
        elif b.kind == "equation":
            if include_equations:
                out.append(b.text)
        elif b.kind in ("bullet", "ordered"):
            out.extend(plain_text(t) for _, t in b.items)
        elif b.kind == "table":
            for row in b.rows:
                out.extend(plain_text(c) for c in row)
    return "\n".join(out)


def stats(blocks: list[Block]) -> dict:
    kinds: dict[str, int] = {}
    for b in blocks:
        kinds[b.kind] = kinds.get(b.kind, 0) + 1
    return {
        "blocks": len(blocks),
        "by_kind": kinds,
        "chars": len(all_text(blocks)),
    }
