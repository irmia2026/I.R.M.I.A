"""LaTeX → PNG（matplotlib 的 mathtext），给 PDF 那条路用。

docx 里公式是**原生 OMML**（Word 可编辑）；PDF 里没有 OMML，所以用 mathtext 渲染成图。
mathtext 自带数学字形（希腊字母/分号/根式/上下标/求和积分/矩阵都不缺），
因此这是"PDF 里公式不变方块"的关键一步。

不支持：`\\begin{matrix}` 之类环境、`\\text{中文}`（mathtext 没有汉字字形）——
后者会带上 `cjk` 标记让调用方警告，并且**仍然出图**（汉字位置会空/缺），不静默当没事。
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path

_CACHE_DIR = Path(tempfile.gettempdir()) / "office-mathtex"
_CJK = re.compile(r"[\u2e80-\u9fff\uff00-\uffef]")


def available() -> dict:
    try:
        import matplotlib  # noqa: F401
        from importlib.metadata import version

        return {"installed": True, "version": version("matplotlib")}
    except Exception as exc:  # noqa: BLE001
        return {"installed": False, "error": f"{type(exc).__name__}: {exc}"}


def has_cjk(latex: str) -> bool:
    return bool(_CJK.search(latex or ""))


_ALIASES = {
    r"\le": r"\leq", r"\ge": r"\geq", r"\ne": r"\neq", r"\neq": r"\neq",
    r"\to": r"\rightarrow", r"\rightarrow": r"\rightarrow",
    r"\leftarrow": r"\leftarrow", r"\Rightarrow": r"\Rightarrow",
    r"\ldots": r"\ldots", r"\cdots": r"\cdots", r"\infty": r"\infty",
    r"\varnothing": r"\emptyset", r"\degree": r"^{\circ}",
    r"\bar": r"\bar", r"\hat": r"\hat",
    r"\parallel": r"\parallel", r"\perp": r"\perp",
    r"\therefore": r"\therefore", r"\because": r"\because",
    r"\lbrace": r"\{", r"\rbrace": r"\}",
}


def _normalize(latex: str) -> str:
    """mathtext 的记号名比 LaTeX 少几个别称（`\\le` 它不认，只认 `\\leq`）。"""
    text = latex or ""
    for src, dst in sorted(_ALIASES.items(), key=lambda kv: -len(kv[0])):
        text = text.replace(src, dst)
    return text


def _sanitize(latex: str) -> str:
    """把我们 LaTeX 里的书签/注释性质的东西去掉；保留 mathtext 认识的写法。"""
    text = _normalize((latex or "").strip())
    text = re.sub(r"\\label\{[^}]*\}", "", text)
    text = re.sub(r"\\tag\{[^}]*\}", "", text)
    return text.strip()


def render(latex: str, dpi: int = 200, fontsize: int = 18) -> tuple[Path | None, dict]:
    """LaTeX → PNG。返回 (路径, 信息)；渲染不了时路径为 None 并给原因。"""
    info = {"latex": latex, "cjk": has_cjk(latex), "dpi": dpi, "fontsize": fontsize,
            "engine": "matplotlib.mathtext"}
    if not available()["installed"]:
        info["error"] = "matplotlib 未安装（pip install matplotlib）"
        return None, info
    tex = _sanitize(latex)
    if not tex:
        info["error"] = "公式是空的"
        return None, info
    key = hashlib.sha1(f"{tex}|{dpi}|{fontsize}".encode("utf-8")).hexdigest()[:16]
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    out = _CACHE_DIR / f"eq-{key}.png"
    if out.exists() and out.stat().st_size > 0:
        info["cached"] = True
        info["path"] = str(out)
        return out, info
    try:
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib.font_manager import FontProperties
        from matplotlib.mathtext import math_to_image

        display = f"${tex}$"
        math_to_image(display, str(out), prop=FontProperties(size=fontsize), dpi=dpi,
                      format="png")
    except Exception as exc:  # noqa: BLE001
        info["error"] = f"{type(exc).__name__}: {exc}"
        return None, info
    if not out.exists() or out.stat().st_size == 0:
        info["error"] = "mathtext 没产出文件"
        return None, info
    info["cached"] = False
    info["path"] = str(out)
    info["bytes"] = out.stat().st_size
    return out, info


def cleanup_cache(max_files: int = 400) -> dict:
    """缓存目录兜底清理（公式图很小，但别无限长）。"""
    if not _CACHE_DIR.exists():
        return {"dir": str(_CACHE_DIR), "files": 0, "removed": 0}
    files = sorted(_CACHE_DIR.glob("eq-*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    removed = 0
    for old in files[max_files:]:
        try:
            os.unlink(old)
            removed += 1
        except OSError:
            pass
    return {"dir": str(_CACHE_DIR), "files": len(files), "removed": removed}
