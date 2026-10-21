"""字体：找中文字体 + **读字体的 cmap 判断"这个字到底有没有字形"**。

为什么自己解析 cmap：Kimi 那套的坑是「`md2pdf --font` 让中文变成 tofu 黑方块，
它自己的 inspect 判'无异常'」。像素指标（墨迹率、包围盒）认不出缺字形，
而 cmap 认得——一个码位不在字体映射里，画出来就一定是 .notdef（方块/空白）。
所以我们的出图动作在**画之前**先做覆盖预检，画完再给人眼看 PNG。

只处理 TTF / TTC（含 subfontIndex），不引入 fontTools。
"""

from __future__ import annotations

import os
import struct
from pathlib import Path

_CACHE: dict[tuple, dict] = {}

# 常见字体候选：(路径, ttc 子字体序号)
_WIN = [
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/msyhbd.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", 0),
    ("C:/Windows/Fonts/simsun.ttc", 0),
    ("C:/Windows/Fonts/Deng.ttf", 0),
    ("C:/Windows/Fonts/msyh.ttf", 0),
]
_LINUX = [
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 0),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
    ("/usr/share/fonts/truetype/arphic/uming.ttc", 0),
]
_MAC = [
    ("/System/Library/Fonts/PingFang.ttc", 0),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    ("/Library/Fonts/Arial Unicode.ttf", 0),
]


def _read_at(fh, offset: int, size: int) -> bytes:
    fh.seek(offset)
    return fh.read(size)


def _font_offset(fh) -> int:
    """TTC 取第一个子字体的偏移；普通 TTF 返回 0。"""
    head = _read_at(fh, 0, 12)
    if len(head) < 12:
        return 0
    if head[:4] == b"ttcf":
        num = struct.unpack(">I", head[8:12])[0]
        if num < 1:
            return 0
        return struct.unpack(">I", _read_at(fh, 12, 4))[0]
    return 0


def _tables(fh, offset: int) -> dict[str, tuple[int, int]]:
    head = _read_at(fh, offset, 12)
    if len(head) < 12:
        return {}
    num = struct.unpack(">H", head[4:6])[0]
    recs = _read_at(fh, offset + 12, num * 16)
    out = {}
    for i in range(num):
        rec = recs[i * 16 : (i + 1) * 16]
        if len(rec) < 16:
            break
        tag = rec[:4].decode("latin-1")
        t_off, t_len = struct.unpack(">II", rec[8:16])
        out[tag] = (t_off, t_len)
    return out


def _cmap_format4(buf: bytes) -> set[int]:
    seg = struct.unpack(">H", buf[6:8])[0] // 2
    if seg <= 0:
        return set()
    ends = struct.unpack(">" + "H" * seg, buf[14 : 14 + seg * 2])
    starts_off = 14 + seg * 2 + 2
    starts = struct.unpack(">" + "H" * seg, buf[starts_off : starts_off + seg * 2])
    deltas_off = starts_off + seg * 2
    deltas = struct.unpack(">" + "h" * seg, buf[deltas_off : deltas_off + seg * 2])
    range_off = deltas_off + seg * 2
    ranges = struct.unpack(">" + "H" * seg, buf[range_off : range_off + seg * 2])
    covered: set[int] = set()
    for i in range(seg):
        start, end = starts[i], ends[i]
        if start == 0xFFFF:
            continue
        for cp in range(start, min(end, 0xFFFF) + 1):
            if ranges[i] == 0:
                gid = (cp + deltas[i]) & 0xFFFF
                if gid:
                    covered.add(cp)
            else:
                addr = range_off + i * 2 + ranges[i] + (cp - start) * 2
                if addr + 2 > len(buf):
                    continue
                gid = struct.unpack(">H", buf[addr : addr + 2])[0]
                if gid:
                    covered.add(cp)
    return covered


def _cmap_format12(buf: bytes) -> set[int]:
    n = struct.unpack(">I", buf[12:16])[0]
    covered: set[int] = set()
    for i in range(n):
        base = 16 + i * 12
        if base + 12 > len(buf):
            break
        s, e, g = struct.unpack(">III", buf[base : base + 12])
        if e < s or e > 0x10FFFF or (e - s) > 0x20000:
            continue
        if g:
            covered.update(range(s, e + 1))
    return covered


def coverage(font_path: str | Path, index: int = 0) -> dict:
    """返回 {'path','ok','codepoints','count','error'}。带 mtime 缓存。"""
    p = Path(font_path)
    key = (str(p.resolve()), index)
    try:
        mtime = p.stat().st_mtime
    except OSError as exc:
        return {"path": str(p), "ok": False, "codepoints": set(), "count": 0, "error": f"字体不存在：{exc}"}
    cached = _CACHE.get(key)
    if cached and cached.get("mtime") == mtime:
        return cached

    result = {"path": str(p), "ok": False, "codepoints": set(), "count": 0, "error": None, "mtime": mtime}
    try:
        with open(p, "rb") as fh:
            offset = _font_offset(fh)
            if index > 0:
                fh.seek(12)
                offsets = struct.unpack(">I", fh.read(4 * (index + 1)))
                if index < len(offsets):
                    offset = offsets[index]
            tables = _tables(fh, offset)
            if "cmap" not in tables:
                result["error"] = "字体里没有 cmap 表"
                return result
            c_off, c_len = tables["cmap"]
            cbuf = _read_at(fh, c_off, c_len)
        num = struct.unpack(">H", cbuf[2:4])[0]
        best = None
        for i in range(num):
            pid, eid, sub_off = struct.unpack(">HHI", cbuf[4 + i * 8 : 12 + i * 8])
            fmt = struct.unpack(">H", cbuf[sub_off : sub_off + 2])[0] if sub_off + 2 <= len(cbuf) else -1
            score = 0
            if fmt == 12:
                score = 4
            elif fmt == 4:
                score = 3
            elif fmt == 0:
                score = 1
            if pid in (0, 3) and score > score_of(best):
                best = (score, fmt, sub_off)
        if not best:
            result["error"] = "没有可用的 cmap 子表（format 4/12）"
            return result
        _, fmt, sub_off = best
        sub = cbuf[sub_off:]
        covered = _cmap_format12(sub) if fmt == 12 else (_cmap_format4(sub) if fmt == 4 else set())
        result["codepoints"] = covered
        result["count"] = len(covered)
        result["ok"] = True
    except Exception as exc:  # noqa: BLE001 —— 任何解析失败都只影响"预检"，不许炸掉主流程
        result["error"] = f"{type(exc).__name__}: {exc}"
    _CACHE[key] = result
    return result


def score_of(best) -> int:
    return best[0] if best else -1


def missing_chars(font_path: str | Path, text: str, index: int = 0) -> list[str]:
    """返回 text 里**字体没有字形**的字符（去重、保序）。"""
    cov = coverage(font_path, index)
    if not cov["ok"]:
        return []
    cps = cov["codepoints"]
    seen, out = set(), []
    for ch in text:
        if ch in "\n\r\t " or ch in seen:
            continue
        seen.add(ch)
        cp = ord(ch)
        if cp < 0x20 or cp in (0x200B, 0xFEFF):
            continue
        if cp not in cps:
            out.append(ch)
    return out


def _probe(path: Path, index: int) -> bool:
    cov = coverage(path, index)
    if not cov["ok"] or cov["count"] < 500:
        return False
    # 必须真的能画出中文，否则不算"中文可用字体"
    return all(ord(ch) in cov["codepoints"] for ch in "中文标题测试")


def find_cjk_fonts() -> dict:
    """找出可用的中文字体。返回 {regular:{path,index}, bold:{...}, checked:[...]}。"""
    env_reg = os.environ.get("OFFICE_FONT_REGULAR") or os.environ.get("DSH_OFFICE_FONT_REGULAR")
    env_bold = os.environ.get("OFFICE_FONT_BOLD") or os.environ.get("DSH_OFFICE_FONT_BOLD")
    checked = []
    regular = bold = None

    if env_reg:
        p = Path(env_reg)
        checked.append({"path": str(p), "source": "env OFFICE_FONT_REGULAR", "usable": _probe(p, 0)})
        if _probe(p, 0):
            regular = {"path": str(p), "index": 0}
    if env_bold:
        p = Path(env_bold)
        checked.append({"path": str(p), "source": "env OFFICE_FONT_BOLD", "usable": _probe(p, 0)})
        if _probe(p, 0):
            bold = {"path": str(p), "index": 0}

    if regular is None:
        for cand, idx in _WIN + _LINUX + _MAC:
            p = Path(cand)
            if not p.exists():
                continue
            ok = _probe(p, idx)
            checked.append({"path": str(p), "source": "system scan", "usable": ok})
            if ok:
                regular = {"path": str(p), "index": idx}
                break

    if bold is None and regular is not None:
        # 同目录的粗体候选
        reg = Path(regular["path"])
        for name in ("msyhbd.ttc", "msyhbd.ttf", "simhei.ttf", "NotoSansCJK-Bold.ttc", "msyh.ttc"):
            c = reg.with_name(name)
            if c.exists() and _probe(c, 0):
                bold = {"path": str(c), "index": 0}
                break
        if bold is None:
            bold = dict(regular)  # 拿正则当粗用（不嵌入假粗体，只降级）

    return {"regular": regular, "bold": bold, "checked": checked}


def describe(font: dict | None) -> str:
    if not font:
        return "（未找到）"
    p = Path(font["path"])
    idx = font.get("index", 0)
    return f"{p.name}#{idx}" if idx else p.name
