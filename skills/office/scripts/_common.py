"""共享工具：路径守卫、备份、JSON 回执、子进程、错误码。

设计约定（SKILL.md 里有对应中文说明）：
- 一切产物写到**当前工作目录**下；技能目录是只读的，写进去直接报错。
- 覆盖任何已存在的文件之前先备份成 `<name>.bak-<时间戳>`，并在回执里列出。
- 每个动作返回同一种信封，成功 `ok:true`、失败 `ok:false` 且带 `next`（下一步怎么做）。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPTS_DIR.parent
REPO_SKILLS_DIR = SKILL_DIR.parent  # skills/

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_USAGE = 2


class OfficeError(Exception):
    """带错误码与下一步建议的业务异常。"""

    def __init__(self, code: str, message: str, next_steps=None, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.next_steps = list(next_steps or [])
        self.detail = detail

    def as_dict(self) -> dict:
        out = {"code": self.code, "message": self.message}
        if self.next_steps:
            out["next"] = self.next_steps
        if self.detail:
            out["detail"] = self.detail
        return out


# ── 输出信封 ────────────────────────────────────────────────────────────────


def fail_dict(action: str, err: OfficeError) -> dict:
    return {"ok": False, "action": action, "error": err.as_dict()}


def cwd() -> Path:
    return Path.cwd().resolve()


def exists_under(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def rel_path(path) -> str:
    p = Path(path).resolve()
    base = cwd()
    try:
        return p.relative_to(base).as_posix()
    except ValueError:
        return p.as_posix()


def resolve_input(path: str) -> Path:
    """读入的路径：允许任意位置（她给什么读什么），但必须存在。"""
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = cwd() / p
    p = p.resolve()
    if not p.exists():
        raise OfficeError(
            "InputNotFound",
            f"输入不存在：{p}",
            next_steps=["用 `Get-ChildItem` 确认文件名与大小写；路径要相对当前工作目录或绝对路径"],
        )
    return p


def resolve_output(path: str, allow_outside: bool = False) -> Path:
    """写出的路径：必须在当前工作目录内，且**不许**落在技能目录里。"""
    p = Path(path).expanduser()
    if not p.is_absolute():
        p = cwd() / p
    p = p.resolve()
    if exists_under(p, SKILL_DIR):
        raise OfficeError(
            "SkillDirReadOnly",
            f"技能目录是只读的，不能往里写：{rel_path(p)}",
            next_steps=["把 --out 改成当前工作目录下的相对路径，例如 `--out out/report.docx`"],
        )
    if not allow_outside and not exists_under(p, cwd()):
        raise OfficeError(
            "OutsideWorkspace",
            f"产物必须落在当前工作目录内：{p}",
            next_steps=["改成相对路径（如 `--out out/a.pdf`）；确实要写到外面就加 `--allow-outside-cwd`"],
        )
    return p


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def backup_if_exists(path: Path) -> Path | None:
    """覆盖已有文件之前先备份。返回备份路径（不存在则 None）。"""
    if not path.exists():
        return None
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bak = path.with_name(f"{path.name}.bak-{stamp}")
    n = 1
    while bak.exists():
        bak = path.with_name(f"{path.name}.bak-{stamp}-{n}")
        n += 1
    shutil.copy2(path, bak)
    return bak


def prepare_write(path: Path, backup: bool = True) -> Path | None:
    """准备写一个文件：建父目录；backup=True 时先备份已存在的同名文件。

    QA 产物（渲染出来的 PNG / contact sheet）是可再生的中间件，传 backup=False，
    免得每跑一次 QA 就在目录里留下一堆 `.bak-` 图片。
    """
    ensure_parent(path)
    return backup_if_exists(path) if backup else None


# ── 图片 ────────────────────────────────────────────────────────────────────

IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff", ".webp")


def resolve_image(src: str, base: Path | None = None) -> Path:
    """插图用的图片路径：先按当前工作目录找，再按"源文件所在目录"找。"""
    p = Path(str(src)).expanduser()
    if not p.is_absolute():
        cand = cwd() / p
        p = cand if cand.exists() else ((base or cwd()) / p)
    p = p.resolve()
    if not p.exists():
        raise OfficeError(
            "ImageNotFound",
            f"找不到图片：{src}（试过当前工作目录与源文件目录）",
            next_steps=["确认图片真的产出来了；`chart build` 会把 PNG 的绝对路径打出来",
                        "Markdown 里写相对当前工作目录的路径，例如 `![](out/chart.png)`"],
        )
    if p.suffix.lower() not in IMAGE_SUFFIXES:
        raise OfficeError("BadImage", f"这个后缀不像是图片：{p.suffix}",
                          next_steps=["用 PNG / JPEG；其它格式先转一下"])
    return p


def image_px(path: Path) -> tuple[int, int]:
    """读图片像素尺寸（读不出来就返回 (0,0)，调用方自己兜底）。"""
    try:
        from PIL import Image

        with Image.open(path) as im:
            return im.width, im.height
    except Exception:
        return (0, 0)


# ── 子进程 ──────────────────────────────────────────────────────────────────


def utf8_env(extra: dict | None = None) -> dict:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if extra:
        env.update({k: str(v) for k, v in extra.items()})
    return env


def run_cmd(argv, timeout: int = 180, cwd_dir=None, env_extra=None) -> dict:
    """跑外部命令，永远返回结构（不抛），带 stdout/stderr/exit_code。"""
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            cwd=str(cwd_dir) if cwd_dir else None,
            env=utf8_env(env_extra),
            shell=False,
        )
        return {
            "argv": [str(a) for a in argv],
            "exit_code": proc.returncode,
            "stdout": (proc.stdout or "").strip(),
            "stderr": (proc.stderr or "").strip(),
        }
    except FileNotFoundError as exc:
        return {"argv": [str(a) for a in argv], "exit_code": 127, "stdout": "", "stderr": f"命令不存在：{exc}"}
    except subprocess.TimeoutExpired:
        return {"argv": [str(a) for a in argv], "exit_code": 124, "stdout": "", "stderr": f"超时（>{timeout}s）"}


# ── ZIP / XML ───────────────────────────────────────────────────────────────


def write_text(path: Path, text: str) -> Path:
    prepare_write(path)
    path.write_text(text, encoding="utf-8", newline="\n")
    return path
