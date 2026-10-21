"""pandoc 桥：md ↔ docx 的高保真转换（双向）。

为什么还要 pandoc：我们自己的 Markdown 解析是"够用那一档"，但 pandoc 在
**脚注/引用/嵌套列表/表格对齐/math/参考文献**这些边角上比我们全，而且它是业界基准。
分工：日常用 `docx build`（快、可控、中文排版我们说了算）；要"喂别人写的复杂 Markdown"
或"把 docx 变回 Markdown"时走 pandoc。

怎么找 pandoc（按顺序）：
  ① 环境变量 `OFFICE_PANDOC` 指向可执行文件
  ② PATH 上的 `pandoc`
  ③ Windows 常见安装位置（`C:\\Program Files\\Pandoc\\pandoc.exe` 等）
  ④ `pypandoc_binary` 包自带的那份（`pip install pypandoc_binary`，约 221 MB）
都没有 → 返回 available()=False，调用方降级到 `docx build` 并给安装命令。
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import _common as C

_CANDIDATES = [
    r"C:\Program Files\Pandoc\pandoc.exe",
    r"C:\Program Files (x86)\Pandoc\pandoc.exe",
    "/usr/bin/pandoc",
    "/usr/local/bin/pandoc",
    "/opt/homebrew/bin/pandoc",
]

_CACHE: dict | None = None


def _bundled() -> str | None:
    """pypandoc_binary 自带的那份；它会往 stderr 打噪声，所以这里把 stderr 收起来。"""
    try:
        import contextlib
        import io

        import pypandoc

        with contextlib.redirect_stderr(io.StringIO()):
            path = pypandoc.get_pandoc_path()
        if path and Path(path).exists():
            return str(path)
    except Exception:
        return None
    return None


def _probe(path: str) -> dict:
    res = C.run_cmd([path, "--version"], timeout=30)
    info = {"path": path, "exit": res["exit_code"], "version": None}
    if res["exit_code"] == 0:
        first = (res["stdout"] or "").splitlines()[0].strip()
        info["version"] = first.replace("pandoc", "").strip() or "unknown"
    return info


def discover(refresh: bool = False) -> dict:
    """找到 pandoc 就返回路径与版本；找不到给安装命令。

    顺序：环境变量 → PATH → 常见安装位置 → pypandoc 自带。
    **先找到就不再碰后面那些**（pypandoc 的探测会往 stderr 打 ERROR，会污染 --json）。
    """
    global _CACHE
    if _CACHE is not None and not refresh:
        return _CACHE
    info = {"available": False, "path": None, "version": None, "source": None,
            "install": "winget install --id JohnMacFarlane.Pandoc -e",
            "install_alt": f'"{sys.executable}" -m pip install pypandoc_binary',
            "checked": []}
    candidates: list[tuple[str, str]] = []
    env = os.environ.get("OFFICE_PANDOC")
    if env:
        candidates.append(("env OFFICE_PANDOC", env))
    which = shutil.which("pandoc")
    if which:
        candidates.append(("PATH", which))
    for cand in _CANDIDATES:
        if Path(cand).exists():
            candidates.append(("system", cand))
    for source, path in candidates:
        got = _probe(path)
        info["checked"].append({"source": source, **got})
        if got["exit"] == 0:
            info.update(available=True, path=path, source=source, version=got["version"])
            _CACHE = info
            return info
    bundled = _bundled()
    if bundled:
        got = _probe(bundled)
        info["checked"].append({"source": "pypandoc_binary", **got})
        if got["exit"] == 0:
            info.update(available=True, path=bundled, source="pypandoc_binary",
                        version=got["version"])
    _CACHE = info
    return info


def require(action: str) -> dict:
    info = discover()
    if not info["available"]:
        raise C.OfficeError(
            "DependencyMissing",
            f"{action} 需要 pandoc，本机没找到：{info['install']}",
            next_steps=[f"装系统版：{info['install']}",
                        f"或者用 pip 便携版：{info['install_alt']}（自带二进制，约 221 MB）",
                        "不装也能用：`docx build`（我们自己的 Markdown 解析）仍然可用"],
            detail={"checked": info["checked"]},
        )
    return info


def md_to_docx(src_md: Path, out_docx: Path, reference_doc: Path | None = None,
               toc: bool = False, number_sections: bool = False,
               standalone: bool = True) -> dict:
    """Markdown → docx（pandoc）。脚注/引用/复杂表格由 pandoc 处理。"""
    info = require("pandoc 转 docx")
    C.prepare_write(out_docx)
    argv = [info["path"], str(src_md), "-o", str(out_docx), "--from", "markdown+footnotes+pipe_tables"]
    if standalone:
        argv.append("--standalone")
    if toc:
        argv.append("--toc")
    if number_sections:
        argv.append("--number-sections")
    if reference_doc:
        argv += ["--reference-doc", str(reference_doc)]
    res = C.run_cmd(argv, timeout=180)
    if res["exit_code"] != 0 or not out_docx.exists():
        raise C.OfficeError(
            "PandocFailed",
            f"pandoc 转换失败（exit {res['exit_code']}）：{(res['stderr'] or '')[:300]}",
            next_steps=["确认源文件是 UTF-8；`--reference-doc` 要指向一个真实存在的 .docx",
                        "去掉额外参数（--toc/--number-sections）再试一次"],
            detail={"argv": res["argv"], "stderr": res["stderr"][:1200]},
        )
    return {"out": C.rel_path(out_docx), "bytes": out_docx.stat().st_size,
            "route": "pandoc", "pandoc": {"version": info["version"], "source": info["source"]},
            "argv": res["argv"], "stderr_tail": (res["stderr"] or "")[-400:]}


def docx_to_md(src_docx: Path, out_md: Path, extract_media: bool = False,
               wrap: str = "none") -> dict:
    """docx → Markdown（pandoc）。`--extract-media` 会把图导出到同名目录。"""
    info = require("pandoc 抽 Markdown")
    C.prepare_write(out_md)
    argv = [info["path"], str(src_docx), "-o", str(out_md), "--to", "gfm+footnotes",
            "--wrap", wrap]
    if extract_media:
        media = out_md.with_name(out_md.stem + "-media")
        argv += ["--extract-media", str(media)]
    res = C.run_cmd(argv, timeout=180)
    if res["exit_code"] != 0 or not out_md.exists():
        raise C.OfficeError(
            "PandocFailed",
            f"pandoc 抽 Markdown 失败（exit {res['exit_code']}）：{(res['stderr'] or '')[:300]}",
            next_steps=["确认输入是 .docx（.doc 要先转）", "加密/受保护的文档也会失败"],
            detail={"argv": res["argv"], "stderr": res["stderr"][:1200]},
        )
    text = out_md.read_text(encoding="utf-8", errors="replace")
    return {"out": C.rel_path(out_md), "bytes": out_md.stat().st_size,
            "chars": len(text), "lines": text.count("\n") + 1,
            "tables": text.count("\n|"), "footnotes": text.count("[^"),
            "route": "pandoc", "pandoc": {"version": info["version"], "source": info["source"]},
            "sample": text[:400]}
