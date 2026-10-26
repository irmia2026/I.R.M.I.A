#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""技能冒烟：`skills/office` 的十余条端到端动作，真跑、真断言、留产物。

为什么放在 `test/` 而不是仓库测试框架里：仓库 `test/*.test.ts` 是 `node --test` 跑的 TS 用例，
这个技能是纯 Python 脚本，塞进 node 的测试列表只会互相拖累。所以它是独立脚本，
在**仓库外**的工作目录里跑（技能产物不许写进仓库）：

    python test/office-skill-smoke.py --dir _ops-office-kit\\smoke

覆盖（每条都打印关键读数 + 产物路径 + PASS/FAIL）：
  ① md → docx（标题/列表/表格/中文/插图）      ② docx → 预览文本
  ③ docx 批注（新增，读回锚点）                ③b docx 修订（w:ins）+ 读回
  ③c docx 批注**回复 + 标记已解决**（幂等重跑）
  ④a xlsx 建表（含**原生图表 + 条件格式**）    ④b xlsx 重算（三态如实）
  ④c xlsx 读回值/公式                         ④d xlsx **加图表**（同标题重跑不重复加）
  ⑤a chart 画柱图（字形预检 + contact sheet）  ⑤b chart 画饼图（给后面 PDF 用）
  ⑥ pdf build（中文 + 插图 + 出图）            ⑦ pdf **抽图**（PNG + contact sheet，重跑）
  ⑧ pdf **from-html**（本地渲染链，重跑）      ⑨ pdf 抽文本 / 抽表格 / 拆页
  ⑩ docx **插图**（同 caption 重跑=替换）      ⑪ docx 校验**深检查**（正向 + 故意弄坏的反向）
  ⑫ 技能目录零 `__pycache__`（跑完复核）

任一断言失败 → 退出码 1；全绿 → 0。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OFFICE = REPO / "skills" / "office" / "scripts" / "office.py"
SKILL_DIR = REPO / "skills" / "office"

# Windows 控制台默认 GBK：不打这一行，✓/✗ 和中文会直接把脚本打死
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover - 老 Python / 被重定向
        pass

REPORT_MD = """# 季度运营复盘：仓储与配送

本季度仓储周转率提升 **12.4%**，配送准点率达到 `98.7%`。

## 一、核心结论

1. 华东仓的拣货路径优化生效，单均拣货时间从 4.8 分钟降到 4.1 分钟。
2. 华南仓因为暴雨停摆两天，准点率拖累约 0.6 个百分点。

![图 1：季度订单量对比](out/chart-bar.png)

> 一句话：**结构性改善已经发生。**

## 二、关键数据

| 区域 | 订单量（万单） | 准点率 | 周转天数 |
|---|---|---|---|
| 华东 | 182.5 | 99.2% | 11.4 |
| 华南 | 96.3 | 97.1% | 14.8 |
| 合计 | 366.8 | 98.7% | 12.6 |

## 三、脚本留档

```python
def on_time_rate(delivered: int, on_time: int) -> float:
    return round(on_time / delivered * 100, 2)
```

<!-- pagebreak -->

## 四、附录：责任人

口径由运营数据组提供，负责人：王工。
"""

BOOK_JSON = {
    "calc_on_load": True,
    "sheets": [
        {
            "name": "汇总",
            "cols": {"A": 18, "B": 12, "C": 12, "D": 14, "E": 12},
            "rows": [
                ["产品", "销量", "单价", "金额", "占比"],
                ["产品甲", 120, 150.5, None, None],
                ["产品乙", 96, 220, None, None],
                ["产品丙", 48, 330.25, None, None],
                ["合计", None, None, None, None],
            ],
            "formulas": {
                "D2": "=B2*C2", "D3": "=B3*C3", "D4": "=B4*C4",
                "D5": "=SUM(D2:D4)", "B5": "=SUM(B2:B4)",
                "E2": "=ROUND(D2/D5*100,2)", "E3": "=ROUND(D3/D5*100,2)",
                "E4": "=ROUND(D4/D5*100,2)", "E5": "=ROUND(SUM(E2:E4),2)",
            },
            "styles": {
                "A1:E1": {"bold": True, "fill": "EDF1F6", "align": "center"},
                "D2:E5": {"number_format": "#,##0.00"},
            },
            "charts": [
                {"type": "bar", "title": "销量对比", "data": "B1:B4", "categories": "A2:A4",
                 "anchor": "G2"},
                {"type": "pie", "title": "销量结构", "data": "B1:B4", "categories": "A2:A4",
                 "anchor": "G20"},
            ],
            "conditional": [
                {"range": "B2:B4", "rule": "dataBar", "color": "638EC6"},
                {"range": "C2:C4", "rule": "colorScale"},
            ],
            "freeze": "A2",
        }
    ],
}

CHART_BAR = {
    "type": "bar",
    "title": "季度订单量对比",
    "subtitle": "单位：万单 · 数据来源：运营月报",
    "categories": ["华东", "华南", "华北"],
    "series": [{"name": "Q3", "values": [182.5, 96.3, 88.0]},
               {"name": "Q4", "values": [201.4, 104.8, 92.6]}],
    "y_label": "万单",
    "show_values": True,
}

CHART_PIE = {
    "type": "pie",
    "title": "订单结构",
    "categories": ["华东", "华南", "华北"],
    "series": [{"name": "订单量", "values": [182.5, 96.3, 88.0]}],
}

REPORT_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>周报</title>
<style>body { font: 16px/1.6 sans-serif; }</style></head>
<body>
<h1>仓储配送周报（HTML 源）</h1>
<p>本周准点率 <strong>98.7%</strong>，周转 <code>12.6</code> 天，覆盖 3 个区域。</p>
<ul>
  <li>华东：拣货路径优化生效</li>
  <li>华南：暴雨停摆两天
    <ul><li>准点率影响 0.6 个百分点</li></ul>
  </li>
</ul>
<table>
  <tr><th>区域</th><th>订单量（万单）</th><th>准点率</th></tr>
  <tr><td>华东</td><td>182.5</td><td>99.2%</td></tr>
  <tr><td>华南</td><td>96.3</td><td>97.1%</td></tr>
  <tr><td>华北</td><td>88.0</td><td>98.4%</td></tr>
</table>
<pre>def on_time_rate(delivered, on_time):
    return round(on_time / delivered * 100, 2)</pre>
<blockquote>一句话：结构性改善已经发生。</blockquote>
<hr/>
<p><img src="out/chart-pie.png" alt="图 2：订单结构"/></p>
</body></html>
"""

# 第二轮夹具：版式全家桶（封面/页眉页脚/三线表/脚注/公式/分节分栏）
LAYOUT_MD = """# 季度运营复盘

本季度仓储周转率提升 **12.4%**[^kpi]，配送准点率达到 `98.7%`。

[^kpi]: 周转率口径：出库单量 / 平均库存，按周加权。

## 一、核心结论

1. 华东仓的拣货路径优化生效，单均拣货时间从 4.8 分钟降到 4.1 分钟。
2. 华南仓因为暴雨停摆两天，准点率拖累约 0.6 个百分点。

| 区域 | 订单量（万单） | 准点率 | 周转天数 |
|---|---|---|---|
| 华东 | 182.5 | 99.2% | 11.4 |
| 华南 | 96.3 | 97.1% | 14.8 |
| 华北 | 88.0 | 98.4% | 12.1 |

## 二、准点率公式

$$ R = \\frac{N_{ontime}}{N_{total}} \\times 100\\% $$

<!-- sectionbreak -->
<!-- columns: 2 -->

## 三、附录

左栏：口径由运营数据组提供，按周加权计算，含华东、华南、华北三个区域。

右栏：下季度起改为日粒度统计，指标口径不变，历史数据按周回填。
"""

# 第二轮夹具：PDF 富文本（内链 / 代码高亮 / 三线表 / 公式 / 脚注）
RICH_MD = """# 技术说明 {#top}

见 [公式一节](#formula) 与脚注[^a]。

## 代码

```python
def on_time_rate(delivered: int, on_time: int) -> float:
    return round(on_time / delivered * 100, 2)
```

| 区域 | 订单量 | 准点率 |
|---|---|---|
| 华东 | 182.5 | 99.2% |
| 华南 | 96.3 | 97.1% |

## 公式 {#formula}

$$ R = \\frac{N_{ontime}}{N_{total}} \\times 100\\% $$

[^a]: 口径：按周加权。
"""

# 第二轮夹具：复杂 HTML（@page / 强制分页 / colspan / rowspan）
COMPLEX_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 18mm }
h1 { page-break-before: always }
.next { page-break-before: always }
</style></head><body>
<h1>第一页标题</h1><p>正文 <strong>加粗</strong> 与 <code>代码</code>。</p>
<table>
 <tr><th colspan="3">合并表头（跨 3 列）</th></tr>
 <tr><td rowspan="2">跨两行</td><td>A1</td><td>B1</td></tr>
 <tr><td>A2</td><td>B2</td></tr>
</table>
<h1 class="next">第三页标题</h1><p>分页之后的内容。</p>
</body></html>
"""

# 第二轮夹具：批注批量计划（加 / 回复 / 解决 / 撤销）
COMMENT_PLAN = [
    {"op": "add", "anchor": "华东仓的拣货路径优化生效", "text": "这句要补数据来源。", "author": "用户"},
    {"op": "reply", "id": "0", "text": "来源见附录 A。", "author": "王工"},
    {"op": "resolve", "id": "0"},
    {"op": "unresolve", "id": "1"},
]


def make_form_pdf(path: Path) -> None:
    """造一份带 AcroForm 字段的 PDF（表单那条链路要有输入才测得了）。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("Helvetica", 14)
    c.drawString(60, 780, "Office Smoke Form")
    c.acroForm.textfield(name="applicant", x=60, y=720, width=220, height=20, borderWidth=1)
    c.acroForm.textfield(name="dept", x=60, y=680, width=220, height=20, borderWidth=1)
    c.showPage()
    c.save()


def make_big_pdf(path: Path, pages: int = 260) -> None:
    """造一份 260 页的 PDF，验证"大文件分批"。"""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(pages):
        c.setFont("Helvetica", 12)
        c.drawString(60, 760, f"page {i + 1} / {pages}")
        c.showPage()
    c.save()



class Runner:
    def __init__(self, work: Path):
        self.work = work
        self.results: list[dict] = []

    def run(self, *args: str) -> tuple[dict, int, str]:
        argv = [sys.executable, str(OFFICE), *args, "--json"]
        proc = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", cwd=str(self.work))
        cmd = "python office.py " + " ".join(args)
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            payload = {"ok": False,
                       "error": {"code": "NotJson",
                                 "message": (proc.stdout[:800] + proc.stderr[:800])}}
        return payload, proc.returncode, cmd

    def record(self, step: str, cmd: str, payload: dict, checks: list[tuple[str, bool]],
               extra: dict | None = None, readouts: dict | None = None,
               expect_fail: bool = False):
        """`expect_fail=True` 时"成功"的定义反过来：必须 ok=false 且断言都成立（反向用例）。"""
        if expect_fail:
            ok = (payload.get("ok") is False) and all(v for _, v in checks)
        else:
            ok = payload.get("ok") and all(v for _, v in checks)
        self.results.append({
            "step": step, "cmd": cmd, "ok": bool(ok), "expected_fail": expect_fail,
            "checks": [{"what": w, "pass": bool(v)} for w, v in checks],
            "artifacts": [a.get("path") for a in payload.get("artifacts", [])],
            "readouts": readouts or {},
            **(extra or {}),
            **({} if payload.get("ok") or expect_fail else {"error": payload.get("error")}),
        })
        mark = "PASS" if ok else "FAIL"
        print(f"\n[{mark}] {step}")
        print(f"       $ {cmd}")
        for key, val in (readouts or {}).items():
            print(f"       · {key} = {val}")
        for what, val in checks:
            print(f"       {'✓' if val else '✗'} {what}")
        if payload.get("artifacts"):
            print(f"       → 产物：{', '.join(a.get('path', '?') for a in payload['artifacts'])}")
        if payload.get("warnings"):
            print(f"       ! warnings: {json.dumps(payload['warnings'], ensure_ascii=False)[:300]}")
        if not payload.get("ok") and not expect_fail:
            print(f"       ✗ error: {json.dumps(payload.get('error'), ensure_ascii=False)[:600]}")
        return ok


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="", help="工作目录（默认当前目录；不要指到仓库里）")
    args = ap.parse_args(argv)
    work = Path(args.dir).resolve() if args.dir else Path.cwd()
    work.mkdir(parents=True, exist_ok=True)
    out = work / "out"
    out.mkdir(exist_ok=True)
    (work / "report.md").write_text(REPORT_MD, encoding="utf-8")
    (work / "book.json").write_text(json.dumps(BOOK_JSON, ensure_ascii=False, indent=2), encoding="utf-8")
    (work / "report.html").write_text(REPORT_HTML, encoding="utf-8")
    (work / "chart-bar.json").write_text(json.dumps(CHART_BAR, ensure_ascii=False, indent=2), encoding="utf-8")
    (work / "chart-pie.json").write_text(json.dumps(CHART_PIE, ensure_ascii=False, indent=2), encoding="utf-8")
    (work / "layout.md").write_text(LAYOUT_MD, encoding="utf-8")
    (work / "rich.md").write_text(RICH_MD, encoding="utf-8")
    (work / "complex.html").write_text(COMPLEX_HTML, encoding="utf-8")
    (work / "comment-plan.json").write_text(json.dumps(COMMENT_PLAN, ensure_ascii=False, indent=2),
                                            encoding="utf-8")
    make_form_pdf(out / "form.pdf")
    make_big_pdf(out / "big.pdf", 260)

    print(f"工作目录：{work}")
    print(f"入口    ：{OFFICE}")
    r = Runner(work)
    all_ok = True

    # ── ⑤a 先画图：后面的 docx / pdf 插图要用它 ────────────────────────────
    p, _, cmd = r.run("chart", "build", "--from", "chart-bar.json", "--out", "out/chart-bar.png")
    d = p.get("data") or {}
    bar_px = d.get("px") or [d.get("width"), d.get("height")]
    sheet_bar = d.get("contact_sheet") or ""
    chart_ok = r.record("⑤a chart 画柱图（Pillow + 字形预检 + contact sheet）", cmd, p, [
        ("图产出来了", (d.get("width") or 0) > 100 and (d.get("height") or 0) > 100),
        ("字形预检 0 缺字", (d.get("preflight") or {}).get("ok") is True
         and not (d.get("preflight") or {}).get("missing")),
        ("预检真的查过字", ((d.get("preflight") or {}).get("checked_chars") or 0) > 5),
        ("两列数据都画了", len(d.get("series") or []) == 2),
        ("墨迹率 > 0.01（不是白板）", (d.get("ink_ratio") or 0) > 0.01),
        ("contact sheet 存在", bool(sheet_bar) and (work / sheet_bar).exists()),
    ], readouts={"画布": f"{d.get('width')}×{d.get('height')}", "墨迹率": d.get("ink_ratio"),
                 "contact sheet": sheet_bar},
        extra={"contact_sheet": sheet_bar, "px": bar_px})
    # 重跑幂等
    p, _, cmd = r.run("chart", "build", "--from", "chart-bar.json", "--out", "out/chart-bar.png")
    d2 = p.get("data") or {}
    chart_ok &= r.record("⑤a-重跑 chart 画柱图（覆盖不炸）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("图还是那么大", (d2.get("width"), d2.get("height")) == (d.get("width"), d.get("height"))),
    ], readouts={"bytes": d2.get("bytes")})

    p, _, cmd = r.run("chart", "build", "--from", "chart-pie.json", "--out", "out/chart-pie.png")
    d = p.get("data") or {}
    chart_ok &= r.record("⑤b chart 画饼图（给 PDF 插图用）", cmd, p, [
        ("饼图产出来了", (d.get("type") == "pie")),
        ("有 3 个分类", len(d.get("categories") or []) == 3),
        ("字形预检通过", (d.get("preflight") or {}).get("ok") is True),
    ], readouts={"画布": f"{d.get('width')}×{d.get('height')}", "字节": d.get("bytes")})
    all_ok &= chart_ok

    # ── ① md → docx（含插图） ───────────────────────────────────────────────
    p, _, cmd = r.run("docx", "build", "--from", "report.md", "--out", "out/report.docx",
                      "--title", "季度运营复盘", "--subtitle", "仓储与配送 · 2026 Q3")
    d = p.get("data") or {}
    all_ok &= r.record("① md → docx（标题/列表/表格/中文/插图）", cmd, p, [
        ("建出 docx", bool(d.get("out"))),
        ("结构校验不是 fail", d.get("validate", {}).get("status") != "fail"),
        ("是干净通过（没有遗留告警）", d.get("validate", {}).get("status") == "pass"),
        ("有表格", (d.get("tables") or 0) >= 1),
        ("有插图（Markdown 的 ![]() 生效）", (d.get("images") or 0) == 1),
        ("有中文", bool(d.get("cjk_ok"))),
    ], readouts={"段落": d.get("paragraphs"), "表格": d.get("tables"), "插图": d.get("images"),
                 "校验": d.get("validate", {}).get("status"), "字节": d.get("bytes"),
                 "顺手修的": d.get("repairs")})

    # ── ② docx → 预览文本 ──────────────────────────────────────────────────
    p, _, cmd = r.run("docx", "view", "--file", "out/report.docx")
    d = p.get("data") or {}
    view_text = d.get("view") or ""
    all_ok &= r.record("② docx → 预览文本", cmd, p, [
        ("段落数 > 5", (d.get("paragraph_count") or 0) > 5),
        ("预览里有表格行", "TABLE" in view_text),
        ("预览里有标题样式", "Heading1" in view_text),
        ("中文段落可读", "华东仓的拣货路径优化生效" in view_text),
    ], readouts={"段落": d.get("paragraph_count"), "表格": d.get("table_count"),
                 "块": d.get("blocks"), "字数": d.get("chars")})

    # ── ③ 批注 + 修订 ──────────────────────────────────────────────────────
    p1, _, cmd1 = r.run("docx", "comment", "--file", "out/report.docx",
                        "--anchor", "准点率拖累约 0.6 个百分点",
                        "--text", "0.6 是怎么算的？把口径写进附录。", "--author", "用户",
                        "--out", "out/report-c.docx")
    d1 = p1.get("data") or {}
    p2, _, cmd2 = r.run("docx", "track", "--file", "out/report-c.docx",
                        "--text", "（补：华南仓 7/12-7/13 停摆）", "--after", "华南仓因为暴雨停摆两天",
                        "--author", "用户", "--out", "out/report-cr.docx")
    p3, _, cmd3 = r.run("docx", "comments", "--file", "out/report-cr.docx")
    d3 = p3.get("data") or {}
    p4, _, cmd4 = r.run("docx", "revisions", "--file", "out/report-cr.docx")
    d4 = p4.get("data") or {}
    p5, _, cmd5 = r.run("docx", "validate", "--file", "out/report-cr.docx")
    d5 = p5.get("data") or {}
    comment0 = (d3.get("comments") or [{}])[0]
    ok3 = r.record("③ docx 批注（新增，读回锚点）", cmd1, p1, [
        ("批注写入成功", bool(p1.get("ok"))),
        ("批注锚点读回非空", bool(comment0.get("anchor"))),
        ("锚点文字对得上", comment0.get("anchor") == "准点率拖累约 0.6 个百分点"),
    ], readouts={"批注 id": d1.get("comment", {}).get("id"),
                 "锚点匹配方式": d1.get("comment", {}).get("matched_by")})
    ok3 &= r.record("③b 修订插入（w:ins）+ 读回", cmd2, p2, [
        ("修订写入成功", bool(p2.get("ok"))),
        ("修订数 >= 1", (d4.get("count") or 0) >= 1),
        ("修订类型是 insert", ((d4.get("revisions") or [{}])[0].get("kind") == "insert")),
        ("带作者", ((d4.get("revisions") or [{}])[0].get("author") == "用户")),
        ("改完还能过校验", d5.get("status") == "pass"),
        ("批注仍可读回", (d3.get("count") or 0) >= 1),
    ], readouts={"修订数": d4.get("count"), "校验": d5.get("status")})

    # ── ③c 批注的回复 + 标记已解决（本轮新增） ──────────────────────────────
    parent_id = (d1.get("comment") or {}).get("id")
    p, _, cmd = r.run("docx", "comment", "--file", "out/report-cr.docx", "--reply-to", str(parent_id),
                      "--text", "口径见附录 A：按停摆天数/应达天数折算。", "--author", "王工",
                      "--out", "out/report-reply.docx")
    d = p.get("data") or {}
    reply = d.get("reply") or {}
    reply_ok = r.record("③c docx 批注**回复**（w15:commentEx 的 paraIdParent）", cmd, p, [
        ("回复写入成功", bool(p.get("ok"))),
        ("回复挂上了父批注", reply.get("parent") == str(parent_id)),
        ("回复有自己的 paraId", bool(reply.get("para_id"))),
        ("父批注的 paraId 也写上了", bool(reply.get("parent_para_id"))),
        ("文档里现在 2 条批注", (d.get("comments_in_doc") or 0) == 2),
    ], readouts={"回复 id": reply.get("id"), "父批注": reply.get("parent"),
                 "paraId": f"{reply.get('para_id')} ← {reply.get('parent_para_id')}"})

    p, _, cmd = r.run("docx", "resolve", "--file", "out/report-reply.docx",
                      "--id", str(parent_id), "--out", "out/report-resolved.docx")
    d = p.get("data") or {}
    reply_ok &= r.record("③c-2 docx 批注**标记已解决**（w15:done=1）", cmd, p, [
        ("标记成功", bool(p.get("ok"))),
        ("读回来是已解决", d.get("resolved") is True),
        ("已解决计数 = 1", (d.get("resolved_count") or 0) == 1),
    ], readouts={"mode": d.get("mode"), "已解决": d.get("resolved_count")})

    # 幂等：再标一次同一状态不炸
    p, _, cmd = r.run("docx", "resolve", "--file", "out/report-resolved.docx",
                      "--id", str(parent_id), "--out", "out/report-resolved2.docx")
    d = p.get("data") or {}
    reply_ok &= r.record("③c-3 docx 标记已解决**重跑**（幂等）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("仍然是已解决", d.get("resolved") is True),
    ], readouts={"已解决计数": d.get("resolved_count")})

    p, _, cmd = r.run("docx", "comments", "--file", "out/report-resolved2.docx")
    d = p.get("data") or {}
    cmts = d.get("comments") or []
    reply_ok &= r.record("③c-4 批注读回（已解决 + 回复关系都在）", cmd, p, [
        ("commentsExtended 部件在", d.get("extended") is True),
        ("有 1 条回复", (d.get("replies") or 0) == 1),
        ("有 1 条已解决", (d.get("resolved_count") or 0) == 1),
        ("回复指向父批注",
         any(c.get("parent") == str(parent_id) for c in cmts)),
    ], readouts={"批注数": d.get("count"), "回复": d.get("replies"),
                 "已解决": d.get("resolved_count")})
    all_ok &= ok3 and reply_ok

    # ── ④a-④c xlsx 建表 / 重算 / 读回 ──────────────────────────────────────
    p, _, cmd = r.run("xlsx", "build", "--from", "book.json", "--out", "out/book.xlsx")
    d = p.get("data") or {}
    v = d.get("verify") or {}
    build_ok = r.record("④a xlsx 建表（9 公式 + 2 图表 + 2 条件格式）", cmd, p, [
        ("建出 xlsx", bool(d.get("out"))),
        ("公式数 = 9", (v.get("formulas") or 0) == 9),
        ("原生图表 2 个", (v.get("charts") or 0) == 2),
        ("图表都有 series", v.get("chart_series_ok") is True),
        ("条件格式 2 条", (v.get("conditional_rules") or 0) == 2),
        ("建完是 unverified（还没缓存值）", v.get("status") == "unverified"),
    ], readouts={"公式": v.get("formulas"), "图表": v.get("charts"),
                 "条件格式": v.get("conditional_rules"), "状态": v.get("status")})

    p, _, cmd = r.run("xlsx", "recalc", "--file", "out/book.xlsx", "--out", "out/book-recalc.xlsx")
    d = p.get("data") or {}
    recalc_route = d.get("route")
    recalc_honest = bool(d.get("delivery_file_recalculated"))
    if recalc_honest:
        recalc_checks = [("走 LibreOffice 并写回缓存", recalc_route == "libreoffice"),
                         ("交付件真的重算了", recalc_honest),
                         ("公式被保留", d.get("formulas_preserved") is True)]
    else:
        recalc_checks = [("走了降级路线", recalc_route in ("formulas", "calc_mode_auto")),
                         ("回执如实说明没写回缓存", d.get("delivery_file_recalculated") is False)]
    recalc_ok = r.record("④b xlsx 重算（三条路如实报）", cmd, p, recalc_checks,
                         readouts={"route": recalc_route,
                                   "delivery_file_recalculated": d.get("delivery_file_recalculated")})

    p, _, cmd = r.run("xlsx", "read", "--file", "out/book-recalc.xlsx", "--sheet", "汇总", "--range", "A1:E5")
    d = p.get("data") or {}
    rows = (d.get("sheets") or [{}])[0].get("rows") or []
    by_ref = {c["ref"]: c for row in rows for c in row}
    d5_cell = (by_ref.get("D5") or {})
    all_ok &= r.record("④c xlsx 读回值（公式 + 缓存值）", cmd, p, [
        ("D2 = 120×150.5 = 18060", (by_ref.get("D2") or {}).get("cached") == 18060),
        ("D5 = 55032（合计）", d5_cell.get("cached") == 55032),
        ("公式原文还在", d5_cell.get("formula") == "=SUM(D2:D4)"),
    ], readouts={"D2": (by_ref.get("D2") or {}).get("cached"),
                 "D5": d5_cell.get("cached"), "D5 公式": d5_cell.get("formula")})

    # ── ④d 给已有工作簿加图表（本轮新增） ───────────────────────────────────
    p, _, cmd = r.run("xlsx", "chart", "--file", "out/book.xlsx", "--out", "out/book-chart.xlsx",
                      "--type", "line", "--data", "汇总!B1:C4", "--categories", "汇总!A2:A4",
                      "--title", "趋势（折线）", "--anchor", "G40")
    d = p.get("data") or {}
    chart_x = r.record("④d xlsx **加图表**（折线，数据区域带表名）", cmd, p, [
        ("加进去了", d.get("added") is True),
        ("图表总数 = 3", (d.get("charts") or 0) == 3),
        ("原有条件格式没丢", (d.get("conditional_rules") or 0) == 2),
        ("系列都在", d.get("chart_series_ok") is True),
    ], readouts={"图表": d.get("charts"), "条件格式": d.get("conditional_rules"),
                 "条件格式（前→后）": d.get("preserved")})
    p, _, cmd = r.run("xlsx", "chart", "--file", "out/book-chart.xlsx", "--out", "out/book-chart2.xlsx",
                      "--type", "line", "--data", "汇总!B1:C4", "--categories", "汇总!A2:A4",
                      "--title", "趋势（折线）", "--anchor", "G40")
    d = p.get("data") or {}
    chart_x &= r.record("④d-2 同标题图表**重跑**（幂等：不重复加）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("没有重复添加", d.get("skipped_existing") is True),
        ("图表总数还是 3", (d.get("charts") or 0) == 3),
    ], readouts={"added": d.get("added"), "图表": d.get("charts")})
    all_ok &= build_ok and recalc_ok and chart_x

    # ── ⑥ pdf build（中文 + 插图 + 出图） ───────────────────────────────────
    p, _, cmd = r.run("pdf", "build", "--from", "report.md", "--out", "out/report.pdf",
                      "--title", "季度运营复盘", "--qa-dir", "out/qa-pdf", "--dpi", "120")
    d = p.get("data") or {}
    rt = d.get("text_roundtrip") or {}
    fa = d.get("font_audit") or {}
    pf = d.get("preflight") or {}
    rr = d.get("render") or {}
    sheet = rr.get("contact_sheet") or ""
    all_ok &= r.record("⑥ md → pdf（中文 + 插图 + PNG + contact sheet）", cmd, p, [
        ("pdf 建出来了", (d.get("pages") or 0) >= 1),
        ("字形预检 0 缺失", pf.get("ok") is True and not pf.get("missing")),
        ("字体全部嵌入", fa.get("all_embedded") is True),
        ("文本往返 0 缺字", rt.get("roundtrip_ok") is True),
        ("插图 1 张进了 PDF", (d.get("images") or 0) == 1),
        ("出图页数 = pdf 页数", (rr.get("page_count") or 0) == (d.get("pages") or -1)),
        ("contact sheet 存在", bool(sheet) and (work / sheet).exists()),
        ("没有空白页", not rr.get("blank_pages")),
    ], readouts={"页数": d.get("pages"), "字体": (d.get("font") or {}).get("regular"),
                 "墨迹率": rr.get("mean_ink_ratio"), "contact sheet": sheet},
        extra={"contact_sheet": sheet})

    # ── ⑦ pdf 抽图（本轮新增） ──────────────────────────────────────────────
    p, _, cmd = r.run("pdf", "image", "--file", "out/report.pdf", "--out", "out/imgs")
    d = p.get("data") or {}
    imgs = d.get("images") or []
    got_px = (imgs[0].get("px") if imgs else None) or []
    sheet_img = d.get("contact_sheet") or ""
    img_ok = r.record("⑦ pdf **抽图**（内嵌位图 → PNG + contact sheet）", cmd, p, [
        ("至少抽出 1 张图", (d.get("image_count") or 0) >= 1),
        ("像素尺寸和原图一致（960×560）", got_px == [960, 560]),
        ("每张图都真的落盘", all((work / i["path"]).exists() for i in imgs)),
        ("contact sheet 存在", bool(sheet_img) and (work / sheet_img).exists()),
        ("记下了摆放位置", len(d.get("placements") or []) >= 1),
    ], readouts={"张数": d.get("image_count"), "像素": got_px,
                 "摆放": (d.get("placements") or [{}])[0]})
    p, _, cmd = r.run("pdf", "image", "--file", "out/report.pdf", "--out", "out/imgs")
    d = p.get("data") or {}
    img_ok &= r.record("⑦-2 pdf 抽图**重跑**（覆盖不炸）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("张数没变", (d.get("image_count") or 0) >= 1),
    ], readouts={"张数": d.get("image_count")})
    all_ok &= img_ok

    # ── ⑧ pdf from-html（本轮新增） ─────────────────────────────────────────
    p, _, cmd = r.run("pdf", "from-html", "--from", "report.html", "--out", "out/report-html.pdf",
                      "--engine", "local", "--qa-dir", "out/qa-html", "--dpi", "110")
    d = p.get("data") or {}
    rr = d.get("render") or {}
    fa = d.get("font_audit") or {}
    sheet_h = rr.get("contact_sheet") or ""
    html_ok = r.record("⑧ pdf **from-html**（本地渲染链，不引浏览器）", cmd, p, [
        ("pdf 建出来了", (d.get("pages") or 0) >= 1),
        ("走的是本地 html→blocks→reportlab", "html" in str(d.get("route") or "")),
        ("解析出 8 个块（标题/段/列表/表/代码/引用/hr/图）",
         (d.get("html_blocks") or {}).get("blocks") == 8),
        ("字体全部嵌入", fa.get("all_embedded") is True),
        ("出图 + contact sheet 存在", bool(sheet_h) and (work / sheet_h).exists()),
        ("没有空白页", not rr.get("blank_pages")),
    ], readouts={"页数": d.get("pages"), "块": (d.get("html_blocks") or {}).get("blocks"),
                 "编码": d.get("encoding"), "墨迹率": rr.get("mean_ink_ratio"),
                 "contact sheet": sheet_h})
    p, _, cmd = r.run("pdf", "from-html", "--from", "report.html", "--out", "out/report-html.pdf",
                      "--engine", "local")
    d = p.get("data") or {}
    html_ok &= r.record("⑧-2 pdf from-html**重跑**（覆盖不炸）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("页数稳定", (d.get("pages") or 0) >= 1),
    ], readouts={"页数": d.get("pages")})
    all_ok &= html_ok

    # ── ⑨ pdf 抽文本 / 抽表格 / 拆页 ───────────────────────────────────────
    p, _, cmd = r.run("pdf", "text", "--file", "out/report.pdf")
    d = p.get("data") or {}
    text_ok = r.record("⑨a pdf 抽文本", cmd, p,
                       [("抽到中文", (d.get("cjk_chars") or 0) > 100),
                        ("页数对得上", (d.get("pages_read") or 0) >= 1)],
                       readouts={"字符": d.get("chars"), "中文": d.get("cjk_chars")})
    p, _, cmd = r.run("pdf", "table", "--file", "out/report.pdf", "--out", "out/tables.md")
    d = p.get("data") or {}
    tables = d.get("tables") or []
    cells = (tables[0].get("cells") if tables else []) or []
    flat = " | ".join(" | ".join(row) for row in cells)
    table_ok = r.record("⑨b pdf 抽表格", cmd, p,
                        [("抽到 1 张表", (d.get("table_count") or 0) >= 1),
                         ("表头是区域/订单量/准点率", "区域" in flat and "准点率" in flat),
                         ("数据行含 182.5", "182.5" in flat)],
                        readouts={"表数": d.get("table_count"),
                                  "首表": f"{(tables[0].get('rows') if tables else '?')}×"
                                          f"{(tables[0].get('cols') if tables else '?')}"})
    p, _, cmd = r.run("pdf", "split", "--file", "out/report.pdf", "--out", "out/split")
    d = p.get("data") or {}
    split_ok = r.record("⑨c pdf 拆页", cmd, p,
                        [("拆出的文件数 = pdf 页数", len(d.get("outputs") or []) >= 1),
                         ("每个文件都真的存在", all((work / o["path"]).exists()
                                                for o in d.get("outputs") or []))],
                        readouts={"拆出": len(d.get("outputs") or [])})
    all_ok &= text_ok and table_ok and split_ok

    # ── ⑩ docx 插图（本轮新增） ────────────────────────────────────────────
    p, _, cmd = r.run("docx", "image", "--file", "out/report-resolved2.docx",
                      "--image", "out/chart-pie.png", "--caption", "图 2：订单结构",
                      "--after", "华南仓因为暴雨停摆两天", "--out", "out/report-img.docx")
    d = p.get("data") or {}
    img_doc_ok = r.record("⑩ docx **插图**（锚定段落 + 图注 + alt）", cmd, p, [
        ("插图成功", bool(p.get("ok"))),
        ("文档里有 2 张图（原有 1 + 新 1）", (d.get("images_in_doc") or 0) == 2),
        ("media 部件也是 2 个", len(d.get("media_parts") or []) == 2),
        ("图注写进了 alt", bool((d.get("image") or {}).get("alt"))),
        ("插完仍过校验", (d.get("validate", {}) or {}).get("status") == "pass"),
    ], readouts={"图数": d.get("images_in_doc"), "media": d.get("media_parts"),
                 "宽度(cm)": (d.get("image") or {}).get("width_cm"),
                 "校验": (d.get("validate") or {}).get("status")})
    p, _, cmd = r.run("docx", "image", "--file", "out/report-img.docx",
                      "--image", "out/chart-pie.png", "--caption", "图 2：订单结构",
                      "--out", "out/report-img2.docx")
    d = p.get("data") or {}
    img_doc_ok &= r.record("⑩-2 同 caption 插图**重跑**（替换而不是堆图）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("替换了 1 处旧图", (d.get("replaced_existing") or 0) == 1),
        ("图数没变（还是 2）", (d.get("images_in_doc") or 0) == 2),
    ], readouts={"替换": d.get("replaced_existing"), "图数": d.get("images_in_doc")})
    all_ok &= img_doc_ok

    # ── ⑪ docx 校验的深检查（正向 + 故意弄坏的反向） ────────────────────────
    p, _, cmd = r.run("docx", "validate", "--file", "out/report-img.docx")
    d = p.get("data") or {}
    deep = (d.get("info") or {}).get("deep") or {}
    deep_ok = r.record("⑪ docx 校验**深检查**（元素顺序/批注链/书签/插图）", cmd, p, [
        ("status = pass", d.get("status") == "pass"),
        ("报了跑了哪些深检查", len(deep.get("checks") or []) >= 8),
        ("数过 pPr/rPr/tcPr 的顺序", (deep.get("pPr") or 0) > 0 and (deep.get("rPr") or 0) > 0),
        ("认得出插图与 media", (deep.get("drawings") or 0) == 2 and (deep.get("media") or 0) == 2),
        ("批注扩展链在（commentsExtended）", deep.get("comments_extended") is True),
    ], readouts={"深检查项": len(deep.get("checks") or []), "pPr": deep.get("pPr"),
                 "rPr": deep.get("rPr"), "tcPr": deep.get("tcPr"),
                 "drawing": deep.get("drawings"), "media": deep.get("media"),
                 "commentsExtended": deep.get("comments_extended")})

    # 反向：把 word/media/* 摘掉，必须被判"fail"（否则深检查是摆设）
    broken = work / "out" / "report-broken.docx"
    with zipfile.ZipFile(work / "out" / "report-img.docx") as src, \
            zipfile.ZipFile(broken, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            if item.filename.startswith("word/media/"):
                continue
            dst.writestr(item, src.read(item.filename))
    p, _, cmd = r.run("docx", "validate", "--file", "out/report-broken.docx")
    d = p.get("data") or {}
    errs = d.get("errors") or []
    deep_ok &= r.record("⑪-2 校验**反向**：摘掉 word/media 必须判 fail", cmd, p, [
        ("status = fail", d.get("status") == "fail"),
        ("指出了图丢了", any("media" in e or "图丢了" in e for e in errs)),
    ], readouts={"errors": errs[:2]})
    all_ok &= deep_ok

    # ── ⑫ 出图动作的人眼可查：docx（含插图）与 xlsx（含图表）各出一张 ─────────
    p, _, cmd = r.run("docx", "render", "--file", "out/report-img2.docx", "--out", "out/qa-docx",
                      "--dpi", "120")
    d = p.get("data") or {}
    sheet_docx = d.get("contact_sheet") or ""
    render_docx_ok = r.record("⑫a docx 出图（含插图/批注/修订的最终稿）", cmd, p, [
        ("出了 >= 1 页", (d.get("page_count") or 0) >= 1),
        ("contact sheet 存在", bool(sheet_docx) and (work / sheet_docx).exists()),
        ("没有空白页", d.get("blank_pages") == []),
    ], readouts={"页数": d.get("page_count"), "墨迹率": d.get("mean_ink_ratio"),
                 "缺字体": d.get("missing_fonts"), "contact sheet": sheet_docx},
        extra={"contact_sheet": sheet_docx})

    p, _, cmd = r.run("xlsx", "render", "--file", "out/book-chart.xlsx", "--out", "out/qa-xlsx",
                      "--dpi", "120")
    d = p.get("data") or {}
    sheet_xlsx = d.get("contact_sheet") or ""
    render_xlsx_ok = r.record("⑫b xlsx 出图（带图表的工作簿）", cmd, p, [
        ("出了 >= 1 张表图", (d.get("image_count") or 0) >= 1),
        ("contact sheet 存在", bool(sheet_xlsx) and (work / sheet_xlsx).exists()),
        ("没有空白页", d.get("blank_pages") == []),
    ], readouts={"表图数": d.get("image_count"), "墨迹率": d.get("mean_ink_ratio"),
                 "contact sheet": sheet_xlsx},
        extra={"contact_sheet": sheet_xlsx})
    all_ok &= render_docx_ok and render_xlsx_ok

    # ══════════════════════════════════════════════════════════════════════
    # 第二轮能力：版式 / 目录 / 脚注 / 公式 / 书签 / pandoc / 修订 / 批量批注
    #                    / 三线表 / 高亮 / 表单 / 加密 / 分批 / 抽图引擎 / doctor
    # ══════════════════════════════════════════════════════════════════════

    # ── ⑭ 一次建出"正经文档"：封面 + 页眉页脚页码 + 三线表 + 脚注 + 公式 + 分节分栏
    p, _, cmd = r.run("docx", "build", "--from", "layout.md", "--out", "out/layout.docx",
                      "--title", "季度运营复盘", "--subtitle", "仓储与配送 · 2026 Q3",
                      "--author", "Irmia 数据组", "--cover", "--page-numbers",
                      "--header", "季度运营复盘 · 内部资料 · 第 {page} 页",
                      "--footer", "第 {page} 页 / 共 {pages} 页",
                      "--table-style", "three-line")
    d = p.get("data") or {}
    lay = d.get("layout") or {}
    fn = d.get("footnotes") or {}
    layout_ok = r.record("⑭ docx 建「正经文档」（封面/页眉页脚页码/三线表/脚注/公式/分栏）", cmd, p, [
        ("建出 docx 且校验 pass", (d.get("validate") or {}).get("status") == "pass"),
        ("封面 + 分节=2 节（sectionbreak 生效）", (d.get("sections") or 0) == 2),
        ("页眉页脚写了 PAGE/NUMPAGES 域", (lay.get("page_field") or 0) >= 2
         and (lay.get("pages_field") or 0) >= 1),
        ("三线表样式套上了", (d.get("tables_styled") or 0) >= 1),
        ("脚注注进去了", (fn.get("injected") or 0) == 1),
        ("公式进了文档（OMML）", (d.get("equations") or 0) >= 1),
        ("公式里没有中文（避免方块）", (d.get("cjk_equations") or 0) == 0),
    ], readouts={"节数": d.get("sections"), "页域": lay.get("page_field"),
                 "页码域": lay.get("pages_field"), "三线表": d.get("tables_styled"),
                 "脚注": fn, "公式": d.get("equations"), "校验": (d.get("validate") or {}).get("status")},
        extra={"contact_sheet": ""})

    # ── ⑮ 读回页眉页脚（不信自己的写入路径） ───────────────────────────────
    p, _, cmd = r.run("docx", "read-hf", "--file", "out/layout.docx")
    d = p.get("data") or {}
    secs = d.get("sections") or []
    hdr = (secs[0] or {}).get("header") or {}
    ftr = (secs[0] or {}).get("footer") or {}
    layout_ok &= r.record("⑮ 读回页眉页脚（PAGE / NUMPAGES 域）", cmd, p, [
        ("读到 2 节的页眉页脚", (d.get("count") or 0) == 2),
        ("页眉里有 PAGE 域", "PAGE" in (hdr.get("fields") or [])),
        ("页脚里有 PAGE 与 NUMPAGES", {"PAGE", "NUMPAGES"} <= set(ftr.get("fields") or [])),
        ("页眉文字对得上", "内部资料" in (hdr.get("text") or "")),
    ], readouts={"节": d.get("count"), "页眉": hdr.get("text"), "页脚": ftr.get("text"),
                 "域": (hdr.get("fields"), ftr.get("fields"))})

    # ── ⑯ 脚注读回 ──────────────────────────────────────────────────────────
    p, _, cmd = r.run("docx", "footnotes", "--file", "out/layout.docx")
    d = p.get("data") or {}
    layout_ok &= r.record("⑯ 脚注读回（footnotes.xml + 正文引用）", cmd, p, [
        ("有 1 条脚注", (d.get("count") or 0) == 1),
        ("正文有 1 处引用", (d.get("references") or 0) == 1),
        ("separator/continuationSeparator 都在", d.get("has_separators") is True),
    ], readouts={"脚注": d.get("count"), "引用": d.get("references"),
                 "脚注文本": (d.get("footnotes") or [{}])[0].get("text", "")[:60]})

    # ── ⑰ 目录（TOC 域 + 真页码），并验证重跑幂等 ────────────────────────────
    p, _, cmd = r.run("docx", "toc", "--file", "out/layout.docx", "--out", "out/layout-toc.docx")
    d = p.get("data") or {}
    toc_ok = r.record("⑰ docx 目录（TOC 域 + 书签 + PDF 实测页码）", cmd, p, [
        ("收了 >= 3 条目录项", (d.get("entries") or 0) >= 3),
        ("页码是量出来的（不是占位）", d.get("pages_measured") is True),
        ("页码自检通过", d.get("verified") is True),
        ("插完仍过校验", (d.get("validate") or {}).get("status") == "pass"),
    ], readouts={"条目": d.get("entries"), "页码": d.get("page_numbers"),
                 "passes": d.get("passes"), "verified": d.get("verified")})
    p, _, cmd = r.run("docx", "toc", "--file", "out/layout-toc.docx",
                      "--out", "out/layout-toc2.docx")
    d = p.get("data") or {}
    toc_ok &= r.record("⑰-2 目录**重跑**（先摘旧目录再插，不重复）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("摘掉了上次的目录块", (d.get("removed_previous_toc") or 0) >= 3),
        ("条目数没变", (d.get("entries") or 0) >= 3),
        ("仍过校验", (d.get("validate") or {}).get("status") == "pass"),
    ], readouts={"摘掉": d.get("removed_previous_toc"), "条目": d.get("entries")})

    # ── ⑱ 页眉页脚「单独动作」+ 幂等 ────────────────────────────────────────
    p, _, cmd = r.run("docx", "header-footer", "--file", "out/report.docx",
                      "--out", "out/report-hf.docx", "--page-numbers",
                      "--footer", "机密 · 第 {page} 页 / 共 {pages} 页")
    d = p.get("data") or {}
    hf_ok = r.record("⑱ docx header-footer 动作（写页码域）", cmd, p, [
        ("写入成功", bool(p.get("ok"))),
        ("至少 1 节被处理", (d.get("sections") or 0) >= 1),
        ("写了页码域", (d.get("page_field") or 0) >= 1),
        ("校验 pass", (d.get("validate") or {}).get("status") == "pass"),
    ], readouts={"节": d.get("sections"), "页域": d.get("page_field"),
                 "页码域": d.get("pages_field")})
    p, _, cmd = r.run("docx", "header-footer", "--file", "out/report-hf.docx",
                      "--out", "out/report-hf2.docx", "--page-numbers",
                      "--footer", "机密 · 第 {page} 页 / 共 {pages} 页")
    d = p.get("data") or {}
    hf_ok &= r.record("⑱-2 页眉页脚**重跑**（重写而不是叠加）", cmd, p, [
        ("重跑成功", bool(p.get("ok"))),
        ("页域数还是 1（不叠加）", (d.get("page_field") or 0) == 1),
    ], readouts={"页域": d.get("page_field"), "页码域": d.get("pages_field")})

    # ── ⑲ 三线表「单独动作」 ────────────────────────────────────────────────
    p, _, cmd = r.run("docx", "table-style", "--file", "out/report.docx",
                      "--out", "out/report-3l.docx", "--style", "three-line")
    d = p.get("data") or {}
    t3 = r.record("⑲ docx table-style（三线表）", cmd, p, [
        ("改到 >= 1 张表", (d.get("tables") or 0) >= 1),
        ("校验 pass", (d.get("validate") or {}).get("status") == "pass"),
    ], readouts={"表数": d.get("tables"), "样式": d.get("style")})

    # ── ⑳ 公式「单独动作」（LaTeX → OMML） ──────────────────────────────────
    p, _, cmd = r.run("docx", "equation", "--file", "out/report-3l.docx",
                      "--out", "out/report-eq.docx", "--latex",
                      r"\sum_{i=1}^{n} x_i^2 \le \sqrt{n \sum x_i^2}")
    d = p.get("data") or {}
    eq_ok = r.record("⑳ docx equation（LaTeX → 原生 OMML）", cmd, p, [
        ("公式进了文档", (d.get("equations_in_doc") or 0) >= 1),
        ("公式里没有中文", d.get("cjk_in_formula") is False),
        ("校验 pass", (d.get("validate") or {}).get("status") == "pass"),
    ], readouts={"公式数": d.get("equations_in_doc")})

    # ── ㉑ 书签 + 内链 ──────────────────────────────────────────────────────
    p, _, cmd = r.run("docx", "bookmark", "--file", "out/layout-toc2.docx",
                      "--out", "out/layout-bm.docx", "--anchor", "核心结论", "--name", "BK_CORE")
    d = p.get("data") or {}
    bm = d.get("bookmark") or {}
    bm_ok = r.record("㉑ docx bookmark（内链跳转目标）", cmd, p, [
        ("书签写进去了", bm.get("name") == "BK_CORE"),
        ("校验 pass", (d.get("validate") or {}).get("status") == "pass"),
    ], readouts={"书签名": bm.get("name"), "包裹方式": bm.get("wrapped_run")})
    p, _, cmd = r.run("docx", "bookmarks", "--file", "out/layout-bm.docx")
    d = p.get("data") or {}
    bms = d.get("bookmarks") or []
    bm_ok &= r.record("㉑-2 docx bookmarks（配对检查）", cmd, p, [
        ("有书签", (d.get("count") or 0) >= 1),
        ("都成对闭合", all(b.get("closed") for b in bms)),
    ], readouts={"书签数": d.get("count")})

    # ── ㉒ pandoc md → docx ────────────────────────────────────────────────
    p, _, cmd = r.run("docx", "pandoc", "--from", "layout.md", "--out", "out/pandoc.docx")
    d = p.get("data") or {}
    pd_ok = r.record("㉒ docx pandoc（md → docx，第三方高保真路线）", cmd, p, [
        ("产出了 docx", (d.get("bytes") or 0) > 1000),
        ("路由写明 pandoc 版本", str((d.get("pandoc") or {}).get("version") or "")[:2] != ""),
    ], readouts={"字节": d.get("bytes"), "pandoc": d.get("pandoc")})
    p, _, cmd = r.run("docx", "validate", "--file", "out/pandoc.docx")
    d = p.get("data") or {}
    pd_ok &= r.record("㉒-2 pandoc 产物过我们的校验", cmd, p, [
        ("status 不是 fail", d.get("status") != "fail"),
    ], readouts={"status": d.get("status"), "parts": (d.get("info") or {}).get("parts")})

    # ── ㉓ pandoc docx → md ────────────────────────────────────────────────
    p, _, cmd = r.run("docx", "pandoc", "--to-md", "--file", "out/pandoc.docx",
                      "--out", "out/pandoc-back.md")
    d = p.get("data") or {}
    pd_ok &= r.record("㉓ docx pandoc --to-md（docx → Markdown）", cmd, p, [
        ("抽出了 Markdown", (d.get("chars") or 0) > 100),
        ("内容里有标题/表格痕迹", (d.get("tables") or 0) >= 1 or (d.get("lines") or 0) > 3),
    ], readouts={"字符": d.get("chars"), "行": d.get("lines"), "表格行": d.get("tables")})

    # ── ㉔ 修订：删除 + 按作者筛选接受 ──────────────────────────────────────
    p, _, cmd = r.run("docx", "track", "--file", "out/layout-bm.docx", "--out", "out/rev-del.docx",
                      "--text", "华东仓的拣货路径优化生效", "--mode", "delete", "--author", "审稿人")
    d = p.get("data") or {}
    rev = d.get("revisions") or {}
    revs = rev.get("revisions") or []
    rev_ok = r.record("㉔ docx track --mode delete（删除修订 w:del）", cmd, p, [
        ("写进去了", (d.get("id") or "") != ""),
        ("读回是 delete 类型", any(x.get("kind") == "delete" for x in revs)),
        ("作者对得上", any(x.get("author") == "审稿人" for x in revs)),
    ], readouts={"id": d.get("id"), "修订": [(x.get("kind"), x.get("author")) for x in revs]})
    p, _, cmd = r.run("docx", "accept", "--file", "out/rev-del.docx",
                      "--out", "out/rev-accepted.docx", "--author", "审稿人")
    d = p.get("data") or {}
    rev_ok &= r.record("㉔-2 docx accept --author（按作者筛选接受）", cmd, p, [
        ("处理了 1 条修订", len(d.get("kept") or []) + len(d.get("dropped") or []) == 1),
        ("没有剩余修订", (d.get("remaining") or 0) == 0),
        ("筛选条件写在回执里", (d.get("filter") or {}).get("authors") == ["审稿人"]),
    ], readouts={"kept": d.get("kept"), "remaining": d.get("remaining")})

    # ── ㉕ 批注批量计划（先预演，再真跑） ────────────────────────────────────
    p, _, cmd = r.run("docx", "comment", "--file", "out/report.docx", "--ops", "comment-plan.json",
                      "--dry-run")
    d = p.get("data") or {}
    plan = d.get("plan") or []
    ops_ok = r.record("㉕ docx comment --ops（批量计划，先 --dry-run 预演）", cmd, p, [
        ("预演里有 4 条操作", len(plan) == 4),
        ("预演全部通过", (d.get("fail_count") or 0) == 0),
        ("预演不落盘", d.get("dry_run") is True),
    ], readouts={"计划": [(x.get("op"), x.get("ok")) for x in plan]})
    p, _, cmd = r.run("docx", "comment", "--file", "out/report.docx", "--ops", "comment-plan.json",
                      "--out", "out/report-ops.docx")
    d = p.get("data") or {}
    ops_ok &= r.record("㉕-2 docx comment --ops（真跑：加/回复/解决/撤销）", cmd, p, [
        ("跑完 4 条都成", (d.get("ok_count") or 0) == 4),
        ("文档里有 2 条批注", (d.get("comments_in_doc") or 0) == 2),
        ("有 1 条回复", (d.get("replies") or 0) == 1),
        ("有 1 条已解决", (d.get("resolved_count") or 0) == 1),
        ("校验 pass", (d.get("validate") or {}).get("status") == "pass"),
    ], readouts={"批注": d.get("comments_in_doc"), "回复": d.get("replies"),
                 "已解决": d.get("resolved_count")})
    all_ok &= layout_ok and toc_ok and hf_ok and t3 and eq_ok and bm_ok and pd_ok and rev_ok and ops_ok

    # ── ㉖ PDF：三线表 + 代码高亮 + 公式 + 脚注 + 内链，一次建出来 ────────────
    p, _, cmd = r.run("pdf", "build", "--from", "rich.md", "--out", "out/rich.pdf",
                      "--title", "技术说明", "--author", "Irmia",
                      "--table-style", "three-line", "--qa-dir", "out/qa-rich", "--dpi", "110")
    d = p.get("data") or {}
    hl = d.get("code_highlight") or {}
    rr = d.get("render") or {}
    rich_ok = r.record("㉖ pdf 富文本（三线表 + 代码高亮 + 公式 + 脚注）", cmd, p, [
        ("建出来了", (d.get("pages") or 0) >= 1),
        ("三线表样式生效", d.get("table_style") == "three-line"),
        ("代码高亮着了色", (hl.get("highlighted") or 0) >= 1),
        ("公式用 mathtext 渲染", (d.get("equations") or 0) >= 1),
        ("脚注收进「注释」节", (d.get("notes") or 0) >= 1),
        ("字形预检 0 缺", (d.get("preflight") or {}).get("ok") is True),
        ("文本往返 0 缺字", (d.get("text_roundtrip") or {}).get("roundtrip_ok") is True),
        ("出图 page 数与页数一致", (rr.get("page_count") or 0) == (d.get("pages") or -1)),
    ], readouts={"页数": d.get("pages"), "高亮": hl, "公式": d.get("equations"),
                 "脚注": d.get("notes"), "contact sheet": rr.get("contact_sheet")},
        extra={"contact_sheet": rr.get("contact_sheet") or ""})

    # ── ㉗ HTML→PDF 本地链：CSS 分页 + colspan/rowspan ───────────────────────
    p, _, cmd = r.run("pdf", "from-html", "--from", "complex.html", "--out", "out/complex-local.pdf",
                      "--engine", "local", "--qa-dir", "out/qa-html-local", "--dpi", "100")
    d = p.get("data") or {}
    css = d.get("css") or {}
    rr = d.get("render") or {}
    html_ok = r.record("㉗ pdf from-html --engine local（CSS 分页 + 合并单元格）", cmd, p, [
        ("两块分页生效（>= 2 页）", (d.get("pages") or 0) >= 2),
        ("认出了 CSS 的 @page 与分页规则", (css.get("page_breaks") or 0) >= 1),
        ("没有空白页", (rr.get("blank_pages") or []) == []),
        ("字体全部嵌入", (d.get("font_audit") or {}).get("all_embedded") is True),
    ], readouts={"页数": d.get("pages"), "css": css, "contact sheet": rr.get("contact_sheet")},
        extra={"contact_sheet": rr.get("contact_sheet") or ""})

    # ── ㉘ HTML→PDF 浏览器路线（Chromium 打印） ───────────────────────────────
    p, _, cmd = r.run("pdf", "from-html", "--from", "complex.html", "--out", "out/complex-pw.pdf",
                      "--engine", "playwright", "--qa-dir", "out/qa-html-pw", "--dpi", "100")
    d = p.get("data") or {}
    rr = d.get("render") or {}
    html_ok &= r.record("㉘ pdf from-html --engine playwright（Chromium 打印）", cmd, p, [
        ("走的是浏览器", "playwright" in str(d.get("route") or "")),
        ("出页了", (d.get("pages") or 0) >= 1),
        ("没有空白页", (rr.get("blank_pages") or []) == []),
    ], readouts={"路由": d.get("route"), "页数": d.get("pages")})
    # auto 必须在浏览器不可用时落回本地链（这里两个都能用，断言 auto 也成功）
    p, _, cmd = r.run("pdf", "from-html", "--from", "complex.html", "--out", "out/complex-auto.pdf",
                      "--engine", "auto")
    d = p.get("data") or {}
    html_ok &= r.record("㉘-2 pdf from-html --engine auto（先浏览器，失败落本地）", cmd, p, [
        ("auto 成功", bool(p.get("ok"))),
        ("路由写明用了哪条", str(d.get("route") or "") != ""),
    ], readouts={"路由": d.get("route"), "degraded": len(p.get("degraded") or [])})
    all_ok &= rich_ok and html_ok

    # ── ㉙ PDF 表单：看字段 + 填值 ───────────────────────────────────────────
    p, _, cmd = r.run("pdf", "form", "--file", "out/form.pdf", "--info")
    d = p.get("data") or {}
    form_ok = r.record("㉙ pdf form --info（AcroForm 字段清单）", cmd, p, [
        ("认出字段", (d.get("field_count") or 0) >= 2),
        ("有 AcroForm", d.get("has_acroform") is True),
    ], readouts={"字段": [(f["name"], f["type"]) for f in (d.get("fields") or [])]})
    p, _, cmd = r.run("pdf", "form", "--file", "out/form.pdf", "--out", "out/form-filled.pdf",
                      "--set", "applicant=Irmia", "--set", "dept=数据组")
    d = p.get("data") or {}
    form_ok &= r.record("㉙-2 pdf form --set（填值并读回）", cmd, p, [
        ("全部写进去了", d.get("all_applied") is True),
        ("读回值对得上", (d.get("readback") or {}).get("applicant") == "Irmia"),
    ], readouts={"写回": d.get("readback")})
    all_ok &= form_ok

    # ── ㉚ PDF 加密 / 解密 ─────────────────────────────────────────────────
    p, _, cmd = r.run("pdf", "encrypt", "--file", "out/rich.pdf", "--out", "out/rich-enc.pdf",
                      "--password", "s3cret")
    d = p.get("data") or {}
    enc_ok = r.record("㉚ pdf encrypt（AES-256，带密码验证）", cmd, p, [
        ("加密后不带密码打不开", d.get("requires_password") is True),
        ("带密码能打开", d.get("opens_with_password") is True),
        ("算法是 aes256/R=6", d.get("algorithm") == "aes256" and d.get("revision") == 6),
    ], readouts={"字节": d.get("bytes"), "R": d.get("revision")})
    p, _, cmd = r.run("pdf", "decrypt", "--file", "out/rich-enc.pdf", "--out", "out/rich-dec.pdf",
                      "--password", "s3cret")
    d = p.get("data") or {}
    enc_ok &= r.record("㉚-2 pdf decrypt（解密回明文）", cmd, p, [
        ("解密成功", d.get("decrypted") is True),
        ("页数对得上", (d.get("pages") or 0) >= 1),
    ], readouts={"页数": d.get("pages")})
    p, _, cmd = r.run("pdf", "decrypt", "--file", "out/rich-enc.pdf", "--out", "out/rich-bad.pdf",
                      "--password", "wrong")
    bad_code = ((p.get("error") or {}).get("code"))
    enc_ok &= r.record("㉚-3 pdf decrypt 用错密码要给清楚的错", cmd, p, [
        ("错误码是 PasswordWrong", bad_code == "PasswordWrong"),
        ("给了下一步", len(((p.get("error") or {}).get("next")) or []) >= 1),
    ], readouts={"code": bad_code}, expect_fail=True)
    all_ok &= enc_ok

    # ── ㉛ 大文件分批（260 页 → 3 批） ──────────────────────────────────────
    p, _, cmd = r.run("pdf", "render", "--file", "out/big.pdf", "--out", "out/qa-big",
                      "--dpi", "40", "--batch", "100")
    d = p.get("data") or {}
    sheets = d.get("contact_sheets") or []
    batch_ok = r.record("㉛ pdf render --batch（260 页分 3 批出图）", cmd, p, [
        ("260 页全出了", (d.get("page_count") or 0) == 260),
        ("标记为分批", d.get("chunked") is True),
        ("出了 3 张 contact sheet", len(sheets) == 3),
        ("每张都真的存在", all((work / s["path"]).exists() for s in sheets)),
    ], readouts={"页数": d.get("page_count"), "批数": len(sheets),
                 "sheets": [s["path"] for s in sheets]})

    # ── ㉜ 抽图引擎（MuPDF：JBIG2/JPX 扫描件靠它） ────────────────────────────
    p, _, cmd = r.run("pdf", "image", "--file", "out/rich.pdf", "--out", "out/imgs-rich")
    d = p.get("data") or {}
    eng_ok = r.record("㉜ pdf image（MuPDF 引擎 + contact sheet）", cmd, p, [
        ("引擎是 MuPDF", d.get("engine") == "pymupdf"),
        ("抽到了图", (d.get("image_count") or 0) >= 1),
        ("contact sheet 在", bool(d.get("contact_sheet"))),
    ], readouts={"引擎": d.get("engine"), "张数": d.get("image_count")})
    all_ok &= batch_ok and eng_ok

    # ── ㉟ PDF 双栏排版 ─────────────────────────────────────────────────────
    p, _, cmd = r.run("pdf", "build", "--from", "layout.md", "--out", "out/two-col.pdf",
                      "--columns", "2", "--qa-dir", "out/qa-2col", "--dpi", "100")
    d = p.get("data") or {}
    rr = d.get("render") or {}
    col_ok = r.record("㉟ pdf build --columns 2（双栏排版）", cmd, p, [
        ("分栏数写进回执", d.get("columns") == 2),
        ("建出来了", (d.get("pages") or 0) >= 1),
        ("没有空白页", (rr.get("blank_pages") or []) == []),
        ("字体全部嵌入", (d.get("font_audit") or {}).get("all_embedded") is True),
    ], readouts={"页数": d.get("pages"), "分栏": d.get("columns"),
                 "contact sheet": rr.get("contact_sheet")},
        extra={"contact_sheet": rr.get("contact_sheet") or ""})
    all_ok &= col_ok

    # ── ㉝ 版式稿出图（人眼看封面/目录/双栏/三线表/公式） ─────────────────────
    p, _, cmd = r.run("docx", "render", "--file", "out/layout-toc2.docx", "--out", "out/qa-layout",
                      "--dpi", "110")
    d = p.get("data") or {}
    sheet_lay = d.get("contact_sheet") or ""
    all_ok &= r.record("㉝ docx 出图（封面 / 目录 / 三线表 / 公式 / 双栏）", cmd, p, [
        ("出了 >= 2 页", (d.get("page_count") or 0) >= 2),
        ("没有空白页", d.get("blank_pages") == []),
        ("contact sheet 存在", bool(sheet_lay) and (work / sheet_lay).exists()),
    ], readouts={"页数": d.get("page_count"), "墨迹率": d.get("mean_ink_ratio"),
                 "缺字体": d.get("missing_fonts"), "contact sheet": sheet_lay},
        extra={"contact_sheet": sheet_lay})

    # ── ㉞ doctor：依赖表（装没装/体积/装它的命令/不装时的降级） ────────────────
    p, _, cmd = r.run("doctor")
    d = p.get("data") or {}
    deps = d.get("deps") or []
    comp = d.get("component") or {}
    doc_ok = r.record("㉞ doctor 依赖表（每项的装法 + 降级 + 组件体积）", cmd, p, [
        ("依赖条目 >= 15", len(deps) >= 15),
        ("每条都有 install 命令", all(x.get("install") for x in deps)),
        ("每条都有 fallback 说明", all(x.get("fallback") for x in deps)),
        ("有体积统计", (comp.get("installed_run_size_mb") or 0) > 0),
        ("组分了 core / feature", (comp.get("core_mb") or 0) > 0 and (comp.get("feature_mb") or 0) > 0),
        ("注明不勾组件就什么都不装", bool((comp.get("if_not_selected") or {}).get("assertion"))),
        ("能力矩阵 >= 25 项开", (p.get("summary", {}).get("capabilities_on") or 0) >= 25),
    ], readouts={"依赖": len(deps), "缺": (p.get("summary") or {}).get("deps_missing"),
                 "体积MB": comp.get("installed_run_size_mb"),
                 "core/feature": (comp.get("core_mb"), comp.get("feature_mb")),
                 "能力开": (p.get("summary") or {}).get("capabilities_on"),
                 "能力关": (p.get("summary") or {}).get("capabilities_off")})
    all_ok &= doc_ok

    # ── ⑬ 技能目录零 __pycache__ ────────────────────────────────────────────
    stray = sorted(str(p.relative_to(SKILL_DIR)) for p in SKILL_DIR.rglob("__pycache__"))
    pyc = sorted(str(p.name) for p in SKILL_DIR.rglob("*.pyc"))
    files = sorted(p.name for p in (SKILL_DIR / "scripts").glob("*.py"))
    all_ok &= r.record("⑬ 技能目录零 __pycache__ / 零 .pyc", "python test/office-skill-smoke.py",
                       {"ok": not stray and not pyc},
                       [("没有 __pycache__", not stray), ("没有 .pyc", not pyc),
                        ("脚本数 >= 11", len(files) >= 11)],
                       readouts={"脚本": len(files), "scripts/": ", ".join(files)})

    summary = {
        "workdir": str(work),
        "office_py": str(OFFICE),
        "passed": all_ok,
        "steps": r.results,
    }
    sp = out / "smoke-summary.json"
    sp.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    total = len(r.results)
    passed = sum(1 for item in r.results if item["ok"])
    print(f"\n{'=' * 68}")
    print(f"结论：{'全部 PASS' if all_ok else '有 FAIL'}  {passed}/{total} 步  → 回执汇总 {sp}")
    for item in r.results:
        print(f"  {'PASS' if item['ok'] else 'FAIL'}  {item['step']}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
