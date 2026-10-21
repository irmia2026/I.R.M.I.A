"""LaTeX 子集 → OMML（Word 原生公式）。

为什么自己做：`m:oMath` 是 Word 自己的公式格式，LibreOffice/WPS 都能正确导入并**按公式排版**
（不是贴图，可选中、可再编辑）。没有哪个 pip 包做"LaTeX→OMML"这一步（MathML→OMML 的包要 XSLT），
所以这里写一个够用的子集解析器。

支持（覆盖日常公式的绝大多数）：
  · 上下标 `x^2` `a_i` `x_i^2`
  · 分式 `\\frac{a}{b}`、根式 `\\sqrt{x}` `\\sqrt[3]{x}`
  · 求和/积分/连乘 `\\sum_{i=1}^{n}` `\\int_0^1` `\\prod`
  · 括号 `\\left( … \\right)`（按普通括号输出，不做自动伸缩）
  · 希腊字母与常用符号（`\\alpha` `\\pi` `\\le` `\\times` `\\infty` …）
  · `\\text{中文}` 原样文字、`\\mathrm{}`/`\\mathbf{}` 粗正体
不支持（会**明确报错**而不是画错）：矩阵/对齐环境（`align`、`matrix`、`cases`）、
`\\overbrace` 之类装饰、自定义宏。矩阵按 Kimi 那份也是"手写 OMML"，所以我们也不假装支持。
"""

from __future__ import annotations

import re

from _ooxml import M, W

MATH_FONT = "Cambria Math"
CJK_MATH_FONT = "微软雅黑"   # 公式里出现中文时给 Word 的 eastAsia 字体提示

GREEK = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε",
    "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ",
    "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "varpi": "ϖ", "rho": "ρ",
    "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "φ",
    "chi": "χ", "psi": "ψ", "omega": "ω",
    "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π",
    "Sigma": "Σ", "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
}
SYMBOLS = {
    "cdot": "·", "times": "×", "div": "÷", "pm": "±", "mp": "∓", "le": "≤", "leq": "≤",
    "ge": "≥", "geq": "≥", "ne": "≠", "neq": "≠", "approx": "≈", "equiv": "≡", "propto": "∝",
    "infty": "∞", "partial": "∂", "nabla": "∇", "forall": "∀", "exists": "∃", "in": "∈",
    "notin": "∉", "subset": "⊂", "supset": "⊃", "cup": "∪", "cap": "∩", "to": "→",
    "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒", "Leftarrow": "⇐",
    "leftrightarrow": "↔", "ldots": "…", "cdots": "⋯", "prime": "′", "degree": "°",
    "angle": "∠", "perp": "⊥", "parallel": "∥", "sim": "∼", "bar": "¯", "hat": "^",
    "emptyset": "∅", "varnothing": "∅", "therefore": "∴", "because": "∵",
}
NARY = {"sum": "∑", "prod": "∏", "int": "∫", "iint": "∬", "oint": "∮"}
FUNCS = {"sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "exp",
         "log", "ln", "lg", "max", "min", "sup", "inf", "lim", "det", "gcd", "mod", "arg"}
_IGNORED = {"displaystyle", "textstyle", "limits", "nolimits", "quad", "qquad", ",", ";",
            "!", " ", "left", "right", "big", "Big", "bigg", "Bigg"}
_UNSUPPORTED_ENVS = ("matrix", "pmatrix", "bmatrix", "vmatrix", "cases", "align", "aligned",
                     "array", "eqnarray", "gather", "split")


class LatexError(ValueError):
    pass


# ── 词法 ────────────────────────────────────────────────────────────────────

def tokenize(src: str) -> list[str]:
    tokens: list[str] = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch.isspace():
            i += 1
            continue
        if ch == "\\":
            j = i + 1
            if j < n and src[j].isalpha():
                while j < n and src[j].isalpha():
                    j += 1
                tokens.append("\\" + src[i + 1:j])
                i = j
                continue
            if j < n:  # \, \; \{ \} 之类
                tokens.append("\\" + src[j])
                i = j + 1
                continue
            i += 1
            continue
        if ch in "{}^_":
            tokens.append(ch)
            i += 1
            continue
        if ch == "[" or ch == "]":
            tokens.append(ch)
            i += 1
            continue
        if ch.isdigit():
            j = i
            while j < n and (src[j].isdigit() or src[j] == "."):
                j += 1
            tokens.append(src[i:j])
            i = j
            continue
        tokens.append(ch)
        i += 1
    return tokens


# ── OMML 构件 ───────────────────────────────────────────────────────────────

def _run(text: str, style: str = "i", bold: bool = False):
    """一个 OMML run。带上 `w:rPr/w:rFonts`：

    · `ascii/hAnsi` 钉 Cambria Math（Word 的公式字体，缺了会回退得很难看）
    · `eastAsia` 钉中文字体 —— 公式里 `\\text{中文}` 时，Word 靠它找汉字字形
      （LibreOffice/WPS 的公式引擎只认数学字体，中文仍可能显示成方块，见 SKILL.md 的边界说明）
    """
    from lxml import etree

    r = etree.Element(M + "r")
    r_pr = etree.SubElement(r, M + "rPr")
    if style:
        etree.SubElement(r_pr, M + "sty").set(M + "val", style)
    if bold:
        etree.SubElement(r_pr, M + "b")
    w_rpr = etree.SubElement(r, W + "rPr")
    fonts = etree.SubElement(w_rpr, W + "rFonts")
    fonts.set(W + "ascii", MATH_FONT)
    fonts.set(W + "hAnsi", MATH_FONT)
    fonts.set(W + "eastAsia", CJK_MATH_FONT)
    t = etree.SubElement(r, M + "t")
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return r


def _wrap(tag: str, el):
    from lxml import etree

    box = etree.Element(M + tag)
    box.append(el)
    return box


def _e_wrap(nodes) -> list:
    """把若干节点装进 `<m:e>`（分式/根式/上下标的"主体"容器）。"""
    from lxml import etree

    e = etree.Element(M + "e")
    for node in nodes:
        e.append(node)
    return [e]


def _lim_wrap(tag: str, nodes) -> list:
    from lxml import etree

    box = etree.Element(M + tag)
    for node in (nodes or []):
        box.append(node)
    return [box] if nodes else []


class Parser:
    def __init__(self, src: str):
        for env in _UNSUPPORTED_ENVS:
            if "\\begin{" + env + "}" in src:
                raise LatexError(
                    f"暂不支持 {env} 环境（矩阵/多行对齐要手写 OMML 结构）")
        self.tokens = tokenize(src)
        self.pos = 0

    # -- 基础 --
    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self):
        tok = self.peek()
        self.pos += 1
        return tok

    # -- 语法 --
    def parse(self, stop: set | None = None) -> list:
        nodes: list = []
        while True:
            tok = self.peek()
            if tok is None or (stop and tok in stop):
                break
            nodes.extend(self.atom())
        return nodes

    def group(self) -> list:
        """`{...}` 或单个原子（LaTeX 的 `x^2` 与 `x^{2}` 等价）。"""
        tok = self.peek()
        if tok == "{":
            self.take()
            body = self.parse(stop={"}"})
            if self.peek() == "}":
                self.take()
            return body
        if tok is None:
            return []
        if tok in ("^", "_", "}"):
            self.take()
            return []
        return self.base_atom()

    def atom(self) -> list:
        nodes = self.base_atom()
        # 附着上下标
        while self.peek() in ("^", "_"):
            op = self.take()
            arg = self.group()
            if op == "^":
                nodes = self.supsub(nodes, arg, sup=True)
            else:
                nodes = self.supsub(nodes, arg, sup=False)
        return nodes

    def base_atom(self) -> list:
        from lxml import etree

        tok = self.peek()
        if tok is None:
            return []
        if tok == "{":
            return self.group()
        tok = self.take()
        if tok.startswith("\\"):
            name = tok[1:]
            if name in ("frac", "dfrac", "tfrac"):
                num = self.group()
                den = self.group()
                f = etree.Element(M + "f")
                for tag, part in (("num", num), ("den", den)):
                    box = etree.SubElement(f, M + tag)
                    for node in part:
                        box.append(node)
                return [f]
            if name == "sqrt":
                deg = None
                if self.peek() == "[":
                    self.take()
                    deg = self.parse(stop={"]"})
                    if self.peek() == "]":
                        self.take()
                body = self.group()
                rad = etree.Element(M + "rad")
                if deg:
                    deg_el = etree.SubElement(rad, M + "deg")
                    for node in deg:
                        deg_el.append(node)
                e = etree.SubElement(rad, M + "e")
                for node in body:
                    e.append(node)
                return [rad]
            if name in NARY:
                sub = sup = None
                while self.peek() in ("_", "^"):
                    op = self.take()
                    if op == "_":
                        sub = self.group()
                    else:
                        sup = self.group()
                body = self.group()
                nary = etree.Element(M + "nary")
                pr = etree.SubElement(nary, M + "naryPr")
                etree.SubElement(pr, M + "chr").set(M + "val", NARY[name])
                etree.SubElement(pr, M + "limLoc").set(M + "val", "undOvr")
                # 上下限容器**必须存在**（可以为空）：缺了 LibreOffice 会把整个算子画成方块
                for tag, part in (("sub", sub), ("sup", sup)):
                    box = etree.SubElement(nary, M + tag)
                    for node in (part or []):
                        box.append(node)
                e = etree.SubElement(nary, M + "e")
                for node in body:
                    e.append(node)
                return [nary]
            if name in ("text", "mathrm", "mathbf", "operatorname", "textrm"):
                body = self.group()
                text = "".join(n.text or "" for n in body)
                return [_run(text, style="p", bold=(name == "mathbf"))]
            if name in GREEK:
                return [_run(GREEK[name])]
            if name in SYMBOLS:
                return [_run(SYMBOLS[name], style="p")]
            if name in FUNCS:
                return [_run(name, style="p")]
            if name in _IGNORED:
                return []
            if name in ("{", "}", "%", "&", "#", "_"):
                return [_run(name, style="p")]
            raise LatexError(f"不认识的命令：\\{name}")
        if tok == "^" or tok == "_":
            return []
        if tok in ("}", "]"):
            return []
        return [_run(tok)]

    def supsub(self, base: list, arg: list, sup: bool):
        from lxml import etree

        tag = "sSup" if sup else "sSub"
        el = etree.Element(M + tag)
        e = etree.SubElement(el, M + "e")
        for node in base:
            e.append(node)
        wrap = etree.SubElement(el, M + ("sup" if sup else "sub"))
        for node in arg:
            wrap.append(node)
        return [el]


def to_omml(latex: str):
    """LaTeX → `<m:oMath>` 元素（行内公式，可塞进段落）。"""
    from lxml import etree

    parser = Parser(latex)
    nodes = parser.parse()
    if parser.peek() is not None:
        raise LatexError(f"多余的记号：{parser.peek()!r}")
    if not nodes:
        raise LatexError("公式是空的")
    om = etree.Element(M + "oMath", nsmap={"m": M[1:-1]})
    for node in nodes:
        om.append(node)
    return om


def to_omml_para(latex: str):
    """LaTeX → `<m:oMathPara>`（独占一行的公式段落内容）。"""
    from lxml import etree

    para = etree.Element(M + "oMathPara", nsmap={"m": M[1:-1]})
    para.append(to_omml(latex))
    return para


def has_cjk(latex: str) -> bool:
    """公式里有没有中文/全角字符（渲染上要特别小心，回执里要提醒）。"""
    return any(ord(ch) > 0x2E7F for ch in latex)


def plain_text(latex: str) -> str:
    """公式的可读近似（给 view.txt / 回执用，不是渲染）。"""
    out = []
    for tok in tokenize(latex):
        if tok in ("{", "}"):
            continue
        if tok.startswith("\\"):
            name = tok[1:]
            if name in GREEK:
                out.append(GREEK[name])
            elif name in NARY:
                out.append(NARY[name])
            elif name in SYMBOLS:
                out.append(SYMBOLS[name])
            elif name in ("frac", "sqrt", "text", "mathrm", "mathbf"):
                out.append("")
            elif name in ("left", "right") or name in _IGNORED:
                out.append("")
            else:
                out.append(name)
        elif tok in ("^", "_"):
            out.append(tok)
        else:
            out.append(tok)
    return re.sub(r"\s+", "", "".join(out))
