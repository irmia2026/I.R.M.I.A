"""出图与"人眼可查"的检查工具：PNG 统计、contact sheet、字体审计、tofu 线索、文本往返。

这里的原则（对应用户点名的那个坑）：
**自动判据只当线索，人眼必须能看**。所以每个出图动作都产出
①逐页 PNG ②一张 contact sheet ③可量化的读数（墨迹率、空白页、缺字形字符）。
指标认不出"字形缺失"——那要靠 cmap 预检与嵌入字体审计，最后一关永远是人眼看图。
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path

import _common as C
import _font

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as exc:  # pragma: no cover - Pillow 是硬依赖，缺了什么都不用谈
    raise SystemExit(f"需要 Pillow：{exc}")


# ── 单页统计 ────────────────────────────────────────────────────────────────


def png_stats(path) -> dict:
    p = Path(path)
    with Image.open(p) as im:
        w, h = im.size
        gray = im.convert("L")
        hist = gray.histogram()
    total = w * h
    ink = sum(hist[:200])  # 0..199 视为墨迹
    return {
        "path": str(p),
        "width": w,
        "height": h,
        "bytes": p.stat().st_size,
        "ink_ratio": round(ink / total, 5) if total else 0.0,
        "blank": (ink / total) < 0.0006 if total else True,
    }


def _runs(row_bytes: bytes, threshold: int = 160) -> list[tuple[int, int]]:
    """一行像素里的墨迹段 [(x1,x2)]，闭区间。"""
    out = []
    start = None
    for x, v in enumerate(row_bytes):
        if v < threshold:
            if start is None:
                start = x
        elif start is not None:
            out.append((start, x - 1))
            start = None
    if start is not None:
        out.append((start, len(row_bytes) - 1))
    return out


def glyph_box_hint(path, limit: int = 20000) -> dict:
    """**启发式**线索：找"空心矩形轮廓"状的笔画块——缺字形的 .notdef 方块就长这样。

    必须说清它的局限：中文的 口/日/回/目 本身也是矩形轮廓，会被误判。
    所以它只报"疑似"，不当作判据；判据是 cmap 覆盖 + 嵌入字体审计 + 人眼看图。
    """
    p = Path(path)
    with Image.open(p) as im:
        gray = im.convert("L")
        w, h = gray.size
        if w * h > limit * limit:  # 超大图先缩一半，够看轮廓
            gray = gray.resize((w // 2, h // 2))
            w, h = gray.size
        data = gray.tobytes()

    rows: list[dict[tuple[int, int], int]] = []
    bars: list[tuple[int, int, int]] = []  # (y, x1, x2)
    for y in range(h):
        seg = data[y * w : (y + 1) * w]
        rs = _runs(seg)
        rows.append({r: 1 for r in rs if r[1] - r[0] >= 1})
        for r in rs:
            if r[1] - r[0] >= 7:  # 长横条：可能是方块的上下边
                bars.append((y, r[0], r[1]))

    hits = []
    for (y1, x1, x2) in bars:
        span = x2 - x1
        if span < 8 or span > 40:
            continue
        for y2 in range(y1 + 5, min(y1 + 34, h)):
            if (x1, x2) not in rows[y2]:
                continue
            ok = True
            for ymid in range(y1 + 1, y2):
                seg = {r for r in rows[ymid] if r[1] - r[0] <= 3}
                if not any(abs(r[0] - x1) <= 1 for r in seg) or not any(abs(r[1] - x2) <= 1 for r in seg):
                    ok = False
                    break
            if ok:
                hits.append({"x": x1, "y": y1, "w": span, "h": y2 - y1})
                break
        if len(hits) >= 40:
            break
    return {
        "suspicious_hollow_rects": len(hits),
        "samples": hits[:8],
        "note": "启发式；口/日/回/目 也会命中，只当线索，判据请用 cmap 预检与嵌入字体审计",
    }


# ── contact sheet ───────────────────────────────────────────────────────────


def _label_font(size: int):
    fonts = _font.find_cjk_fonts()
    reg = fonts.get("regular")
    if reg:
        try:
            return ImageFont.truetype(reg["path"], size=size, index=reg.get("index", 0))
        except Exception:
            pass
    try:
        return ImageFont.truetype("arial.ttf", size=size)
    except Exception:
        return ImageFont.load_default()


def contact_sheet(images: list[dict], out_path, cols: int = 3, cell_w: int = 520, title: str = "",
                  labels: list[str] | None = None) -> dict:
    """把逐页 PNG 拼成一张总览图（带页号标签），供人眼扫一遍。"""
    paths = [Path(i["path"]) for i in images if Path(i["path"]).exists()]
    if not paths:
        raise C.OfficeError("NothingToSheets", "没有可拼的页面图",
                            next_steps=["先跑 render，确认 PNG 真的产出来了"])
    cols = max(1, min(cols, len(paths)))
    rows_n = (len(paths) + cols - 1) // cols
    pad, head = 18, 64
    thumbs = []
    for p in paths:
        with Image.open(p) as im:
            im = im.convert("RGB")
            ratio = cell_w / im.width
            thumbs.append(im.resize((cell_w, max(1, int(im.height * ratio)))))
    cell_h = max(t.height for t in thumbs)
    W = pad + cols * (cell_w + pad)
    H = head + pad + rows_n * (cell_h + pad + 26)
    sheet = Image.new("RGB", (W, H), (244, 245, 247))
    draw = ImageDraw.Draw(sheet)
    f_title = _label_font(22)
    f_tag = _label_font(16)
    header = title or f"contact sheet · {len(paths)} 页"
    draw.text((pad, 18), header, fill=(28, 32, 38), font=f_title)
    draw.text(
        (pad, 42),
        f"生成于 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} · 每格 1 页 · 原图见同目录 page-*.png",
        fill=(96, 104, 116),
        font=f_tag,
    )
    for idx, thumb in enumerate(thumbs):
        r, c = divmod(idx, cols)
        x = pad + c * (cell_w + pad)
        y = head + r * (cell_h + pad + 26)
        sheet.paste(thumb, (x, y))
        draw.rectangle([x - 1, y - 1, x + cell_w, y + thumb.height], outline=(196, 202, 210))
        tag = labels[idx] if labels and idx < len(labels) else paths[idx].name
        draw.text((x, y + thumb.height + 4), f"P{idx + 1} · {tag}", fill=(64, 72, 84), font=f_tag)
    C.prepare_write(Path(out_path), backup=False)
    sheet.save(out_path, optimize=True)
    return {"path": str(out_path), "pages": len(paths), "width": W, "height": H,
            "bytes": Path(out_path).stat().st_size}


# ── PDF 审计 ────────────────────────────────────────────────────────────────


def _content_bytes(page) -> bytes:
    """把一页的内容流拼起来，用于判断某个字体资源是不是**真的被用来写字**。"""
    import pikepdf

    try:
        c = page.obj.get("/Contents")
        if c is None:
            return b""
        if isinstance(c, pikepdf.Array):
            return b"\n".join(s.read_bytes() for s in c if hasattr(s, "read_bytes"))
        return c.read_bytes()
    except Exception:
        return b""


def pdf_font_audit(pdf_path) -> dict:
    """逐字体看：是否嵌入、什么类型、叫什么、**这一页里有没有真的用到它**。

    只报"用了却没嵌入"的才叫隐患：有些生成器会往每页资源里塞一个默认字体却不用它。
    """
    import pikepdf

    fonts, seen = [], {}
    with pikepdf.open(pdf_path) as pdf:
        for page in pdf.pages:
            content = _content_bytes(page)
            try:
                res = page.get("/Resources", None)
                fdict = res.get("/Font", None) if res is not None else None
            except Exception:
                fdict = None
            if not fdict:
                continue
            for name, font in list(fdict.items()):
                try:
                    base = str(font.get("/BaseFont", "?"))
                    sub = str(font.get("/Subtype", "?"))
                    key = (base, sub, str(name))
                    if key in seen:
                        continue
                    seen[key] = True
                    descriptor = font.get("/FontDescriptor", None)
                    embedded = False
                    files = []
                    candidates = [font]
                    if sub == "/Type0":
                        desc = font.get("/DescendantFonts", None)
                        if desc is not None and len(desc) > 0:
                            candidates.append(desc[0])
                            descriptor = desc[0].get("/FontDescriptor", descriptor)
                    for cand in candidates:
                        fd = cand.get("/FontDescriptor", None) or descriptor
                        if fd is not None:
                            for k in ("/FontFile", "/FontFile2", "/FontFile3"):
                                if k in fd:
                                    embedded = True
                                    files.append(k.lstrip("/"))
                    res_name = str(name).lstrip("/")
                    used = bool(re.search(("/" + re.escape(res_name) + r"(?![0-9A-Za-z+])").encode(), content))
                    fonts.append({
                        "name": base,
                        "subtype": sub,
                        "resource": str(name),
                        "embedded": embedded,
                        "font_files": files,
                        "used_in_content": used,
                    })
                except Exception:
                    continue
        meta = {str(k): str(v) for k, v in (pdf.docinfo or {}).items()}
        pages = len(pdf.pages)
        sizes = []
        for page in pdf.pages[:3]:
            try:
                box = page.MediaBox
                sizes.append([round(float(box[2]) - float(box[0]), 1), round(float(box[3]) - float(box[1]), 1)])
            except Exception:
                sizes.append(None)
    used_fonts = [f for f in fonts if f["used_in_content"]]
    non_embedded = [f["name"] for f in used_fonts if not f["embedded"]]
    return {
        "pages": pages,
        "page_sizes_pt": sizes,
        "encrypted": False,
        "docinfo": meta,
        "fonts": fonts,
        "all_fonts_embedded": (not non_embedded) if fonts else None,
        "non_embedded": non_embedded,
        "unused_font_entries": [f["name"] for f in fonts if not f["used_in_content"]],
    }


def pdf_text_roundtrip(pdf_path, expected_text: str) -> dict:
    """把 PDF 里的文字抽回来，和写进去的逐字对一遍 —— 抓"字被丢掉"这一类问题。"""
    try:
        import pdfplumber
    except Exception as exc:  # pragma: no cover
        return {"available": False, "error": f"pdfplumber 不可用：{exc}"}
    pieces = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            pieces.append(page.extract_text() or "")
    got = "\n".join(pieces)
    compact_got = "".join(ch for ch in got if not ch.isspace())
    missing = []
    seen = set()
    for ch in expected_text:
        if ch.isspace() or ch in seen:
            continue
        seen.add(ch)
        if ch not in compact_got:
            missing.append(ch)
    return {
        "available": True,
        "extracted_chars": len(compact_got),
        "expected_chars": len({c for c in expected_text if not c.isspace()}),
        "missing_chars": missing,
        "roundtrip_ok": not missing,
        "sample": got[:400],
    }


def pdf_to_pngs(pdf_path, out_dir, dpi: int = 120, pages: str | None = None) -> dict:
    """PDF 逐页出 PNG。优先 pypdfium2（快、无外部进程），没有就退到 LibreOffice Kit 的 pdfium 后端。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    images = []
    route = None
    try:
        import pypdfium2 as pdfium

        doc = pdfium.PdfDocument(str(pdf_path))
        total = len(doc)
        idx = _page_indexes(pages, total)
        for i in idx:
            page = doc[i]
            img = page.render(scale=dpi / 72.0).to_pil()
            dst = out / f"page-{i + 1:03d}.png"
            C.prepare_write(dst, backup=False)
            img.save(dst)
            images.append({"index": len(images) + 1, "page": i + 1, "path": str(dst),
                           "width": img.width, "height": img.height})
        route = "pypdfium2"
    except Exception:  # noqa: BLE001
        import _lo

        res = _lo.render(Path(pdf_path), out, dpi=dpi, pages=pages)
        images = res["images"]
        route = "libreoffice-kit"
    return {"route": route, "images": images, "page_count": len(images)}


def _page_indexes(pages: str | None, total: int) -> list[int]:
    if not pages or pages == "all":
        return list(range(total))
    out: list[int] = []
    for part in str(pages).split(","):
        part = part.strip()
        if re.match(r"^\d+-\d+$", part):
            a, b = part.split("-")
            out.extend(range(int(a) - 1, min(int(b), total)))
        elif part.isdigit():
            out.append(int(part) - 1)
    return [i for i in dict.fromkeys(out) if 0 <= i < total]


def render_office_via_pdf(src, out_dir, dpi: int = 144, pages: str | None = None) -> dict:
    """Office 文件出图：先 LibreOffice 转 PDF，再用 pdfium 逐页出 PNG。

    为什么不直接用 libreoffice-kit 的 `render`：实测它的**页面按 dpi/72 出像素、
    内容却按 dpi/96 排版**（同一份 docx 转 PDF 后文字落在 68–525pt，render 出来
    却从 15% 页面宽铺到右边缘被裁掉），框选范围越大裁得越多。转 PDF 再出图没有这个问题。
    """
    import tempfile

    import _lo

    tmp = Path(tempfile.mkdtemp(prefix="office-render-"))
    try:
        pdf = tmp / (Path(src).stem + ".pdf")
        _lo.convert(Path(src), pdf)
        res = pdf_to_pngs(pdf, out_dir, dpi=dpi, pages=pages)
        res["via"] = "convert→pdf→png"
        return res
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)


def summarize_pages(images: list[dict], do_hint: bool = True) -> list[dict]:
    out = []
    for item in images:
        p = Path(item["path"])
        if not p.exists():
            continue
        st = png_stats(p)
        st["page"] = item.get("page") or item.get("index")
        st["sheet"] = item.get("sheet")
        st["range"] = item.get("range")
        if do_hint:
            st["glyph_box_hint"] = glyph_box_hint(p)
        out.append(st)
    return out


def dump_json(path, payload) -> str:
    p = Path(path)
    C.prepare_write(p)
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(p)
