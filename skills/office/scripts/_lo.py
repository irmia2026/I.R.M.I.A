"""LibreOffice 适配层：优先随 DSH 打包的 `libreoffice-kit` CLI，其次系统 `soffice`。

本机事实（2026-10 实测）：PATH 上**没有** `soffice`，全盘也没有 soffice.exe；
DSH 自带的是 `libreoffice-kit`（Node CLI，进程内跑 LibreOfficeKit），能
`convert`（docx→pdf / xlsx→pdf / xlsx→csv）、`render`（→PNG，pdf 走 pdfium）、
`recalculate`（**保公式、写缓存值**）。

所以这里的路由是：
  ① 环境变量 `OFFICE_LO_NODE` + `OFFICE_LO_CLI` 明确指定
  ② 自动找 libreoffice-kit 的 cli.js + 一个 node
  ③ 系统 `soffice` / `libreoffice`（走 headless --convert-to）
  ④ 都没有 → 抛 DependencyMissing，回执里给下一步
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import _common as C

_CACHE: dict | None = None

_NODE_CANDIDATES = [
    "node",
    r"%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe",
    r"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe",
    r"%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe",
    r"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\node.exe",
]

# DSH 的安装目录可能在任意盘符、任意用户名目录下（本机就在 `D:\Users\AppData\Local\Programs\...`，
# 而 LOCALAPPDATA 在 `C:\Users\<用户名>\AppData\Local`）——所以用"盘符 × 几个常见安装根"直接展开定位，
# 不做全盘递归扫。
_APP_ROOT_PATTERNS = [
    "Users/AppData/Local/Programs/DeepSeek Harness*",
    "Users/*/AppData/Local/Programs/DeepSeek Harness*",
    "Users/*/Programs/DeepSeek Harness*",
    "Program Files/DeepSeek Harness*",
    "Program Files (x86)/DeepSeek Harness*",
    "Programs/DeepSeek Harness*",
    "DeepSeek Harness*",
]
_KIT_REL = Path("app.asar.unpacked") / "dsh" / "node_modules" / "@deepseek-ai" / "libreoffice-kit" / "lib" / "cli.js"


def _expand(p: str) -> str:
    out = os.path.expandvars(os.path.expanduser(p))
    for key in ("%LOCALAPPDATA%", "%PROGRAMFILES%", "%PROGRAMFILES(X86)%", "%USERPROFILE%", "%DSH_HOME%"):
        if key in out:
            out = out.replace(key, os.environ.get(key.strip("%"), ""))
    return out


def _first_existing(paths) -> str | None:
    for raw in paths:
        p = Path(_expand(raw))
        if p.exists():
            return str(p)
    return None


def _derive_node_from_cli(cli: str) -> str | None:
    """从 cli.js 的位置反推同一套安装里的 node（<resources>\\runtime\\primary-runtime\\...）。"""
    try:
        resources = Path(cli).parents[6]  # ...\resources
    except IndexError:
        return None
    for rel in (
        Path("runtime") / "primary-runtime" / "dependencies" / "node" / "bin" / "node.exe",
        Path("runtime") / "primary-runtime" / "dependencies" / "node" / "node.exe",
    ):
        cand = resources / rel
        if cand.exists():
            return str(cand)
    return None


def _find_node() -> str | None:
    env_node = os.environ.get("OFFICE_LO_NODE")
    if env_node and Path(env_node).exists():
        return env_node
    dsh_home = os.environ.get("DSH_HOME")
    if dsh_home:
        for cand in Path(dsh_home).glob("dsh-runtimes/*/dependencies/node/bin/node.exe"):
            return str(cand)
    for raw in _NODE_CANDIDATES:
        if raw == "node":
            found = shutil.which("node")
            if found:
                return found
            continue
        p = Path(_expand(raw))
        if p.exists():
            return str(p)
    return None


def _drives() -> list[str]:
    if os.name != "nt":
        return []
    return [letter for letter in "CDEFGHIJ" if Path(f"{letter}:/").exists()]


def _app_dirs():
    """产出可能装着 DSH 的目录（去重、只留真实存在的）。"""
    seen = set()

    def add(p: Path):
        try:
            key = str(p.resolve()).lower()
        except OSError:
            key = str(p).lower()
        if key in seen or not p.exists():
            return None
        seen.add(key)
        return p

    for raw in (
        r"%LOCALAPPDATA%\Programs\DeepSeek Harness",
        r"%LOCALAPPDATA%\Programs\DeepSeek Harness Beta",
        r"%PROGRAMFILES%\DeepSeek Harness",
        r"%PROGRAMFILES(X86)%\DeepSeek Harness",
    ):
        got = add(Path(_expand(raw)))
        if got:
            yield got
    for drive in _drives():
        root = Path(f"{drive}:/")
        for pattern in _APP_ROOT_PATTERNS:
            try:
                hits = list(root.glob(pattern))
            except (OSError, ValueError):
                continue
            for hit in hits:
                got = add(hit)
                if got:
                    yield got


def _candidate_kit_paths():
    """按"最可能先命中"的顺序产出 cli.js 候选路径。"""
    seen = set()

    def fresh(p: Path) -> bool:
        s = str(p)
        if s in seen:
            return False
        seen.add(s)
        return True

    for app in _app_dirs():
        for cand in (app / "resources" / _KIT_REL, app / _KIT_REL):
            if cand.exists() and fresh(cand):
                yield str(cand)
    here = C.cwd()
    for _ in range(3):
        for cand in (here / "node_modules").glob("@deepseek-ai/libreoffice-kit*/lib/cli.js"):
            if fresh(cand):
                yield str(cand)
        here = here.parent


def _find_kit_cli() -> str | None:
    for cand in _candidate_kit_paths():
        if Path(cand).exists():
            return str(cand)
    return None




def _find_soffice() -> str | None:
    for name in ("soffice", "libreoffice", "soffice.com"):
        found = shutil.which(name)
        if found:
            return found
    for raw in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ):
        p = Path(_expand(raw))
        if p.exists():
            return str(p)
    return None


def discover(refresh: bool = False) -> dict:
    """探测一次，结论缓存。返回 {ready, route, node, cli, soffice, error, capabilities}。"""
    global _CACHE
    if _CACHE is not None and not refresh:
        return _CACHE

    info = {
        "ready": False,
        "route": None,
        "node": None,
        "cli": None,
        "soffice": None,
        "error": None,
        "capabilities": None,
        "checked": [],
    }
    if os.environ.get("OFFICE_LO_DISABLE") in ("1", "true", "yes"):
        info["error"] = "OFFICE_LO_DISABLE 已设置（强制关闭 LibreOffice 路由，用于演练降级分支）"
        _CACHE = info
        return info

    env_cli = os.environ.get("OFFICE_LO_CLI")
    if env_cli and Path(env_cli).exists():
        node = os.environ.get("OFFICE_LO_NODE") or _find_node()
        if node:
            info.update(ready=True, route="kit-env", node=node, cli=env_cli)
    if not info["ready"]:
        cli = _find_kit_cli()
        node = (_find_node() or _derive_node_from_cli(cli)) if cli else None
        info["checked"].append({"libreoffice-kit cli.js": cli, "node": node})
        if cli and node:
            info.update(ready=True, route="kit", node=node, cli=cli)
    if not info["ready"]:
        soffice = _find_soffice()
        info["checked"].append({"soffice": soffice})
        if soffice:
            info.update(ready=True, route="soffice", soffice=soffice)

    if info["ready"] and info["route"] in ("kit", "kit-env"):
        caps = C.run_cmd([info["node"], info["cli"], "capabilities", "--json"], timeout=60)
        if caps["exit_code"] == 0 and caps["stdout"]:
            try:
                info["capabilities"] = json.loads(caps["stdout"])
            except json.JSONDecodeError:
                info["error"] = "capabilities 输出不是 JSON"
        else:
            info["ready"] = False
            info["error"] = (caps["stderr"] or caps["stdout"] or "capabilities 调用失败")[:400]
    elif info["ready"] is False:
        info["error"] = "没找到 LibreOffice：既没有 libreoffice-kit 的 cli.js，也没有 soffice"

    _CACHE = info
    return info


def require(action: str) -> dict:
    info = discover()
    if not info["ready"]:
        raise C.OfficeError(
            "DependencyMissing",
            f"{action} 需要 LibreOffice，本机没找到可用的：{info.get('error')}",
            next_steps=[
                "装了 LibreOffice 的话把 `soffice` 放进 PATH（`winget install TheDocumentFoundation.LibreOffice`）",
                "或者显式指定随 DSH 打包的那份：`$env:OFFICE_LO_NODE=<node.exe>; $env:OFFICE_LO_CLI=<...\\libreoffice-kit\\lib\\cli.js>`",
                "不想装就把这一步降级掉：docx/xlsx 的内容改动仍然生效，只是没有 PNG 可看",
            ],
            detail={"route": info["route"], "checked": info["checked"]},
        )
    return info


# ── 三条主线 ────────────────────────────────────────────────────────────────


def _run(info: dict, args: list[str], timeout: int) -> dict:
    if info["route"] in ("kit", "kit-env"):
        argv = [info["node"], info["cli"], *args]
    else:
        raise C.OfficeError("UnsupportedRoute", "soffice 路由只支持 convert")
    res = C.run_cmd(argv, timeout=timeout)
    payload = None
    if res["stdout"].strip().startswith("{"):
        try:
            payload = json.loads(res["stdout"])
        except json.JSONDecodeError:
            payload = None
    if res["exit_code"] != 0:
        msg = ""
        if payload:
            msg = payload.get("error") or payload.get("message") or ""
        raise C.OfficeError(
            "LibreOfficeFailed",
            f"LibreOffice 调用失败（exit {res['exit_code']}）：{msg or res['stderr'][:400]}",
            next_steps=[
                "确认输入文件没被占用、没加密；docx 先跑 `office.py docx validate` 看包结构",
                "重试一次仍然是同样的错误，就把 stderr 全文留下来报给用户",
            ],
            detail={"argv": res["argv"], "stderr": res["stderr"][:1200], "stdout": res["stdout"][:800]},
        )
    return {"payload": payload or {}, "stderr": res["stderr"], "stdout": res["stdout"]}


def _kit_export_path(dst: Path) -> Path:
    """libreoffice-kit 的 convert/recalculate 用"独占创建"写输出：目标已存在会 EEXIST。

    所以统一先写到同目录的临时名字，成功后再搬过去（调用方已经做过备份）。
    """
    import os
    import tempfile

    fd, name = tempfile.mkstemp(prefix=".office-export-", suffix=dst.suffix, dir=str(dst.parent))
    os.close(fd)
    os.unlink(name)  # 让 kit 自己创建；它要的就是"不存在"
    return Path(name)


def convert(src: Path, dst: Path, timeout: int = 240) -> dict:
    """任意 Office 文件 → pdf / txt / csv / xlsx。dst 的父目录会自动建。"""
    info = require("Office→PDF 转换")
    C.prepare_write(dst)
    if info["route"] == "soffice":
        target = {"pdf": "pdf", "txt": "txt:Text", "csv": "csv:Text - txt - csv (StarCalc)"}.get(dst.suffix.lstrip("."), "pdf")
        res = C.run_cmd(
            [info["soffice"], "--headless", "--norestore", f"--convert-to", target, "--outdir", str(dst.parent), str(src)],
            timeout=timeout,
        )
        if res["exit_code"] != 0 or not dst.exists():
            raise C.OfficeError("LibreOfficeFailed", f"soffice 转换失败：{res['stderr'][:300]}",
                                detail={"argv": res["argv"]})
        return {"outputPath": str(dst), "route": "soffice", "missingFonts": []}
    bak = C.prepare_write(dst)
    tmp = _kit_export_path(dst)
    try:
        out = _run(info, ["convert", "--input", str(src), "--output", str(tmp)], timeout)
        if not tmp.exists():
            raise C.OfficeError("LibreOfficeFailed", "LibreOffice 说成功了，但没产出文件",
                                detail={"payload": out["payload"]})
        import shutil

        shutil.move(str(tmp), str(dst))
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    payload = out["payload"] or {}
    return {"route": "kit", "backup": C.rel_path(bak) if bak else None, **payload, "outputPath": str(dst)}


def render(src: Path, outdir: Path, dpi: int = 144, pages: str | None = None,
           sheet: str | None = None, cell_range: str | None = None, timeout: int = 300) -> dict:
    """Office/PDF → 逐页 PNG + manifest。outdir 必须是**不存在或空的**目录。"""
    info = require("渲染成图")
    if info["route"] == "soffice":
        raise C.OfficeError(
            "UnsupportedRoute",
            "系统 soffice 路由不支持直接出图（会先转 PDF 再用 pypdfium2）",
            next_steps=["装了 pypdfium2 时会自动走 convert→PDF→PNG 的两段式，这里请用 `office.py pdf render`"],
        )
    if outdir.exists():
        if any(outdir.iterdir()):
            raise C.OfficeError(
                "OutputDirNotEmpty",
                f"渲染输出目录必须全新（LibreOffice Kit 自己会建这个目录）：{C.rel_path(outdir)}",
                next_steps=["换一个目录名，例如 `--out qa-v2`", "或者先把旧目录改名/删掉"],
            )
        # 空目录也不行——CLI 用 mkdir 建它，已存在会 EEXIST
        outdir.rmdir()
    else:
        # 只建父目录：目标目录本身留给 CLI 创建
        outdir.parent.mkdir(parents=True, exist_ok=True)
    args = ["render", "--input", str(src), "--output-dir", str(outdir), "--dpi", str(dpi)]
    if pages:
        args += ["--pages", str(pages)]
    if sheet:
        args += ["--sheet", str(sheet)]
    if cell_range:
        args += ["--range", str(cell_range)]
    out = _run(info, args, timeout)
    payload = out["payload"] or {}
    images = []
    for item in payload.get("images", []):
        p = Path(item.get("path", ""))
        images.append({**item, "path": str(p), "exists": p.exists(), "size": p.stat().st_size if p.exists() else 0})
    return {"route": "kit", "manifest": payload, "images": images,
            "missingFonts": payload.get("missingFonts", []), "pageCount": payload.get("pageCount")}


def recalculate(src: Path, dst: Path, timeout: int = 240) -> dict:
    """表格重算：**保留公式**同时把缓存值写回（这是 LibreOffice 相对 formulas 的关键优势）。"""
    info = require("表格重算")
    if info["route"] == "soffice":
        raise C.OfficeError("UnsupportedRoute", "soffice 路由暂不做重算（会改文件格式语义）")
    bak = C.prepare_write(dst)
    tmp = _kit_export_path(dst)
    try:
        out = _run(info, ["recalculate", "--input", str(src), "--output", str(tmp)], timeout)
        if not tmp.exists():
            raise C.OfficeError("LibreOfficeFailed", "LibreOffice 说重算成功了，但没产出文件",
                                detail={"payload": out["payload"]})
        import shutil

        shutil.move(str(tmp), str(dst))
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
    return {"route": "kit", "backup": C.rel_path(bak) if bak else None,
            **(out["payload"] or {}), "outputPath": str(dst)}


def status() -> dict:
    """给 doctor 用的一行摘要。"""
    info = discover()
    return {
        "ready": info["ready"],
        "route": info["route"],
        "node": info["node"],
        "cli": info["cli"],
        "soffice": info["soffice"],
        "error": info["error"],
        "capabilities": bool(info.get("capabilities")),
    }
