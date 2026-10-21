"""代码高亮：Pygments → ①ReportLab 的 `<font color>` 标记 ②docx 的彩色 run。

为什么要它：代码块只给等宽字体+浅底，读代码的人还是要靠颜色分关键字/字符串/注释。
Pygments 是纯 Python（8 MB）、离线、按语言名选 lexer；没装时**降级成不着色**并在回执里说清楚。

刻意不做的事：不引 VS Code/Pygments 主题那一套 CSS，只留一套克制的配色（深底浅字或浅底深字）。
"""

from __future__ import annotations

# 一套浅底深字的配色（和我们的文档底色一致）
_COLORS = {
    "Keyword": "#0B5CAD",
    "Name.Builtin": "#0B5CAD",
    "Name.Function": "#7A3E9D",
    "Name.Class": "#7A3E9D",
    "Name.Decorator": "#7A3E9D",
    "String": "#1F7A4D",
    "String.Doc": "#1F7A4D",
    "Number": "#B4560B",
    "Comment": "#7A828C",
    "Operator": "#5A626C",
    "Name.Tag": "#0B5CAD",
    "Name.Attribute": "#7A3E9D",
}

_ALIASES = {
    "py": "python", "python3": "python", "js": "javascript", "ts": "typescript",
    "sh": "bash", "shell": "bash", "pwsh": "powershell", "ps1": "powershell",
    "yml": "yaml", "md": "markdown", "jsonc": "json", "c++": "cpp", "c#": "csharp",
    "objc": "objective-c", "golang": "go", "rs": "rust", "kt": "kotlin",
}


def available() -> dict:
    try:
        import pygments  # noqa: F401

        from importlib.metadata import version

        return {"installed": True, "version": version("pygments")}
    except Exception as exc:  # noqa: BLE001
        return {"installed": False, "error": f"{type(exc).__name__}: {exc}"}


def _lexer(lang: str):
    from pygments.lexers import get_lexer_by_name
    from pygments.util import ClassNotFound

    name = _ALIASES.get((lang or "").lower(), (lang or "").lower())
    if not name:
        return None
    try:
        return get_lexer_by_name(name, stripnl=False)
    except ClassNotFound:
        return None


def _tokens(code: str, lang: str):
    from pygments import lex
    from pygments.token import Token

    lexer = _lexer(lang)
    if lexer is None:
        return [(Token.Text, line) for line in code.splitlines(keepends=True)]
    return list(lex(code, lexer))


def _color_of(ttype) -> str | None:
    """Pygments 的类型是 `Token.Keyword` / `Token.Literal.String.Double` 这种点号路径，
    所以按"路径里含不含这个名字"来匹配（先长后短，`String.Doc` 优先于 `String`）。"""
    s = str(ttype)
    for key, color in _COLORS.items():
        if key in s:
            return color
    return None


def reportlab_markup(code: str, lang: str) -> tuple[str, dict]:
    """代码 → ReportLab 的 XPreformatted 标记（`<font color>` + 转义）。

    返回 (markup, info)。没装 pygments 或语言不认识时 info 里 `highlighted=False`。
    """
    from xml.sax.saxutils import escape

    if not available()["installed"]:
        return escape(code), {"highlighted": False, "reason": "pygments 未安装"}
    lexer = _lexer(lang)
    if lexer is None:
        return escape(code), {"highlighted": False,
                             "reason": f"没有 {lang!r} 的 lexer（按纯文本排）"}
    parts: list[str] = []
    open_color = None
    count = 0
    for ttype, value in _tokens(code, lang):
        if not value:
            continue
        color = _color_of(ttype)
        if color != open_color:
            if open_color:
                parts.append("</font>")
                open_color = None
            if color:
                parts.append(f'<font color="{color}">')
                open_color = color
                count += 1
        parts.append(escape(value))
    if open_color:
        parts.append("</font>")
    return "".join(parts), {"highlighted": True, "lexer": lexer.name, "spans": count}


def docx_runs(par, code: str, lang: str, mono_font: str, size_pt: float = 9) -> dict:
    """代码 → docx 彩色 run（每个 token 一个 run，颜色写进 `w:color`）。"""
    from docx.shared import Pt, RGBColor

    if not available()["installed"]:
        run = par.add_run(code)
        run.font.name = mono_font
        run.font.size = Pt(size_pt)
        return {"highlighted": False, "reason": "pygments 未安装"}
    lexer = _lexer(lang)
    if lexer is None:
        run = par.add_run(code)
        run.font.name = mono_font
        run.font.size = Pt(size_pt)
        return {"highlighted": False, "reason": f"没有 {lang!r} 的 lexer"}
    spans = 0
    for ttype, value in _tokens(code, lang):
        if not value:
            continue
        run = par.add_run(value)
        run.font.name = mono_font
        run.font.size = Pt(size_pt)
        color = _color_of(ttype)
        if color:
            run.font.color.rgb = RGBColor.from_string(color.lstrip("#").upper())
            spans += 1
    return {"highlighted": True, "lexer": lexer.name, "spans": spans}


def plain(code: str, lang: str) -> str:
    return code
