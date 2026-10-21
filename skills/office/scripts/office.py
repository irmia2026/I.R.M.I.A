#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""office.py —— Irmia Office 套件的统一入口（Word / Excel / PDF，一个子命令一条动作）。

约定（SKILL.md 里有完整说明）：
  · 每条动作都支持 `--json`，回执是同一个信封：{ok, action, artifacts, data, warnings, degraded, next}
  · 产物一律落在**当前工作目录**；覆盖已有文件前先备份成 <name>.bak-<时间戳>
  · 第一次用先跑 `python office.py doctor`，缺什么会给出可执行的安装命令

例子：
  python office.py doctor
  python office.py docx build --from 报告.md --out out/报告.docx
  python office.py docx validate --file out/报告.docx
  python office.py pdf build --from 报告.md --out out/报告.pdf --qa-dir out/qa
  python office.py xlsx build --from 表.json --out out/表.xlsx
  python office.py xlsx recalc --file out/表.xlsx
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # 技能目录是只读的，绝不往里落 __pycache__

import argparse
import json
import platform
import traceback
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import _common as C  # noqa: E402

VERSION = "1.0.0"

# Windows 控制台默认是 GBK，中文/符号会炸。这里把两条流钉成 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover - 老 Python / 被重定向
        pass

REQUIRED_MODULES = [
    ("docx", "python-docx", "DOCX 读写"),
    ("openpyxl", "openpyxl", "XLSX 读写"),
    ("reportlab", "reportlab", "PDF 生成（中文字体注册）"),
    ("PIL", "Pillow", "出图 / contact sheet / 图表 / mathtext 之外的绘图"),
    ("lxml", "lxml", "OOXML 解析 + HTML 解析"),
]
OPTIONAL_MODULES = [
    ("pdfplumber", "pdfplumber", "PDF 抽文本/表格/摆放位置"),
    ("pikepdf", "pikepdf", "PDF 拆页/合并/元信息/加密/抽图兜底"),
    ("pypdfium2", "pypdfium2", "PDF → PNG（不经 node 的轻量路线）"),
    ("formulas", "formulas", "无 LibreOffice 时的 Excel 重算降级"),
    ("matplotlib", "matplotlib", "公式 → PNG（PDF 那条路）；也能做更复杂的图"),
    ("pymupdf", "pymupdf", "PDF 抽图（JBIG2/JPX 扫描件）/快速渲染"),
    ("pypdf", "pypdf", "PDF 表单读写（AcroForm）"),
    ("cryptography", "cryptography", "AES 加密 PDF 的底层"),
    ("pygments", "pygments", "代码语法高亮"),
    ("playwright", "playwright", "HTML→PDF 的浏览器路线（Chromium 打印）"),
]

# 逐条依赖的"角色 / 没它会失去什么 / 怎么装"——安装器就照这个填组件
DEP_CATALOG = {
    "python-docx": {"role": "Word 读写", "lose": "docx 全部动作不可用",
                    "pip": "python-docx"},
    "openpyxl": {"role": "Excel 读写", "lose": "xlsx 全部动作不可用", "pip": "openpyxl"},
    "reportlab": {"role": "PDF 生成（含中文）", "lose": "pdf build / from-html 不可用",
                  "pip": "reportlab"},
    "Pillow": {"role": "出图 / contact sheet / 图表", "lose": "所有出图与 chart 不可用",
               "pip": "Pillow"},
    "lxml": {"role": "OOXML 与 HTML 解析", "lose": "docx 校验/批注链、HTML→PDF 不可用",
             "pip": "lxml"},
    "pdfplumber": {"role": "PDF 抽文本/表格", "lose": "pdf text / pdf table 不可用；目录页码量不了",
                   "pip": "pdfplumber"},
    "pikepdf": {"role": "PDF 页操作/元信息/加密", "lose": "pdf split/merge/pages/meta/encrypt 不可用",
                "pip": "pikepdf"},
    "pypdfium2": {"role": "PDF → PNG", "lose": "pdf render 要走 LibreOffice 那条（慢）",
                  "pip": "pypdfium2"},
    "formulas": {"role": "无 LibreOffice 时的 Excel 重算", "lose": "recalc 只剩 calcMode=auto（等于没算）",
                 "pip": "formulas"},
    "matplotlib": {"role": "公式 → PNG（PDF 里的公式）", "lose": "PDF 里公式退化成文本近似排版",
                   "pip": "matplotlib"},
    "pymupdf": {"role": "PDF 抽图（JBIG2/JPX）/快速渲染",
                "lose": "抽图退回 pikepdf（常见编码仍可，扫描件解码不了）", "pip": "pymupdf"},
    "pypdf": {"role": "PDF 表单读写", "lose": "pdf form 不可用", "pip": "pypdf"},
    "cryptography": {"role": "AES 加密 PDF", "lose": "pdf encrypt 的 AES-256 不可用（pikepdf 自带 RC4 仍可）",
                     "pip": "cryptography"},
    "pygments": {"role": "代码语法高亮", "lose": "代码块退化成单色等宽", "pip": "pygments"},
    "playwright": {"role": "HTML→PDF 浏览器路线", "lose": "HTML→PDF 只能走本地链（CSS 分页只认子集）",
                   "pip": "playwright"},
}


def _dist_size_mb(pkg: str) -> float:
    """装了这个包占多少 MB（问 importlib.metadata 的文件清单，别去扫盘）。"""
    try:
        from importlib.metadata import distribution

        dist = distribution(pkg)
        total = 0
        for f in dist.files or []:
            try:
                total += dist.locate_file(f).stat().st_size
            except (OSError, AttributeError):
                pass
        return round(total / (1024 * 1024), 1)
    except Exception:
        return 0.0


def _dep_row(module: str, pkg: str, why: str, kind: str) -> dict:
    info = _module_info(module, pkg)
    meta = DEP_CATALOG.get(pkg, {})
    row = {
        "package": pkg,
        "module": module,
        "kind": kind,
        "role": why,
        "installed": bool(info.get("installed")),
        "version": info.get("version"),
        "size_mb": _dist_size_mb(pkg) if info.get("installed") else 0.0,
        "install": f'"{sys.executable}" -m pip install {meta.get("pip", pkg)}',
        "fallback": meta.get("lose", "对应动作不可用"),
    }
    if not info.get("installed"):
        row["error"] = info.get("error")
    return row


def _playwright_browser() -> dict:
    """playwright 包在不在、浏览器**真能起来**吗（包在≠能用；headless shell 也算）。"""
    out = {"package": bool(_module_info("playwright", "playwright").get("installed")),
           "chromium": False, "path": None, "headless_shell": None}
    if not out["package"]:
        return out
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            out["path"] = pw.chromium.executable_path
            if out["path"] and Path(out["path"]).exists():
                out["chromium"] = True
                return out
            # 只装了 headless shell 也算能用（打印 PDF 不需要完整浏览器）
            try:
                browser = pw.chromium.launch()
                out["headless_shell"] = getattr(browser, "_impl_obj", None) and "headless"
                browser.close()
                out["chromium"] = True
                out["chromium_kind"] = "headless-shell"
            except Exception as exc:  # noqa: BLE001
                out["error"] = f"浏览器起不来：{type(exc).__name__}: {str(exc)[:160]}"
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"{type(exc).__name__}: {str(exc)[:160]}"
    return out


def _pandoc_row() -> dict:
    try:
        import _pandoc

        info = _pandoc.discover()
    except Exception as exc:  # noqa: BLE001
        return {"package": "pandoc", "module": "pandoc", "kind": "binary",
                "role": "md ↔ docx 高保真转换",
                "installed": False, "version": None, "size_mb": 0.0,
                "error": str(exc)[:200],
                "install": "winget install --id JohnMacFarlane.Pandoc -e",
                "fallback": "docx pandoc 不可用；docx build（我们自己的解析）不受影响"}
    return {
        "package": "pandoc", "module": "pandoc", "kind": "binary",
        "role": "md ↔ docx 高保真转换",
        "installed": bool(info["available"]),
        "version": info.get("version"),
        "path": info.get("path"),
        "source": info.get("source"),
        "size_mb": 209.8 if info.get("available") else 0.0,
        "install": info["install"],
        "install_alt": info["install_alt"],
        "fallback": "docx pandoc 不可用；docx build（我们自己的解析）不受影响",
    }


# ══════════════════════════════════════════════════════════════════════════
# doctor
# ══════════════════════════════════════════════════════════════════════════


def _module_info(name: str, pkg: str | None = None) -> dict:
    """探一个包：装没装 + 版本。版本优先问 importlib.metadata（比猜属性名可靠）。"""
    try:
        __import__(name)
    except Exception as exc:  # noqa: BLE001
        return {"installed": False, "error": f"{type(exc).__name__}: {exc}"}
    ver = None
    try:
        from importlib.metadata import version as _dist_version

        ver = _dist_version(pkg or name)
    except Exception:
        mod = sys.modules.get(name)
        for attr in ("__version__", "VERSION", "Version"):
            cand = getattr(mod, attr, None) if mod is not None else None
            if isinstance(cand, (str, int, float)):
                ver = cand
                break
    return {"installed": True, "version": str(ver) if ver else "unknown"}


def cmd_doctor(args) -> dict:
    import _font
    import _lo

    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    required, optional = {}, {}
    missing_required, missing_optional = [], []
    for mod, pkg, why in REQUIRED_MODULES:
        info = _module_info(mod, pkg)
        info["why"] = why
        info["package"] = pkg
        required[mod] = info
        if not info["installed"]:
            missing_required.append(pkg)
    for mod, pkg, why in OPTIONAL_MODULES:
        info = _module_info(mod, pkg)
        info["why"] = why
        info["package"] = pkg
        optional[mod] = info
        if not info["installed"]:
            missing_optional.append(pkg)

    fonts = _font.find_cjk_fonts()
    reg = fonts.get("regular")
    bold = fonts.get("bold")
    cov = _font.coverage(reg["path"], reg.get("index", 0)) if reg else {"count": 0, "ok": False}

    lo = _lo.status()
    pip_cmd = f'"{sys.executable}" -m pip install '
    req_ok = {mod: bool(required[mod]["installed"]) for mod in required}
    opt_ok = {mod: bool(optional[mod]["installed"]) for mod in optional}

    # 逐条依赖（安装器照这张表填 Office 组件）
    deps = [_dep_row(mod, pkg, why, "core") for mod, pkg, why in REQUIRED_MODULES]
    deps += [_dep_row(mod, pkg, why, "feature") for mod, pkg, why in OPTIONAL_MODULES]
    deps.append(_pandoc_row())
    pw = _playwright_browser()
    for row in deps:
        if row["package"] == "playwright":
            row["chromium"] = pw["chromium"]
            row["chromium_path"] = pw["path"]
            row["install_full"] = row["install"] + " && " + \
                f'"{sys.executable}" -m playwright install chromium'
            if row["installed"] and not pw["chromium"]:
                row["installed"] = False
                row["error"] = "playwright 包在，但 Chromium 没下载"
    missing_deps = [d["package"] for d in deps if not d["installed"]]
    pip_mb = round(sum(d.get("size_mb") or 0 for d in deps
                       if d["kind"] in ("core", "feature")), 1)
    ext_mb = round(sum(d.get("size_mb") or 0 for d in deps if d["kind"] == "binary"), 1)
    total_mb = round(pip_mb + ext_mb, 1)
    core_mb = round(sum(d.get("size_mb") or 0 for d in deps if d["kind"] == "core"), 1)
    feature_mb = round(pip_mb - core_mb, 1)

    data = {
        "version": VERSION,
        "python": {"executable": sys.executable, "version": py_ver,
                   "managed": "dsh-runtimes" in sys.executable.lower(),
                   "platform": platform.platform()},
        "cwd": str(C.cwd()),
        "modules": {"required": required, "optional": optional},
        "deps": deps,
        "component": {
            "name": "office",
            "note": "安装器里的 Office 组件：勾了就一次性装下面这些；不勾则一个都不装",
            "installed_run_size_mb": total_mb,
            "pip_size_mb": pip_mb,
            "core_mb": core_mb,
            "feature_mb": feature_mb,
            "external_size_mb": ext_mb,
            "includes_external": ["pandoc（二进制，系统装约 210 MB；也可 pip install pypandoc_binary 221 MB）",
                                  "playwright 的 Chromium（约 130 MB，`playwright install chromium`）",
                                  "LibreOffice（可选，docx/xlsx→PDF 与无损重算要用，约 400 MB）"],
            "install_commands": [
                pip_cmd + "python-docx openpyxl reportlab Pillow lxml pdfplumber pikepdf pypdfium2",
                pip_cmd + "matplotlib pymupdf pypdf cryptography pygments formulas",
                pip_cmd + "playwright && " + f'"{sys.executable}" -m playwright install chromium',
                "winget install --id JohnMacFarlane.Pandoc -e",
                "winget install --id TheDocumentFoundation.LibreOffice -e   # 可选",
            ],
            "if_not_selected": {
                "assertion": "不勾 Office 组件时，这些包一个都不装；仓库里也没有 requirements.txt 或内置 wheel",
                "observable": "此时任何 office.py 动作都会返回 ok=false + error.code=DependencyMissing "
                              "+ 带当前解释器绝对路径的安装命令，且**不写任何产物**（先装再跑）",
                "how_to_verify": f'"{sys.executable}" -m pip list | Select-String '
                                 "python-docx,openpyxl,reportlab,matplotlib,pymupdf",
            },
        },
        "fonts": {
            "regular": reg,
            "bold": bold,
            "cmap_codepoints": cov.get("count", 0),
            "cjk_usable": bool(reg),
            "checked": fonts.get("checked", []),
            "note": "PDF 出中文会用它；缺了就直接失败，绝不画方块",
        },
        "libreoffice": lo,
        "routes": {
            "docx_to_pdf": bool(lo["ready"]),
            "xlsx_recalc_lossless": bool(lo["ready"]),
            "docx_png": bool(lo["ready"]),
            "xlsx_png": bool(lo["ready"]),
            "pdf_png": bool(opt_ok.get("pypdfium2") or lo["ready"]),
            "pdf_split_merge": bool(opt_ok.get("pikepdf")),
            "pdf_extract": bool(opt_ok.get("pdfplumber")),
            "pdf_extract_image": bool(opt_ok.get("pymupdf") or opt_ok.get("pikepdf")) and req_ok.get("PIL"),
            "pdf_extract_image_scan": bool(opt_ok.get("pymupdf")),
            "pdf_form": bool(opt_ok.get("pypdf")),
            "pdf_encrypt": bool(opt_ok.get("pikepdf")),
            "pdf_batch": bool(opt_ok.get("pypdfium2") or lo["ready"]),
            "docx_image": bool(req_ok.get("docx") and req_ok.get("PIL")),
            "docx_comment_reply": bool(req_ok.get("docx") and req_ok.get("lxml")),
            "docx_validate_deep": bool(req_ok.get("lxml")),
            "docx_header_footer": bool(req_ok.get("docx") and req_ok.get("lxml")),
            "docx_toc": bool(req_ok.get("docx") and req_ok.get("lxml")),
            "docx_footnote": bool(req_ok.get("docx") and req_ok.get("lxml")),
            "docx_equation": bool(req_ok.get("docx") and req_ok.get("lxml")),
            "docx_bookmark": bool(req_ok.get("docx") and req_ok.get("lxml")),
            "docx_revision_filter": bool(req_ok.get("lxml")),
            "docx_pandoc": bool(any(d["package"] == "pandoc" and d["installed"] for d in deps)),
            "xlsx_chart": bool(req_ok.get("openpyxl")),
            "xlsx_conditional": bool(req_ok.get("openpyxl")),
            "chart_png": bool(req_ok.get("PIL") and reg),
            "html_to_pdf": bool(req_ok.get("reportlab") and req_ok.get("lxml")),
            "html_to_pdf_playwright": bool(pw["package"] and pw["chromium"]),
            "pdf_code_highlight": bool(opt_ok.get("pygments")),
            "pdf_math_image": bool(opt_ok.get("matplotlib")),
            "pdf_table_three_line": bool(req_ok.get("reportlab")),
            "docx_to_pdf_fallback": "无（本机没有 soffice，也没有 pandoc→pdf 路线）",
        },
        "install": {
            "core": pip_cmd + "python-docx openpyxl reportlab Pillow lxml",
            "pdf": pip_cmd + "pdfplumber pikepdf pypdfium2",
            "feature": pip_cmd + "matplotlib pymupdf pypdf cryptography pygments",
            "playwright": pip_cmd + "playwright && " + f'"{sys.executable}" -m playwright install chromium',
            "pandoc": "winget install --id JohnMacFarlane.Pandoc -e",
            "excel_recalc_fallback": pip_cmd + "formulas",
            "libreoffice": "winget install --id TheDocumentFoundation.LibreOffice -e",
        },
    }
    ready = not missing_required and bool(reg)
    degraded = []
    for row in deps:
        if row["package"] in missing_required:
            continue
        if not row["installed"]:
            degraded.append({
                "capability": row["role"],
                "reason": f'{row["package"]} 没装' + (f'（{row.get("error")}）' if row.get("error") else ""),
                "fallback": f'{row["fallback"]}；装它：{row.get("install_full") or row["install"]}',
            })
    if not lo["ready"]:
        degraded.append({
            "capability": "docx/xlsx → PDF、docx/xlsx → PNG、xlsx 无损重算、目录页码实测",
            "reason": lo.get("error") or "LibreOffice 不可用",
            "fallback": "只做内容不看出图，或者装 LibreOffice（winget 那条命令）",
        })
    routes_off = [k for k, v in data["routes"].items() if v is False]
    payload = {
        "ok": True,
        "action": "doctor",
        "ready": ready,
        "fully_ready": ready and not routes_off,
        "summary": {
            "required_missing": missing_required,
            "optional_missing": missing_optional,
            "deps_missing": missing_deps,
            "installed_run_size_mb": total_mb,
            "cjk_font": bool(reg),
            "libreoffice": lo["ready"],
            "capabilities_on": sum(1 for v in data["routes"].values() if v is True),
            "capabilities_off": len(routes_off),
        },
        "data": data,
        **({"degraded": degraded} if degraded else {}),
        "next": [] if ready else ["按 install.core 装完依赖再重跑 doctor"],
    }
    return payload, (0 if ready else 1)


# ══════════════════════════════════════════════════════════════════════════
# 分发
# ══════════════════════════════════════════════════════════════════════════


def _doctor(args, ctx) -> tuple[dict, int]:
    return cmd_doctor(args)


def _ctx(args) -> dict:
    return {"allow_outside": bool(getattr(args, "allow_outside_cwd", False))}


def _envelope(action: str, result) -> tuple[dict, int]:
    """动作返回值统一成信封：动作给 (data, artifacts, warnings, degraded, notes, next)，
    少数动作（doctor）直接给 (payload, exit_code)。"""
    if isinstance(result, tuple) and len(result) == 2 and isinstance(result[1], int):
        return result
    data, artifacts, warnings, degraded, notes, nexts = result
    payload = {
        "ok": True,
        "action": action,
        **({"data": data} if data else {}),
        **({"artifacts": artifacts} if artifacts else {}),
        **({"warnings": warnings} if warnings else {}),
        **({"degraded": degraded} if degraded else {}),
        **({"notes": notes} if notes else {}),
        **({"next": nexts} if nexts else {}),
    }
    return payload, C.EXIT_OK


# ── docx ───────────────────────────────────────────────────────────────────


def a_docx_build(args, ctx):
    import docx_ops

    out = C.resolve_output(args.out, ctx["allow_outside"])
    src = C.resolve_input(args.from_)
    res = docx_ops.build(src, out, title=args.title, subtitle=args.subtitle,
                         header=args.header, footer=args.footer,
                         page_numbers=args.page_numbers, table_style=args.table_style,
                         cover=args.cover, toc=args.toc, author=args.author,
                         columns=args.columns)
    arts = [{"path": res["out"], "kind": "docx", "bytes": res["bytes"]}]
    warns = list(res["validate"]["warnings"])
    if res.get("cjk_equations"):
        warns.append(f"{res['cjk_equations']} 个公式里有中文：Word 认得（我们写了 eastAsia 字体），"
                     "但 LibreOffice/WPS 的公式引擎只认数学字体，中文可能显示成方块")
    nexts = [f'看文本预览：python office.py docx view --file "{res["out"]}"',
             f'看渲染效果：python office.py docx render --file "{res["out"]}" --out qa/']
    if res["validate"]["status"] == "fail":
        raise C.OfficeError("DocxInvalid", "建出来的文档没过校验：" + "；".join(res["validate"]["errors"][:3]),
                            next_steps=["把 --from 的 Markdown 简化到最小可复现，再报给用户"])
    return res, arts, warns, [], [], nexts


def a_docx_header_footer(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.set_header_footer(path, out, args.header, args.footer, args.page_numbers)
    warns = list(res["validate"]["warnings"])
    return res, [{"path": res["file"], "kind": "docx"}], warns, [], [], \
        [f'读回确认：python office.py docx read-hf --file "{res["file"]}"']


def a_docx_read_hf(args, ctx):
    import docx_ops

    return docx_ops.read_header_footer(C.resolve_input(args.file)), [], [], [], [], []


def a_docx_toc(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    spec = args.levels or "1-3"
    lo, hi = spec.split("-") if "-" in spec else (spec, spec)
    res = docx_ops.insert_toc(path, out, (int(lo), int(hi)), args.after, not args.no_pages)
    warns = list(res["validate"]["warnings"])
    notes = [f'目录域：{res["field"]}',
             f'页码：{res["page_numbers"]}（先量 PDF 再写缓存值，passes={res["passes"]}）']
    nexts = []
    if not res["pages_measured"]:
        warns.append("没法量页码（LibreOffice/pdfplumber 不可用）：目录里写的是占位页码 1，"
                     "Word 打开按 F9 或允许它更新域就会算对")
        nexts.append("让 LibreOffice 可用后重跑 `docx toc`，页码会自动量出来")
    elif res.get("verified") is False:
        warns.append("页码自检没通过（目录插入后版式有位移）：Word 里按 F9 更新一次即可")
    nexts.append(f'出图看一眼目录：python office.py docx render --file "{res["file"]}" --out qa/')
    return res, [{"path": res["file"], "kind": "docx"}], warns, [], notes, nexts


def a_docx_table_style(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.set_table_style_file(path, out, args.style)
    return res, [{"path": res["file"], "kind": "docx"}], \
        list(res["validate"]["warnings"]), [], [], []


def a_docx_footnote(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.add_footnote(path, args.anchor, args.text, out)
    notes = ["复用已有脚注（同锚点同文字不重复插）"] if res.get("reused") else []
    return res, [{"path": res["file"], "kind": "docx"}], [], [], notes, \
        [f'读回确认：python office.py docx footnotes --file "{res["file"]}"']


def a_docx_footnotes(args, ctx):
    import docx_ops

    return docx_ops.read_footnotes(C.resolve_input(args.file)), [], [], [], [], []


def a_docx_section(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.set_columns_file(path, out, args.columns, args.index)
    return res, [{"path": res["file"], "kind": "docx"}], \
        list(res["validate"]["warnings"]), [], [f"分栏数：{args.columns}"], []


def a_docx_bookmark(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.add_bookmark(path, args.anchor, args.name, out)
    return res, [{"path": res["file"], "kind": "docx"}], [], [], [], \
        [f'内链写法：正文里写 [文字](#{res["bookmark"]["name"]})']


def a_docx_bookmarks(args, ctx):
    import docx_ops

    return docx_ops.list_bookmarks(C.resolve_input(args.file)), [], [], [], [], []


def a_docx_equation(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.add_equation(path, args.latex, args.after, not args.inline, out)
    warns = []
    if res.get("cjk_in_formula"):
        warns.append("公式里有中文：Word 认得（我们写了 eastAsia 字体），LibreOffice/WPS 的公式引擎"
                     "只认数学字体，中文可能画成方块 —— 建议把中文放到公式外")
    return res, [{"path": res["file"], "kind": "docx"}], warns, [], [], \
        [f'出图确认：python office.py docx render --file "{res["file"]}" --out qa/']


def a_docx_pandoc(args, ctx):
    import _pandoc

    if args.to_md and not args.file:
        raise C.OfficeError("Usage", "--to-md 要给 --file（源 docx）",
                            next_steps=["docx pandoc --to-md --file a.docx --out a.md"])
    if not args.to_md and not args.from_:
        raise C.OfficeError("Usage", "md → docx 要给 --from（源 Markdown）",
                            next_steps=["docx pandoc --from a.md --out a.docx"])
    out = C.resolve_output(args.out, ctx["allow_outside"])
    if args.to_md:
        src = C.resolve_input(args.file)
        res = _pandoc.docx_to_md(src, out, extract_media=args.extract_media)
        return res, [{"path": res["out"], "kind": "md"}], [], [], \
            [f'pandoc {res["pandoc"]["version"]}（{res["pandoc"]["source"]}）'], []
    src = C.resolve_input(args.from_)
    ref = C.resolve_input(args.reference_doc) if args.reference_doc else None
    res = _pandoc.md_to_docx(src, out, reference_doc=ref, toc=args.toc,
                             number_sections=args.number_sections)
    return res, [{"path": res["out"], "kind": "docx"}], [], [], \
        [f'pandoc {res["pandoc"]["version"]}（{res["pandoc"]["source"]}）'], \
        [f'校验一遍：python office.py docx validate --file "{res["out"]}"']


def a_docx_validate(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    res = docx_ops.validate(path)
    warns = res["warnings"]
    nexts = []
    if res["status"] == "fail":
        nexts = ["先 `docx prep` 拆开看 word/document.xml，再决定是修还是重建"]
    return res, [], warns, [], [], nexts


def a_docx_view(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    res = docx_ops.view(path)
    if args.out:
        out = C.resolve_output(args.out, ctx["allow_outside"])
        C.write_text(out, res["view"])
    return res, ([{"path": C.rel_path(C.resolve_output(args.out, ctx["allow_outside"])), "kind": "text"}]
                 if args.out else []), [], [], [], []


def a_docx_prep(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = docx_ops.prep(path, out)
    arts = [{"path": res["unpacked_dir"], "kind": "dir"},
            {"path": res["view_txt"], "kind": "text"},
            {"path": res["manifest"], "kind": "json"}]
    return res, arts, [], [], [], ["改 XML 后要重新打包成 docx 才能交付"]


def a_docx_xml(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    res = docx_ops.xml_slice(path, part=args.part, xpath=args.xpath,
                             start=args.start, length=args.length, pretty=args.pretty)
    return res, [], [], [], [], []


def a_docx_pack(args, ctx):
    import docx_ops

    src = C.resolve_input(args.from_)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = docx_ops.pack(src, out)
    warns = list(res["validate"]["warnings"])
    if res["validate"]["status"] == "fail":
        raise C.OfficeError("PackInvalid", "打包出来的 docx 没过校验：" + "；".join(res["validate"]["errors"][:3]),
                            next_steps=["回到 unpacked/ 看是不是把 XML 改坏了（对比 prep 时的 manifest.json）",
                                        "实在不行就 `docx prep` 重来一遍"])
    return res, [{"path": res["out"], "kind": "docx", "bytes": res["bytes"]}], warns, [], [], \
        [f'和原件比一比：python office.py docx diff --before <原件> --after "{res["out"]}"']


def a_docx_diff(args, ctx):
    import docx_ops

    before = C.resolve_input(args.before)
    after = C.resolve_input(args.after)
    res = docx_ops.diff(before, after)
    return res, [], [], [], [], []


def a_docx_comment(args, ctx):
    import docx_ops

    if args.ops:
        import json as _json

        path = C.resolve_input(args.file)
        out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
        try:
            ops = _json.loads(C.resolve_input(args.ops).read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise C.OfficeError("BadPlan", f"计划文件不是合法 JSON：{exc}",
                                next_steps=['格式：[{"op":"add","anchor":"…","text":"…"},'
                                            '{"op":"reply","id":"0","text":"…"},{"op":"resolve","id":"0"}]']) from exc
        if isinstance(ops, dict):
            ops = ops.get("ops") or []
        res = docx_ops.run_comment_ops(path, ops, out, dry_run=args.dry_run)
        warns = []
        if res.get("fail_count"):
            warns.append(f"{res['fail_count']} 条操作没成：见 plan 里的 error")
        return res, ([] if args.dry_run else [{"path": res["file"], "kind": "docx"}]), warns, [], \
            (["预演：没有落盘"] if args.dry_run else []), \
            [f'读回确认：python office.py docx comments --file "{res["file"]}"']

    if not args.reply_to and not (args.anchor or "").strip():
        raise C.OfficeError(
            "Usage",
            "加批注要么给 --anchor（挂在哪段文字上），要么给 --reply-to（回复哪条批注），要么给 --ops",
            next_steps=['加新批注：docx comment --file a.docx --anchor "正文一段" --text "批注"',
                        '回复：docx comment --file a.docx --reply-to 0 --text "回复"（id 见 docx comments）'],
        )
    if not (args.text or "").strip():
        raise C.OfficeError("Usage", "加批注 / 回复要给批注正文 --text",
                            next_steps=['--text "这里缺数据来源"'])
    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.add_comment(path, args.anchor, args.text, args.author or "Irmia", out,
                               reply_to=args.reply_to)
    arts = [{"path": res["file"], "kind": "docx"}]
    if res.get("mode") == "reply":
        return res, arts, [], [], [], [f'读回确认：python office.py docx comments --file "{res["file"]}"']
    return res, arts, [], [], [], [f'读回确认：python office.py docx comments --file "{res["file"]}"']


def a_docx_resolve(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.resolve_comment(path, args.id, undo=args.undo, out_docx=out)
    arts = [{"path": res["file"], "kind": "docx"}]
    nexts = [f'读回确认：python office.py docx comments --file "{res["file"]}"']
    if not args.undo:
        nexts.append("Word 里这条批注会显示成「已解决」（w15:done=1）；要撤销就加 --undo")
    return res, arts, [], [], [], nexts


def a_docx_image(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    image = C.resolve_image(args.image, None)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = docx_ops.insert_image(path, image, anchor=args.after, width_cm=args.width_cm,
                                caption=args.caption, out_docx=out)
    arts = [{"path": res["file"], "kind": "docx"}]
    warns = list(res["validate"]["warnings"])
    nexts = [f'出图看一眼：python office.py docx render --file "{res["file"]}" --out qa-docx/']
    if res["validate"]["status"] == "fail":
        raise C.OfficeError("DocxInvalid", "插图后文档没过校验：" + "；".join(res["validate"]["errors"][:3]),
                            next_steps=["把图换成 PNG 再来一次；还不行就 `docx validate` 看包结构"])
    return res, arts, warns, [], [], nexts


def a_docx_comments(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    return docx_ops.read_comments(path), [], [], [], [], []


def a_docx_track(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    if (args.mode or "insert") == "delete":
        res = docx_ops.track_delete(path, args.text, args.after, args.author or "Irmia", out)
    else:
        res = docx_ops.track_insert(path, args.text, args.after, args.author or "Irmia", out,
                                    as_paragraph=args.new_paragraph)
    return res, [{"path": res["file"], "kind": "docx"}], [], [], [], \
        [f'读回：python office.py docx revisions --file "{res["file"]}"']


def a_docx_revisions(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    return docx_ops.list_revisions(path), [], [], [], [], []


def _resolve_common(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    return docx_ops, path, out


def a_docx_accept(args, ctx):
    docx_ops, path, out = _resolve_common(args, ctx)
    res = docx_ops.resolve_revisions_filtered(path, accept=True, out_docx=out,
                                              ids=args.id, authors=args.author)
    warns = []
    if res.get("skipped_count"):
        warns.append(f"{res['skipped_count']} 条修订没被处理（id/作者不在筛选条件里）")
    return res, [{"path": res["file"], "kind": "docx"}], warns, [], [], []


def a_docx_reject(args, ctx):
    docx_ops, path, out = _resolve_common(args, ctx)
    res = docx_ops.resolve_revisions_filtered(path, accept=False, out_docx=out,
                                              ids=args.id, authors=args.author)
    warns = []
    if res.get("skipped_count"):
        warns.append(f"{res['skipped_count']} 条修订没被处理（id/作者不在筛选条件里）")
    return res, [{"path": res["file"], "kind": "docx"}], warns, [], [], []


def a_docx_render(args, ctx):
    import docx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = docx_ops.render(path, out, dpi=args.dpi, pages=args.pages, cols=args.cols, engine=args.engine)
    arts = [{"path": res["contact_sheet"], "kind": "png"}]
    warns = []
    if res["missing_fonts"]:
        warns.append("LibreOffice 缺字体、已用别的字体顶替：%s（版式可能和 Word 不同）"
                     % "、".join(res["missing_fonts"]))
    if res["blank_pages"]:
        warns.append(f"有空白页：{res['blank_pages']}（可能多了一个分页符）")
    degraded = []
    if args.engine == "kit":
        degraded.append({
            "capability": "无裁切的页面图",
            "reason": "libreoffice-kit 的 render 实测把内容放大 4/3 并裁掉右侧（同文档转 PDF 后是正常的）",
            "fallback": "去掉 --engine kit，走默认的 convert→pdf→png",
        })
    return res, arts, warns, degraded, [f"渲染路线：{res['route']}"], \
        ["**必须人眼看 contact sheet**：中文变方块这类问题只能看出来"]


def a_docx_from_office(args, ctx):
    raise C.OfficeError("Unsupported", "docx 只能由 `docx build` 生成，或者用 `pdf from-docx` 反向转 PDF")


# ── xlsx ───────────────────────────────────────────────────────────────────


def a_xlsx_build(args, ctx):
    import xlsx_ops

    src = C.resolve_input(args.from_)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = xlsx_ops.build(src, out)
    warns = list(res["verify"]["warnings"])
    nexts = [f'重算把值算出来：python office.py xlsx recalc --file "{res["out"]}"',
             f'读回确认：python office.py xlsx read --file "{res["out"]}"']
    return res, [{"path": res["out"], "kind": "xlsx", "bytes": res["bytes"]}], warns, [], [], nexts


def a_xlsx_set(args, ctx):
    import xlsx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = xlsx_ops.set_cells(path, [(args.cell, args.value, args.formula)], out)
    return res, [{"path": res["out"], "kind": "xlsx"}], res["verify"]["warnings"], [], [], []


def a_xlsx_verify(args, ctx):
    import xlsx_ops

    path = C.resolve_input(args.file)
    res = xlsx_ops.verify(path)
    nexts = []
    if res["missing_cache_count"]:
        nexts.append(f'python office.py xlsx recalc --file "{C.rel_path(path)}"')
    return res, [], res["warnings"], [], [], nexts


def a_xlsx_recalc(args, ctx):
    import xlsx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    res = xlsx_ops.recalc(path, out, force_route=args.route)
    arts = [{"path": res.get("output"), "kind": "xlsx"}] if res.get("output") else []
    warns = []
    nexts = []
    if not res.get("delivery_file_recalculated"):
        warns.append("交付的 xlsx 里**没有**新算出的缓存值——收件人用不支持公式的阅读器会看到空白/0")
        nexts.append("让 LibreOffice 可用（随 DSH 打包的 libreoffice-kit 就够）再跑一次 recalc，那条会写回缓存")
    return res, arts, warns, [], [], nexts


def a_xlsx_read(args, ctx):
    import xlsx_ops

    path = C.resolve_input(args.file)
    res = xlsx_ops.read(path, sheet=args.sheet, cell_range=args.range)
    return res, [], [], [], [], []


def a_xlsx_render(args, ctx):
    import xlsx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = xlsx_ops.render(path, out, dpi=args.dpi, sheet=args.sheet, cell_range=args.range,
                          engine=args.engine)
    warns = []
    if res["missing_fonts"]:
        warns.append("缺字体被顶替：%s" % "、".join(res["missing_fonts"]))
    degraded = res.pop("degraded", [])
    return res, [{"path": res["contact_sheet"], "kind": "png"}], warns, degraded, \
        [f"渲染路线：{res['route']}"], []


def a_xlsx_chart(args, ctx):
    import xlsx_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    if args.from_:
        import json as _json

        spec = _json.loads(C.resolve_input(args.from_).read_text(encoding="utf-8"))
    else:
        if not args.data:
            raise C.OfficeError("Usage", "要么给 --from 规格 JSON，要么至少给 --data 数据区域",
                                next_steps=['--data "汇总!B1:B4" --categories "汇总!A2:A4" --type bar'])
        spec = {"type": args.type, "data": args.data, "categories": args.categories,
                "title": args.title, "anchor": args.anchor, "x_title": args.x_title,
                "y_title": args.y_title, "grouping": args.grouping}
    res = xlsx_ops.add_chart(path, out, spec, sheet=args.sheet)
    arts = [{"path": res["out"], "kind": "xlsx"}]
    nexts = [f'出图看一眼：python office.py xlsx render --file "{res["out"]}" --out qa-xlsx/']
    notes = []
    if res.get("skipped_existing"):
        notes.append("同标题图表已存在，本次没有重复添加（重跑幂等）")
    if not res["chart_series_ok"]:
        nexts.insert(0, "有图表没有 series，Excel 打开会是空白图：检查 --data 区域是否指到了数据而不是表头")
    warns = list(res.get("warnings") or [])
    degraded = []
    preserved = res.get("preserved") or {}
    if preserved.get("conditional_rules_after", 0) < preserved.get("conditional_rules_before", 0):
        degraded.append({
            "capability": "加图表时保住原有的条件格式",
            "reason": "openpyxl 读写整本工作簿，遇到它不认的扩展块（x14）会丢",
            "fallback": "改用 `xlsx build` 的 charts 字段一次性写入；或者先加图表、再在 Excel 里补条件格式",
        })
    return res, arts, warns, degraded, notes, nexts


# ── chart ──────────────────────────────────────────────────────────────────


def a_chart_build(args, ctx):
    import _chart
    import _render

    src = C.resolve_input(args.from_)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    spec = _chart.load_spec(src)
    res = _chart.render(spec, out)
    qa_dir = C.resolve_output(args.qa_dir, ctx["allow_outside"]) if args.qa_dir else out.parent
    qa_dir.mkdir(parents=True, exist_ok=True)
    sheet = _render.contact_sheet(
        [{"path": res["path"]}], qa_dir / f"{out.stem}-contact-sheet.png", cols=1,
        title=f"{out.name} · {res['type']} · 人眼看一眼",
        labels=[f"{res['width']}×{res['height']} · {res['points']} 个数据点"],
    )
    stats = _render.png_stats(res["path"])
    res.update({"path": C.rel_path(out), "contact_sheet": C.rel_path(sheet["path"]),
                "ink_ratio": stats["ink_ratio"], "blank": stats["blank"]})
    arts = [{"path": res["path"], "kind": "png", "bytes": res["bytes"]},
            {"path": res["contact_sheet"], "kind": "png"}]
    notes = [f"字形预检：{res['preflight']['checked_chars']} 个字符全在 {res['preflight']['font']} 里",
             f"画布 {res['width']}×{res['height']}，墨迹率 {res['ink_ratio']}",
             "不引 matplotlib：Pillow 画的，缺字形**先报错**而不是画出方块"]
    warns = []
    if res["blank"]:
        warns.append("图看着是空白的（墨迹率极低）：检查 series/values 是不是全是 0")
    nexts = [f'插进 Word：python office.py docx image --file out/report.docx --image {res["path"]} --caption "图 1 …"',
             f'插进 PDF：在 Markdown 里写 ![]({res["path"]})，再跑 pdf build']
    return res, arts, warns, [], notes, nexts


def a_chart_example(args, ctx):
    import json as _json

    import _chart

    payload = _chart.EXAMPLE_SPEC
    if args.out:
        out = C.resolve_output(args.out, ctx["allow_outside"])
        C.write_text(out, _json.dumps(payload, ensure_ascii=False, indent=2))
        return ({"out": C.rel_path(out), "spec": payload},
                [{"path": C.rel_path(out), "kind": "json"}], [], [], [],
                [f'画出来：python office.py chart build --from {C.rel_path(out)} --out out/chart.png'])
    return {"spec": payload}, [], [], [], [], \
        ["把它存成文件：python office.py chart example --out chart.json"]


# ── pdf ────────────────────────────────────────────────────────────────────


def _pdf_build_receipt(res: dict, args, ctx) -> tuple[dict, list, list, list, list, list]:
    """把 pdf build / pdf from-html 共用的一段做完：产物、字体读数、可选出图、下一步。"""
    import pdf_ops

    out = C.resolve_input(res["result"]["out"])
    arts = [{"path": res["result"]["out"], "kind": "pdf", "bytes": res["result"]["bytes"]}]
    notes = [f'字体：{res["result"]["font"]["regular"]}#{res["result"]["font"]["index"]}'
             f'（粗体 {"同款" if res["result"]["font"]["bold_shared"] else res["result"]["font"]["bold"]}）',
             f'预检：{res["result"]["preflight"]["checked_chars"]} 个字符全部有字形',
             f'字体嵌入：{"全部嵌入" if res["result"]["font_audit"]["all_embedded"] else "有未嵌入的"}',
             f'文本往返：{res["result"]["text_roundtrip"].get("extracted_chars", "?")} 字抽回，'
             f'缺 {len(res["result"]["text_roundtrip"].get("missing_chars", []))} 个']
    if res["result"].get("images"):
        notes.append(f'插图：{res["result"]["images"]} 张（图注来自 Markdown 的 alt 文字）')
    if res["result"].get("equations"):
        notes.append(f'公式：{res["result"]["equations"]} 条（PDF 里是 mathtext 渲染的图；'
                     "docx 那边是 Word 原生公式）")
    if res["result"].get("table_style"):
        notes.append(f'表格样式：{res["result"]["table_style"]}')
    hl = res["result"].get("code_highlight") or {}
    if hl:
        notes.append(f'代码高亮：{hl.get("highlighted", 0)} 段着色 / {hl.get("plain", 0)} 段纯文本'
                     + (f'（lexer：{"、".join(sorted(set(hl.get("lexers") or [])))}）' if hl.get("lexers") else ""))
    if res["result"].get("encoding"):
        notes.append(f'HTML 解码：{res["result"]["encoding"]}')
    if args.from_.lower().endswith((".html", ".htm")):
        notes.append(f'HTML 引擎：{res["result"].get("engine")}（auto = 先试浏览器，失败落本地链）')
    warnings = list(res["warnings"])
    if args.qa_dir:
        qa = C.resolve_output(args.qa_dir, ctx["allow_outside"])
        render = pdf_ops.render_pages(out, qa, dpi=args.dpi, cols=3, title=f"{out.name} · 中文渲染检查")
        arts.append({"path": render["contact_sheet"], "kind": "png"})
        res["result"]["render"] = render
        hints = sum(p["glyph_box_hint"]["suspicious_hollow_rects"] for p in render["pages"])
        notes.append(f'出图：{render["page_count"]} 页，平均墨迹率 {render["mean_ink_ratio"]}，'
                     f'空心方块线索 {hints} 个（线索而已，看 contact sheet 定论）')
        if render["blank_pages"]:
            warnings.append(f"有空白页：{render['blank_pages']}")
        if hints >= 25:
            warnings.append(
                f"空心方块线索 {hints} 个、偏多：先看 contact sheet，真是一排排方块就说明字体没生效"
                "（口/日/回/目 本身也会被算法命中，别只看这个数）"
            )
        nexts = [f'**人眼看这张图**：{render["contact_sheet"]}']
    else:
        nexts = [f'出图做肉眼检查：python office.py pdf render --file "{res["result"]["out"]}" --out qa/']
    return res["result"], arts, warnings, res.get("degraded") or [], notes, nexts


def a_pdf_build(args, ctx):
    import pdf_ops

    src = C.resolve_input(args.from_)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.build(src, out, title=args.title, author=args.author, page_size=args.page_size,
                        font_path=args.font, font_index=args.font_index,
                        table_style=args.table_style, highlight=not args.no_highlight,
                        columns=args.columns)
    return _pdf_build_receipt(res, args, ctx)


def a_pdf_from_html(args, ctx):
    import pdf_ops

    src = C.resolve_input(args.from_)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.build_html(src, out, title=args.title, author=args.author,
                             page_size=args.page_size, font_path=args.font,
                             font_index=args.font_index, engine=args.engine)
    return _pdf_build_receipt(res, args, ctx)


def a_pdf_form(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    if args.info or not args.set:
        res = pdf_ops.form_info(path)
        nexts = ["填值：pdf form --file a.pdf --set name=张三 --out b.pdf"] if res["fields"] else \
            ["这份 PDF 没有 AcroForm 字段（扫描件/普通 PDF 都没有）"]
        return res, [], [], [], [], nexts
    values = {}
    for pair in args.set or []:
        if "=" not in pair:
            raise C.OfficeError("BadArg", f"--set 要写成 key=value：{pair!r}")
        k, v = pair.split("=", 1)
        values[k.strip()] = v
    out = C.resolve_output(args.out, ctx["allow_outside"]) if args.out else None
    if out is None:
        raise C.OfficeError("Usage", "填表单必须给 --out（不要原地改别人的 PDF）",
                            next_steps=["示例：pdf form --file a.pdf --set name=张三 --out b.pdf"])
    res = pdf_ops.form_fill(path, out, values)
    warns = [] if res["all_applied"] else ["填进去的值读回来对不上：部分阅读器需要我们重生成外观"]
    return res, [{"path": res["out"], "kind": "pdf"}], warns, [], \
        ["是否需要扁平化（把表单值烧进内容流）取决于收件人：AcroForm 值多数阅读器都认"], \
        [f'出图确认外观：python office.py pdf render --file "{res["out"]}" --out qa-form/']


def a_pdf_encrypt(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.encrypt_pdf(path, out, args.password, args.owner_password, args.algorithm)
    warns = []
    if not res["requires_password"]:
        warns.append("加密后居然不用密码就能打开——这个结果不可信，别交付")
    if not res["opens_with_password"]:
        warns.append("用给定密码打不开自己加密的文件：请立刻用 --decrypt 验证")
    return res, [{"path": res["out"], "kind": "pdf"}], warns, [], \
        [f'算法 {res["algorithm"]}（R={res["revision"]}）'], \
        [f'验证：python office.py pdf info --file "{res["out"]}" 会报 encrypted=true']


def a_pdf_decrypt(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.decrypt_pdf(path, out, args.password)
    return res, [{"path": res["out"], "kind": "pdf"}], [], [], [], []


def a_pdf_image(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.extract_images(path, out, pages=args.pages, batch=args.batch)
    arts = [{"path": C.rel_path(Path(i["path"])), "kind": "png"} for i in res["images"][:8]]
    if res.get("contact_sheet"):
        arts.insert(0, {"path": res["contact_sheet"], "kind": "png"})
    warns = []
    degr = []
    if res["skipped"]:
        reasons = sorted({str(s.get("reason", ""))[:60] for s in res["skipped"]})
        warns.append(f"{len(res['skipped'])} 张图解不出来：{reasons[:2]}")
        degr.append({
            "capability": "这部分图的导出",
            "reason": "MuPDF 也解不了（加密流/异常色彩空间），区域渲染兜底也没成",
            "fallback": "用 `office.py pdf render --file a.pdf --out qa/` 把整页截成 PNG，人眼看一样",
        })
    nexts = []
    if not res["image_count"]:
        nexts = ["这份 PDF 里没有可导的内嵌位图（矢量图不算）：要图就 `pdf render` 截整页"]
    else:
        nexts = [f'**人眼看这张图**：{res["contact_sheet"]}']
    notes = [res["note"], f'引擎：{res.get("engine")}（MuPDF 能解 JBIG2/JPX 扫描件；没有就退 pikepdf）']
    return res, arts, warns, degr, notes, nexts


def a_pdf_inspect(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    res = pdf_ops.inspect(path)
    warns = []
    if res.get("all_fonts_embedded") is False:
        warns.append("有字体没嵌入：%s（换机器可能变样）" % "、".join(res.get("non_embedded", [])))
    if res.get("empty_pages"):
        warns.append(f"空白页：{res['empty_pages']}")
    return res, [], warns, [], [], []


def a_pdf_text(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    res = pdf_ops.extract_text(path, pages=args.pages)
    arts = []
    if args.out:
        out = C.resolve_output(args.out, ctx["allow_outside"])
        C.write_text(out, res["text"])
        arts.append({"path": C.rel_path(out), "kind": "text"})
    return res, arts, [], [], [], []


def a_pdf_table(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    res = pdf_ops.extract_tables(path, pages=args.pages)
    arts = []
    if args.out:
        out = C.resolve_output(args.out, ctx["allow_outside"])
        if out.suffix.lower() == ".json":
            import json as _json

            C.prepare_write(out)
            out.write_text(_json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            C.write_text(out, res["markdown"] or "（没抽到表格）")
        arts.append({"path": C.rel_path(out), "kind": "text"})
    nexts = []
    if res["table_count"] == 0:
        nexts = ["没抽到表格：扫描件本来就没有文字层；有文字层的表格先 `pdf text` 看一下行结构"]
    return res, arts, [], [], [], nexts


def a_pdf_split(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.pages_split(path, out, per_page=not args.chunk, chunk=args.chunk or 1)
    arts = [{"path": o["path"], "kind": "pdf"} for o in res["outputs"]]
    return res, arts, [], [], [], []


def a_pdf_merge(args, ctx):
    import pdf_ops

    files = [C.resolve_input(f) for f in args.files]
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.pages_merge(files, out)
    return res, [{"path": res["out"], "kind": "pdf"}], [], [], [], []


def a_pdf_pages(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.pages_transform(path, out, rotate=args.rotate, drop=args.drop, keep=args.keep,
                                  crop=args.crop)
    return res, [{"path": res["out"], "kind": "pdf"}], [], [], [], []


def a_pdf_meta(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    changes = {}
    for pair in args.set or []:
        if "=" not in pair:
            raise C.OfficeError("BadArg", f"--set 要写成 key=value：{pair!r}")
        k, v = pair.split("=", 1)
        changes[k.strip().lower()] = v
    if not changes:
        return pdf_ops.meta_get(path), [], [], [], [], []
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.meta_set(path, out, title=changes.get("title"), author=changes.get("author"),
                           subject=changes.get("subject"), keywords=changes.get("keywords"))
    return res, [{"path": res["out"], "kind": "pdf"}], [], [], [], []


def a_pdf_render(args, ctx):
    import pdf_ops

    path = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.render_pages(path, out, dpi=args.dpi, pages=args.pages, cols=args.cols,
                               batch=args.batch)
    warns = []
    if res["blank_pages"]:
        warns.append(f"空白页：{res['blank_pages']}")
    hints = sum(p["glyph_box_hint"]["suspicious_hollow_rects"] for p in res["pages"])
    arts = [{"path": s["path"], "kind": "png"} for s in res["contact_sheets"]] or \
           ([{"path": res["contact_sheet"], "kind": "png"}] if res.get("contact_sheet") else [])
    notes = [f"空心方块线索 {hints} 个（口/日/回 也会命中，只当线索）"]
    if res.get("chunked"):
        notes.append(f"页数多，按 {res['batch']} 页/批分 {res['batches']} 批出图"
                     f"（每批一张 contact sheet）")
    return res, arts, warns, [], notes, \
        ["**人眼看 contact sheet**：字形缺失/缺字 tofu 只能看出来"]


def a_pdf_from_docx(args, ctx):
    import pdf_ops

    src = C.resolve_input(args.file)
    out = C.resolve_output(args.out, ctx["allow_outside"])
    res = pdf_ops.from_office(src, out)
    warns = []
    if res.get("missing_fonts"):
        warns.append("LibreOffice 缺字体被顶替：%s" % "、".join(res["missing_fonts"]))
    if res.get("all_fonts_embedded") is False:
        warns.append("转换后的 PDF 有未嵌入字体")
    return res, [{"path": res["out"], "kind": "pdf"}], warns, [], [], \
        [f'出图确认：python office.py pdf render --file "{res["out"]}" --out qa/']


# ══════════════════════════════════════════════════════════════════════════
# argparse
# ══════════════════════════════════════════════════════════════════════════


class Parser(argparse.ArgumentParser):
    def error(self, message):  # 用法错误走 JSON 回执，不许半截 stack
        raise C.OfficeError("Usage", f"{message}\n用法见：python office.py --help",
                            next_steps=["`python office.py <组> <动作> --help` 看单个动作的参数"])


def build_parser() -> Parser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="只打 JSON 回执（她读这个）")
    common.add_argument("--allow-outside-cwd", action="store_true",
                        help="允许把产物写到当前工作目录之外（默认禁止）")

    p = Parser(prog="office.py", description="Irmia Office 套件：Word / Excel / PDF 一条命令一个动作",
               formatter_class=argparse.RawDescriptionHelpFormatter, parents=[common])
    p.add_argument("--version", action="version", version=f"office.py {VERSION}")
    groups = p.add_subparsers(dest="group")

    # doctor
    d = groups.add_parser("doctor", parents=[common], help="依赖自检：缺什么、怎么装")
    d.set_defaults(func=_doctor, action_name="doctor")

    # ── docx ──
    g = groups.add_parser("docx", help="Word 文档")
    sub = g.add_subparsers(dest="action")

    b = sub.add_parser("build", parents=[common], help="Markdown → docx（可带页眉页脚/目录/封面/分栏）")
    b.add_argument("--from", dest="from_", required=True, help="Markdown 源文件")
    b.add_argument("--out", required=True, help="输出 .docx")
    b.add_argument("--title", help="封面标题（可选）")
    b.add_argument("--subtitle", help="副标题（可选）")
    b.add_argument("--author", help="封面作者（--cover 时用）")
    b.add_argument("--cover", action="store_true", help="生成封面页（标题/副标题/作者/日期 + 分页）")
    b.add_argument("--header", help="页眉文字（{page} / {pages} 换成真域）")
    b.add_argument("--footer", help="页脚文字（{page} / {pages} 换成真域）")
    b.add_argument("--page-numbers", action="store_true", help="页脚加「第 X 页 / 共 Y 页」")
    b.add_argument("--table-style", choices=["three-line", "grid"], help="表格样式（三线表/网格）")
    b.add_argument("--toc", action="store_true", help="插目录域（页码用 PDF 实测值）")
    b.add_argument("--columns", type=int, help="全文分栏（1-6）")
    b.set_defaults(func=a_docx_build, action_name="docx.build")

    hf = sub.add_parser("header-footer", parents=[common], help="给既有文档写页眉页脚/页码")
    hf.add_argument("--file", required=True)
    hf.add_argument("--header", help="页眉文字（{page}/{pages} 换域）")
    hf.add_argument("--footer", help="页脚文字")
    hf.add_argument("--page-numbers", action="store_true", help="页脚加「第 X 页 / 共 Y 页」")
    hf.add_argument("--out")
    hf.set_defaults(func=a_docx_header_footer, action_name="docx.header-footer")

    rhf = sub.add_parser("read-hf", parents=[common], help="读回每节的页眉页脚与域")
    rhf.add_argument("--file", required=True)
    rhf.set_defaults(func=a_docx_read_hf, action_name="docx.read-hf")

    tc = sub.add_parser("toc", parents=[common], help="插目录（TOC 域 + 书签 + 真页码缓存）")
    tc.add_argument("--file", required=True)
    tc.add_argument("--out")
    tc.add_argument("--levels", default="1-3", help="收哪几级标题（默认 1-3）")
    tc.add_argument("--after", help="插在这段文字之后（默认插在第一个标题之前，自动跳过封面）")
    tc.add_argument("--no-pages", action="store_true", help="不量页码（只写域，等 Word 自己更新）")
    tc.set_defaults(func=a_docx_toc, action_name="docx.toc")

    ts = sub.add_parser("table-style", parents=[common], help="改表格样式（三线表/网格）")
    ts.add_argument("--file", required=True)
    ts.add_argument("--style", required=True, choices=["three-line", "grid"])
    ts.add_argument("--out")
    ts.set_defaults(func=a_docx_table_style, action_name="docx.table-style")

    fn = sub.add_parser("footnote", parents=[common], help="插一条真脚注（word/footnotes.xml）")
    fn.add_argument("--file", required=True)
    fn.add_argument("--anchor", required=True, help="脚注挂在哪段文字后面")
    fn.add_argument("--text", required=True, help="脚注正文")
    fn.add_argument("--out")
    fn.set_defaults(func=a_docx_footnote, action_name="docx.footnote")

    fns = sub.add_parser("footnotes", parents=[common], help="列出脚注与正文引用数")
    fns.add_argument("--file", required=True)
    fns.set_defaults(func=a_docx_footnotes, action_name="docx.footnotes")

    sec = sub.add_parser("section", parents=[common], help="设置分栏（w:cols）")
    sec.add_argument("--file", required=True)
    sec.add_argument("--columns", type=int, required=True, help="1-6")
    sec.add_argument("--index", type=int, help="只改第几节（默认全部）")
    sec.add_argument("--out")
    sec.set_defaults(func=a_docx_section, action_name="docx.section")

    bm = sub.add_parser("bookmark", parents=[common], help="给一段文字起书签（内链跳转目标）")
    bm.add_argument("--file", required=True)
    bm.add_argument("--anchor", required=True)
    bm.add_argument("--name", help="书签名（默认按文字派生）")
    bm.add_argument("--out")
    bm.set_defaults(func=a_docx_bookmark, action_name="docx.bookmark")

    bms = sub.add_parser("bookmarks", parents=[common], help="列出书签与配对情况")
    bms.add_argument("--file", required=True)
    bms.set_defaults(func=a_docx_bookmarks, action_name="docx.bookmarks")

    eq = sub.add_parser("equation", parents=[common], help="插 Word 原生公式（LaTeX → OMML）")
    eq.add_argument("--file", required=True)
    eq.add_argument("--latex", required=True, help=r"例如 \frac{a}{b} 或 \sum_{i=1}^{n} x_i")
    eq.add_argument("--after", help="插在这段文字之后（默认文末）")
    eq.add_argument("--inline", action="store_true", help="行内公式（默认独占一行）")
    eq.add_argument("--out")
    eq.set_defaults(func=a_docx_equation, action_name="docx.equation")

    pd = sub.add_parser("pandoc", parents=[common], help="pandoc 路线：md → docx")
    pd.add_argument("--from", dest="from_", help="Markdown 源（--to-md 时不用给）")
    pd.add_argument("--out", required=True, help="输出 .docx")
    pd.add_argument("--reference-doc", help="参考样式文档（.docx）")
    pd.add_argument("--toc", action="store_true", help="让 pandoc 生成目录")
    pd.add_argument("--number-sections", action="store_true", help="章节自动编号")
    pd.add_argument("--to-md", action="store_true", help="反向：docx → Markdown")
    pd.add_argument("--file", help="--to-md 时的输入 docx")
    pd.add_argument("--extract-media", action="store_true", help="--to-md 时把图导出到同名目录")
    pd.set_defaults(func=a_docx_pandoc, action_name="docx.pandoc")

    v = sub.add_parser("validate", parents=[common], help="OOXML/OPC 结构校验")
    v.add_argument("--file", required=True)
    v.set_defaults(func=a_docx_validate, action_name="docx.validate")

    w = sub.add_parser("view", parents=[common], help="抽取文本预览（给模型读）")
    w.add_argument("--file", required=True)
    w.add_argument("--out", help="把预览另存成 txt")
    w.set_defaults(func=a_docx_view, action_name="docx.view")

    pr = sub.add_parser("prep", parents=[common], help="拆包 + view.txt + manifest")
    pr.add_argument("--file", required=True)
    pr.add_argument("--out", required=True, help="输出目录")
    pr.set_defaults(func=a_docx_prep, action_name="docx.prep")

    x = sub.add_parser("xml", parents=[common], help="取某个部件的 XML 切片")
    x.add_argument("--file", required=True)
    x.add_argument("--part", default="word/document.xml")
    x.add_argument("--xpath", help="例如 //w:p[3]（命名空间 w/r/a 已内置）")
    x.add_argument("--start", type=int, default=0)
    x.add_argument("--length", type=int, default=4000)
    x.add_argument("--pretty", action="store_true")
    x.set_defaults(func=a_docx_xml, action_name="docx.xml")

    pk = sub.add_parser("pack", parents=[common], help="把 prep 拆出来的目录重新打成 docx")
    pk.add_argument("--from", dest="from_", required=True, help="prep 产出的 unpacked 目录")
    pk.add_argument("--out", required=True, help="输出 .docx")
    pk.set_defaults(func=a_docx_pack, action_name="docx.pack")

    df = sub.add_parser("diff", parents=[common], help="比对两个 docx（部件级 + 正文文字差异）")
    df.add_argument("--before", required=True)
    df.add_argument("--after", required=True)
    df.set_defaults(func=a_docx_diff, action_name="docx.diff")

    cm = sub.add_parser("comment", parents=[common],
                        help="加批注（--reply-to 时是回复某条批注）")
    cm.add_argument("--file", required=True)
    cm.add_argument("--anchor", help="要挂批注的文字（回复时不需要）")
    cm.add_argument("--text", help="批注正文（--ops 时可省）")
    cm.add_argument("--author", default="Irmia")
    cm.add_argument("--reply-to", help="回复哪条批注（批注 id，见 docx comments）")
    cm.add_argument("--ops", help="批量计划 JSON：add/reply/resolve/unresolve 一串跑完")
    cm.add_argument("--dry-run", action="store_true", help="配合 --ops：只预演不落盘")
    cm.add_argument("--out", help="另存（默认原地改，会先备份）")
    cm.set_defaults(func=a_docx_comment, action_name="docx.comment")

    rs = sub.add_parser("resolve", parents=[common], help="把批注标记成已解决 / 撤销（w15:done）")
    rs.add_argument("--file", required=True)
    rs.add_argument("--id", required=True, help="批注 id（见 docx comments）")
    rs.add_argument("--undo", action="store_true", help="撤销「已解决」")
    rs.add_argument("--out")
    rs.set_defaults(func=a_docx_resolve, action_name="docx.resolve")

    im = sub.add_parser("image", parents=[common], help="往文档里插一张图（可带图注、可锚定位置）")
    im.add_argument("--file", required=True)
    im.add_argument("--image", required=True, help="图片文件（PNG/JPEG）")
    im.add_argument("--after", help="插在这段文字所在的段落之后（默认放文末）")
    im.add_argument("--width-cm", type=float, help="宽度（cm）；不给就按版心自适应")
    im.add_argument("--caption", help="图注；给了它，重跑同一命令会替换而不是重复堆图")
    im.add_argument("--out")
    im.set_defaults(func=a_docx_image, action_name="docx.image")

    cms = sub.add_parser("comments", parents=[common], help="列出批注（读回）")
    cms.add_argument("--file", required=True)
    cms.set_defaults(func=a_docx_comments, action_name="docx.comments")

    tk = sub.add_parser("track", parents=[common], help="插入一条修订（w:ins）")
    tk.add_argument("--file", required=True)
    tk.add_argument("--text", required=True, help="要插入（或标删）的文字")
    tk.add_argument("--after", help="锚点文字（找不到就报错）")
    tk.add_argument("--author", default="Irmia")
    tk.add_argument("--out")
    tk.add_argument("--mode", choices=["insert", "delete"], default="insert",
                    help="insert=插入修订（默认），delete=把已有文字标成删除修订")
    tk.add_argument("--new-paragraph", action="store_true", help="插成新段落（默认接在锚点段落末尾）")
    tk.set_defaults(func=a_docx_track, action_name="docx.track")

    rv = sub.add_parser("revisions", parents=[common], help="列出修订")
    rv.add_argument("--file", required=True)
    rv.set_defaults(func=a_docx_revisions, action_name="docx.revisions")

    ac = sub.add_parser("accept", parents=[common], help="接受全部修订")
    ac.add_argument("--file", required=True)
    ac.add_argument("--out")
    ac.add_argument("--id", action="append", help="只接受这些修订 id（可多次）")
    ac.add_argument("--author", action="append", help="只接受这个作者的修订（可多次）")
    ac.set_defaults(func=a_docx_accept, action_name="docx.accept")

    rj = sub.add_parser("reject", parents=[common], help="拒绝全部修订")
    rj.add_argument("--file", required=True)
    rj.add_argument("--out")
    rj.add_argument("--id", action="append", help="只拒绝这些修订 id（可多次）")
    rj.add_argument("--author", action="append", help="只拒绝这个作者的修订（可多次）")
    rj.set_defaults(func=a_docx_reject, action_name="docx.reject")

    rd = sub.add_parser("render", parents=[common], help="LibreOffice 渲染成 PNG + contact sheet")
    rd.add_argument("--file", required=True)
    rd.add_argument("--out", required=True, help="输出目录（必须不存在或为空）")
    rd.add_argument("--dpi", type=int, default=144)
    rd.add_argument("--pages", help="1,2-3（默认全部）")
    rd.add_argument("--cols", type=int, default=2, help="contact sheet 每行几页")
    rd.add_argument("--engine", choices=["pdf", "kit"], default="pdf",
                    help="pdf=先转 PDF 再出图（默认、不裁切）；kit=直接用 libreoffice-kit render（实测会裁右侧）")
    rd.set_defaults(func=a_docx_render, action_name="docx.render")

    # ── xlsx ──
    g = groups.add_parser("xlsx", help="Excel 工作簿")
    sub = g.add_subparsers(dest="action")

    b = sub.add_parser("build", parents=[common], help="按 JSON 规格建表")
    b.add_argument("--from", dest="from_", required=True, help="JSON 规格文件")
    b.add_argument("--out", required=True)
    b.set_defaults(func=a_xlsx_build, action_name="xlsx.build")

    s = sub.add_parser("set", parents=[common], help="写一个单元值/公式")
    s.add_argument("--file", required=True)
    s.add_argument("--cell", required=True, help='如 Sheet1!B3 或 B3')
    s.add_argument("--value", required=True)
    s.add_argument("--formula", action="store_true", help="把 --value 当公式（= 可省）")
    s.add_argument("--out", help="另存（默认原地改，会先备份）")
    s.set_defaults(func=a_xlsx_set, action_name="xlsx.set")

    vf = sub.add_parser("verify", parents=[common], help="静态体检（缓存值/错误值/禁用函数）")
    vf.add_argument("--file", required=True)
    vf.set_defaults(func=a_xlsx_verify, action_name="xlsx.verify")

    rc = sub.add_parser("recalc", parents=[common], help="重算（LibreOffice 优先，formulas 兜底）")
    rc.add_argument("--file", required=True)
    rc.add_argument("--out", help="输出文件（默认 <name>_recalc.xlsx）")
    rc.add_argument("--route", choices=["libreoffice", "formulas"], help="强制某条路（默认自动）")
    rc.set_defaults(func=a_xlsx_recalc, action_name="xlsx.recalc")

    rdx = sub.add_parser("read", parents=[common], help="读回值/公式/缓存")
    rdx.add_argument("--file", required=True)
    rdx.add_argument("--sheet")
    rdx.add_argument("--range", help="A1:C5")
    rdx.set_defaults(func=a_xlsx_read, action_name="xlsx.read")

    rd = sub.add_parser("render", parents=[common], help="工作表出图 + contact sheet")
    rd.add_argument("--file", required=True)
    rd.add_argument("--out", required=True)
    rd.add_argument("--dpi", type=int, default=130)
    rd.add_argument("--sheet")
    rd.add_argument("--range", help="只渲染这个区域，如 A1:H30（会切到 kit 路线，图只作参考）")
    rd.add_argument("--engine", choices=["pdf", "kit"], default="pdf",
                    help="pdf=先转 PDF 再出图（默认、不裁切）；kit=裁到数据区但右侧会被裁掉")
    rd.set_defaults(func=a_xlsx_render, action_name="xlsx.render")

    ch = sub.add_parser("chart", parents=[common], help="往工作簿里加原生图表（柱/横柱/线/饼/环/面积）")
    ch.add_argument("--file", required=True)
    ch.add_argument("--out")
    ch.add_argument("--from", dest="from_", help="图表规格 JSON（给了它就忽略下面的单参数）")
    ch.add_argument("--type", default="bar", help="bar / barh / line / pie / doughnut / area")
    ch.add_argument("--data", help="数据区域，如 汇总!B1:B4")
    ch.add_argument("--categories", help="分类区域，如 汇总!A2:A4（饼/环必填）")
    ch.add_argument("--title")
    ch.add_argument("--anchor", default="E2", help="图表左上角落哪个格子（默认 E2）")
    ch.add_argument("--x-title")
    ch.add_argument("--y-title")
    ch.add_argument("--grouping", choices=["standard", "stacked", "percentStacked"])
    ch.add_argument("--sheet", help="哪个工作表（默认第一个）")
    ch.set_defaults(func=a_xlsx_chart, action_name="xlsx.chart")

    # ── pdf ──
    g = groups.add_parser("pdf", help="PDF")
    sub = g.add_subparsers(dest="action")

    b = sub.add_parser("build", parents=[common], help="Markdown → PDF（中文硬保证）")
    b.add_argument("--from", dest="from_", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--title")
    b.add_argument("--author")
    b.add_argument("--page-size", default="A4", choices=["A4", "Letter"])
    b.add_argument("--font", help="中文字体文件（.ttf/.ttc），默认自动找 msyh.ttc")
    b.add_argument("--font-index", type=int, default=0, help=".ttc 里的子字体序号")
    b.add_argument("--qa-dir", help="顺便出图做肉眼检查（推荐）")
    b.add_argument("--dpi", type=int, default=120)
    b.add_argument("--table-style", choices=["three-line", "grid"], help="表格样式（三线表/网格）")
    b.add_argument("--no-highlight", action="store_true", help="不做代码高亮（默认按语言着色）")
    b.add_argument("--columns", type=int, default=1, help="分栏数（1-4，默认 1）")
    b.set_defaults(func=a_pdf_build, action_name="pdf.build")

    i = sub.add_parser("inspect", parents=[common], help="元信息 + 字体嵌入审计")
    i.add_argument("--file", required=True)
    i.set_defaults(func=a_pdf_inspect, action_name="pdf.inspect")

    t = sub.add_parser("text", parents=[common], help="抽文本")
    t.add_argument("--file", required=True)
    t.add_argument("--pages", help="1,2-3")
    t.add_argument("--out")
    t.set_defaults(func=a_pdf_text, action_name="pdf.text")

    tb = sub.add_parser("table", parents=[common], help="抽表格")
    tb.add_argument("--file", required=True)
    tb.add_argument("--pages")
    tb.add_argument("--out", help=".md 或 .json")
    tb.set_defaults(func=a_pdf_table, action_name="pdf.table")

    sp = sub.add_parser("split", parents=[common], help="按页拆开")
    sp.add_argument("--file", required=True)
    sp.add_argument("--out", required=True, help="输出目录")
    sp.add_argument("--chunk", type=int, help="每 N 页一个文件（默认每页一个）")
    sp.set_defaults(func=a_pdf_split, action_name="pdf.split")

    mg = sub.add_parser("merge", parents=[common], help="合并多个 PDF")
    mg.add_argument("--files", nargs="+", required=True)
    mg.add_argument("--out", required=True)
    mg.set_defaults(func=a_pdf_merge, action_name="pdf.merge")

    pg = sub.add_parser("pages", parents=[common], help="旋转/删页/取页")
    pg.add_argument("--file", required=True)
    pg.add_argument("--out", required=True)
    pg.add_argument("--rotate", type=int, choices=[90, 180, 270])
    pg.add_argument("--keep", help="只保留这些页：1-3,5")
    pg.add_argument("--drop", help="删掉这些页：1-3,5")
    pg.add_argument("--crop", help="裁切：x0,y0,x1,y1（单位 pt，左下角为原点）")
    pg.set_defaults(func=a_pdf_pages, action_name="pdf.pages")

    mt = sub.add_parser("meta", parents=[common], help="读/写元信息")
    mt.add_argument("--file", required=True)
    mt.add_argument("--set", action="append", help="title=… / author=… / subject=… / keywords=…")
    mt.add_argument("--out")
    mt.set_defaults(func=a_pdf_meta, action_name="pdf.meta")

    rd = sub.add_parser("render", parents=[common], help="PDF → PNG + contact sheet（大文件自动分批）")
    rd.add_argument("--file", required=True)
    rd.add_argument("--out", required=True)
    rd.add_argument("--dpi", type=int, default=120)
    rd.add_argument("--pages")
    rd.add_argument("--cols", type=int, default=3)
    rd.add_argument("--batch", type=int, default=200, help="超过这么多页就分批出图（默认 200）")
    rd.set_defaults(func=a_pdf_render, action_name="pdf.render")

    fd = sub.add_parser("from-docx", parents=[common], help="docx/xlsx/pptx → PDF（走 LibreOffice）")
    fd.add_argument("--file", required=True)
    fd.add_argument("--out", required=True)
    fd.set_defaults(func=a_pdf_from_docx, action_name="pdf.from-docx")

    fh = sub.add_parser("from-html", parents=[common], help="HTML → PDF（本地渲染链，不引浏览器）")
    fh.add_argument("--from", dest="from_", required=True, help="HTML 源文件")
    fh.add_argument("--out", required=True)
    fh.add_argument("--title")
    fh.add_argument("--author")
    fh.add_argument("--page-size", default="A4", choices=["A4", "Letter"])
    fh.add_argument("--font", help="中文字体文件（.ttf/.ttc）")
    fh.add_argument("--font-index", type=int, default=0)
    fh.add_argument("--qa-dir", help="顺便出图做肉眼检查（推荐）")
    fh.add_argument("--dpi", type=int, default=120)
    fh.add_argument("--engine", default="auto", choices=["auto", "local", "playwright"],
                    help="auto=先试 Chromium 打印，失败落本地链（默认）；local=只用本地链；"
                         "playwright=只走浏览器（CSS 分页/@page 保真最高）")
    fh.set_defaults(func=a_pdf_from_html, action_name="pdf.from-html")

    pim = sub.add_parser("image", parents=[common], help="把 PDF 里的图导出来（PNG + contact sheet）")
    pim.add_argument("--file", required=True)
    pim.add_argument("--out", required=True, help="输出目录")
    pim.add_argument("--pages", help="1,2-3（默认全部）")
    pim.add_argument("--batch", type=int, default=200, help="超过这么多页就分批（默认 200）")
    pim.set_defaults(func=a_pdf_image, action_name="pdf.image")

    fm = sub.add_parser("form", parents=[common], help="PDF 表单（AcroForm）：看字段 / 填值")
    fm.add_argument("--file", required=True)
    fm.add_argument("--info", action="store_true", help="只列字段（默认）")
    fm.add_argument("--set", action="append", help="填值：name=张三（可多次）")
    fm.add_argument("--out", help="填完的输出文件（--set 时必填）")
    fm.set_defaults(func=a_pdf_form, action_name="pdf.form")

    enc = sub.add_parser("encrypt", parents=[common], help="加密 PDF（AES-256）")
    enc.add_argument("--file", required=True)
    enc.add_argument("--out", required=True)
    enc.add_argument("--password", required=True, help="打开密码（user password）")
    enc.add_argument("--owner-password", help="权限密码（默认同打开密码）")
    enc.add_argument("--algorithm", default="aes256", choices=["aes256", "aes128"])
    enc.set_defaults(func=a_pdf_encrypt, action_name="pdf.encrypt")

    dec = sub.add_parser("decrypt", parents=[common], help="解密 PDF（给打开密码）")
    dec.add_argument("--file", required=True)
    dec.add_argument("--out", required=True)
    dec.add_argument("--password", required=True)
    dec.set_defaults(func=a_pdf_decrypt, action_name="pdf.decrypt")

    # ── chart ──
    g = groups.add_parser("chart", help="图表（自己画 PNG，不引 matplotlib）")
    sub = g.add_subparsers(dest="action")

    cb = sub.add_parser("build", parents=[common], help="按 JSON 规格画一张图（bar/barh/line/pie）")
    cb.add_argument("--from", dest="from_", required=True, help="图表规格 JSON")
    cb.add_argument("--out", required=True, help="输出 PNG")
    cb.add_argument("--qa-dir", help="contact sheet 放哪（默认与 PNG 同目录）")
    cb.set_defaults(func=a_chart_build, action_name="chart.build")

    ce = sub.add_parser("example", parents=[common], help="打印一份可用的图表规格样例")
    ce.add_argument("--out", help="顺手写成 JSON 文件")
    ce.set_defaults(func=a_chart_example, action_name="chart.example")

    return p


def main(argv: list[str]) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except C.OfficeError as err:
        payload = C.fail_dict("usage", err)
        print(json.dumps(payload, ensure_ascii=False, indent=2) if "--json" in argv
              else _usage_text(err))
        return C.EXIT_USAGE
    except SystemExit as exc:  # -h / --version
        return int(exc.code or 0)

    if not getattr(args, "group", None):
        print(_usage_text(None))
        return C.EXIT_USAGE
    if getattr(args, "group", None) and not getattr(args, "func", None):
        try:
            parser.parse_args([args.group, "-h"])
        except SystemExit:
            pass
        return C.EXIT_USAGE

    action = args.action_name
    as_json = getattr(args, "json", False)
    try:
        payload, code = _envelope(action, args.func(args, _ctx(args)))
    except C.OfficeError as err:
        payload, code = C.fail_dict(action, err), C.EXIT_FAIL
    except KeyboardInterrupt:
        payload, code = C.fail_dict(action, C.OfficeError("Interrupted", "被中断")), 130
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc()
        err = C.OfficeError(
            "InternalError",
            f"{type(exc).__name__}: {exc}",
            next_steps=["这是我们的 bug：把回执里的 traceback 尾巴和复现命令报给用户",
                        "同时给出 `python office.py doctor --json` 的输出"],
            detail={"traceback": tb.strip().splitlines()[-12:]},
        )
        payload, code = C.fail_dict(action, err), C.EXIT_FAIL

    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(_human(payload))
    return code


def _usage_text(err) -> str:
    head = "Irmia Office 套件  v" + VERSION + "\n"
    if err is not None:
        head += f"\n⚠ {err.message}\n"
    return head + """
用法：python office.py <组> <动作> [参数] [--json]

  doctor                      依赖自检（第一次先跑这个）
  docx build    --from a.md --out a.docx         Markdown → Word（认得 ![](图.png)）
  docx validate --file a.docx                    结构校验（含元素顺序/批注链/书签/插图深检查）
  docx view     --file a.docx                    文本预览
  docx prep     --file a.docx --out work/        拆包 + view.txt
  docx pack     --from work/unpacked --out b.docx  改完 XML 再打包
  docx diff     --before a.docx --after b.docx   比一比改了什么
  docx comment  --file a.docx --anchor 文字 --text 批注
  docx comment  --file a.docx --reply-to 3 --text 回复    回复某条批注
  docx resolve  --file a.docx --id 3 [--undo]    标记已解决 / 撤销
  docx comments --file a.docx                    读回批注（含已解决/回复关系）
  docx track    --file a.docx --text 新增 --after 锚点
  docx revisions / accept / reject               修订列表 / 全接受 / 全拒绝
  docx image    --file a.docx --image p.png --caption 图1   插图（同 caption 重跑=替换）
  docx render   --file a.docx --out qa/          渲染成 PNG + contact sheet
  xlsx build    --from a.json --out a.xlsx       按规格建表（可含 charts / conditional）
  xlsx chart    --file a.xlsx --type bar --data 汇总!B1:B4 --categories 汇总!A2:A4
  xlsx verify   --file a.xlsx                    静态体检（含图表 series / 条件格式条数）
  xlsx recalc   --file a.xlsx                    重算（LibreOffice 优先）
  xlsx read     --file a.xlsx                    读回值/公式
  xlsx render   --file a.xlsx --out qa/          工作表出图
  chart build   --from spec.json --out chart.png 画图（bar/barh/line/pie，Pillow）
  chart example  --out chart.json                一份可用的图表规格样例
  pdf  build    --from a.md --out a.pdf --qa-dir qa/   Markdown → PDF（中文，可插图）
  pdf  from-html --from a.html --out a.pdf       HTML → PDF（本地渲染链，不引浏览器）
  pdf  inspect  --file a.pdf                     字体嵌入审计
  pdf  text     --file a.pdf                     抽文本
  pdf  table    --file a.pdf                     抽表格
  pdf  image    --file a.pdf --out imgs/         抽内嵌图片（PNG + contact sheet）
  pdf  split    --file a.pdf --out dir/          拆页
  pdf  merge    --files a.pdf b.pdf --out c.pdf  合并
  pdf  pages    --file a.pdf --out b.pdf --rotate 90 --keep 1-2 --crop 0,0,595,421
  pdf  meta     --file a.pdf [--set title=…]
  pdf  render   --file a.pdf --out qa/           PDF → PNG + contact sheet
  pdf  from-docx --file a.docx --out a.pdf       Word → PDF（LibreOffice）

所有产物都写到**当前工作目录**下；覆盖已有文件会先备份成 *.bak-<时间戳>。
"""


def _doctor_human(payload: dict) -> str:
    d = payload.get("data") or {}
    s = payload.get("summary") or {}
    py = d.get("python") or {}
    fonts = d.get("fonts") or {}
    lo = d.get("libreoffice") or {}
    req = (d.get("modules") or {}).get("required") or {}
    opt = (d.get("modules") or {}).get("optional") or {}

    def _fmt(group):
        parts = []
        for name, info in group.items():
            if info.get("installed"):
                parts.append(f"{info.get('package', name)} {info.get('version')}")
            else:
                parts.append(f"{info.get('package', name)} ✗缺失")
        return " | ".join(parts)

    routes_off = [k for k, v in ((d.get("routes") or {})).items() if v is False]
    head = "true" if payload.get("ready") else "FALSE"
    if payload.get("ready") and routes_off:
        head += f"（核心依赖齐全，但有 {len(routes_off)} 项能力降级）"
    lines = [f"doctor  ready={head}"]
    lines.append(f"  python      {py.get('version')}  {py.get('executable')}")
    lines.append(f"  必需包      {_fmt(req)}")
    if opt:
        lines.append(f"  可选包      {_fmt(opt)}")
    reg = fonts.get("regular") or {}
    if reg:
        lines.append(f"  中文字体    {reg.get('path')}#{reg.get('index', 0)}  cmap {fonts.get('cmap_codepoints')} 码位")
    else:
        lines.append("  中文字体    ✗ 没找到（出中文 PDF 会直接失败，这是有意的）")
    lines.append(f"  LibreOffice {'route=' + str(lo.get('route')) if lo.get('ready') else '✗ 不可用：' + str(lo.get('error'))}")
    routes = d.get("routes") or {}
    if routes:
        on = [k for k, v in routes.items() if v is True]
        off = [k for k, v in routes.items() if v is False]
        lines.append(f"  能力       可用 {len(on)} 项" + (f"；不可用 {', '.join(off)}" if off else ""))
    if not payload.get("ready"):
        install = d.get("install") or {}
        lines.append("  下一步      按下面的命令装依赖：")
        for key in ("core", "pdf", "excel_recalc_fallback", "libreoffice"):
            if install.get(key):
                lines.append(f"               {install[key]}")
    for warn in payload.get("warnings") or []:
        lines.append(f"  ⚠ {warn}")
    for deg in payload.get("degraded") or []:
        lines.append(f"  ⤵ 降级 {deg.get('capability')}：{deg.get('reason')}")
    for step in payload.get("next") or []:
        lines.append(f"  → {step}")
    return "\n".join(lines)


def _human(payload: dict) -> str:
    if payload.get("action") == "doctor":
        return _doctor_human(payload)
    if not payload.get("ok"):
        err = payload.get("error", {})
        lines = [f"✗ {payload.get('action')} 失败：[{err.get('code')}] {err.get('message')}"]
        for step in err.get("next", []):
            lines.append(f"  → {step}")
        if err.get("detail"):
            lines.append("  细节：" + json.dumps(err["detail"], ensure_ascii=False)[:1200])
        return "\n".join(lines)
    lines = [f"✓ {payload.get('action')}"]
    for art in payload.get("artifacts", []):
        lines.append(f"  产物 {art.get('kind'):5s} {art.get('path')}")
    data = payload.get("data") or {}
    for key in ("status", "pages", "page_count", "table_count", "paragraph_count", "count",
                "mean_ink_ratio", "blank_pages", "missing_fonts", "missing_cache_count",
                "recalculated", "delivery_file_recalculated", "route", "out", "file",
                "image_count", "images", "charts", "conditional_rules", "chart_series_ok",
                "resolved", "resolved_count", "replies", "mode"):
        if key in data:
            lines.append(f"  {key}: {json.dumps(data[key], ensure_ascii=False)}")
    for warn in payload.get("warnings", []):
        lines.append(f"  ⚠ {warn}")
    for deg in payload.get("degraded", []):
        lines.append(f"  ⤵ 降级 {deg.get('capability')}：{deg.get('reason')}")
    for note in payload.get("notes", []):
        lines.append(f"  · {note}")
    for step in payload.get("next", []):
        lines.append(f"  → {step}")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
