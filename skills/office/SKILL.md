---
name: office
description: 生成、编辑、校验、预览 Word(docx)、Excel(xlsx)、PDF 文档时用这个技能：Markdown/HTML 转 docx/pdf（封面·页眉页脚页码·目录·分栏·三线表·脚注·公式·代码高亮·插图）、给 docx 加批注并回复/标记已解决、批量批注计划、加修订并能接受或拒绝（可按作者/ID 筛）、校验 OOXML 结构与元素顺序、书签与内链、md↔docx 走 pandoc、建表写公式加原生图表与条件格式并重算、pdf 抽文本/表格/图片、表单填写、AES 加密解密、拆页合并转图、大文件分批、中文渲染出 PNG 做肉眼检查（防止中文变方块/tofu）。统一入口 python skills/office/scripts/office.py，每条动作都给 --json 回执。
---

# Office 套件（Word / Excel / PDF / 图表）

一个入口、四类活儿、每个动作一条命令、每条命令都给机器可读回执。

```
python skills/office/scripts/office.py <组> <动作> [参数] [--json]
```

技能目录（`skills/office/`）是**只读**的：脚本、字体、产物都不要往这里写。所有产物写到
**当前工作目录**（她跑命令时所在的 workspace），用相对路径。

---

## 0. 三条铁律

1. **先 `doctor`**。第一次在这台机器上跑，先看依赖齐不齐：
   ```powershell
   python skills/office/scripts/office.py doctor
   ```
   它会列出：哪些 Python 包在、中文字体是哪个文件、LibreOffice 走哪条路、缺什么、**以及可以直接粘的安装命令**。
   `ready: true` 才继续；缺什么按 `data.install.*` 里给的命令装。
2. **产物落在当前工作目录**，`--out` 用相对路径（`--out out/报告.docx`）。写到技能目录会直接报
   `SkillDirReadOnly`；写到工作目录外面会报 `OutsideWorkspace`（确实要写出去就加 `--allow-outside-cwd`）。
3. **覆盖已有文件前自动备份**成 `<文件名>.bak-<时间戳>`，回执里 `backup` 字段会写出来。原地改（`docx comment` /
   `docx track` / `xlsx set` 不给 `--out` 时）也会先备份。例外：渲染出来的 `page-*.png` 与 `contact-sheet.png`
   是可再生中间件，不备份（否则出一次图留一堆 `.bak-` 图片）。

### 缺依赖时怎么办

1. 先跑 `doctor`；缺什么它会连**可直接粘的安装命令**一起给出。
2. **把缺什么 + 那条命令原样说给用户**，等他同意，别默默降级、也别假装能做。
3. **装之前先问用户**——尤其单次要下 **>50 MB** 的（pandoc 约 210 MB、playwright+Chromium 约 235 MB），**不要自己联网装**。
4. 用户说"先不装"，就走降级路径（`degraded` 里的 `fallback` / `error.next` 写着替代做法），并在**回执里说清"这次是降级做的"**。

---

## 1. 动作总表

### Word（docx）

| 要干的事 | 命令 | 产物 |
|---|---|---|
| Markdown 建 Word | `docx build --from a.md --out out/a.docx [--title 标题] [--subtitle 副标题]` | docx + 内嵌校验读数 |
| **正式文档套件** | `docx build --from a.md --out a.docx --cover --page-numbers --header "标题 · 第 {page} 页" --footer "第 {page} 页 / 共 {pages} 页" --table-style three-line --toc` | 封面 + 页眉页脚（真 PAGE/NUMPAGES 域）+ 三线表 + 目录（带实测页码） |
| 分节 / 分栏 | Markdown 里写 `<!-- sectionbreak -->` / `<!-- columns: 2 -->`；或 `docx section --file a.docx --columns 2 [--index 1]` | docx（真 `w:sectPr` / `w:cols`） |
| 页眉页脚（事后加） | `docx header-footer --file a.docx --page-numbers --footer "机密 · 第 {page} 页" [--out b.docx]` | docx（重跑=重写，不叠加） |
| 读回页眉页脚 | `docx read-hf --file a.docx` | 每节的页眉/页脚文字与域清单 |
| **目录** | `docx toc --file a.docx [--levels 1-3] [--after "某段"] [--no-pages] [--out b.docx]` | docx（TOC 域 + 标题书签 + PAGEREF 页码缓存；页码先用 PDF 实测再写进缓存，写完自检） |
| 三线表 | `docx table-style --file a.docx --style three-line [--out b.docx]` | docx（顶线/表头线/底线，去掉竖线与内部横线） |
| **脚注** | `docx footnote --file a.docx --anchor "一段话" --text "脚注内容" [--out b.docx]`；Markdown 里写 `[^id]` + 文末 `[^id]: 内容` | docx（`word/footnotes.xml` + `w:footnoteReference`，重跑幂等） |
| 读回脚注 | `docx footnotes --file a.docx` | 脚注列表 + 正文引用数 + separator 是否齐 |
| **公式（原生 OMML）** | `docx equation --file a.docx --latex "\frac{a}{b}" [--after "某段"] [--inline] [--out b.docx]`；Markdown 里写 `$$ … $$` | docx（`m:oMath`，Word 里可编辑；公式里别放中文） |
| **书签 / 内链** | `docx bookmark --file a.docx --anchor "一段话" [--name BK1]`；正文写 `[文字](#BK1)`；标题尾部写 `{#锚点}` | docx（`w:bookmarkStart/End` + `w:hyperlink w:anchor`） |
| 列书签 | `docx bookmarks --file a.docx` | 书签与配对情况 |
| **pandoc 路线** | `docx pandoc --from a.md --out a.docx [--reference-doc ref.docx] [--toc]`；反向 `docx pandoc --to-md --file a.docx --out a.md [--extract-media]` | 第三方高保真转换（复杂脚注/引用/表格用它） |
| 校验包结构 | `docx validate --file a.docx` | `status: pass / pass_with_warnings / fail` + errors/warnings + `info.deep`（跑了哪些深检查） |
| 看内容（给模型读） | `docx view --file a.docx [--out view.txt]` | 带块序号的文本预览（样式名、表格尺寸） |
| 拆包改 XML | `docx prep --file a.docx --out work/` | `work/unpacked/**` + `view.txt` + `manifest.json` |
| 改完打包回去 | `docx pack --from work/unpacked --out out/b.docx` | docx（打完立刻过一遍校验） |
| 比一比改了什么 | `docx diff --before a.docx --after out/b.docx` | 部件级增删改 + 正文文字差异 |
| 取 XML 片段 | `docx xml --file a.docx --part word/document.xml [--xpath "//w:p[3]"] [--pretty]` | XML 文本 |
| 加批注 | `docx comment --file a.docx --anchor "正文里的一段话" --text "批注" [--author 名] [--out b.docx]` | docx（写回后**会读回验证锚点**） |
| 回复批注 | `docx comment --file b.docx --reply-to 0 --text "回复" [--author 名] [--out c.docx]` | docx（`w15:commentEx` 的 `paraIdParent` 链） |
| 标记批注已解决 | `docx resolve --file c.docx --id 0 [--undo] [--out d.docx]` | docx（`w15:done`，读回确认） |
| **批量批注计划** | `docx comment --file a.docx --ops plan.json [--dry-run] [--out b.docx]` | 一次跑 add/reply/resolve/unresolve；`--dry-run` 只预演 |
| 读批注 | `docx comments --file d.docx` | 批注列表 + 每条覆盖的原文 + **是否已解决 / 回复给了谁** |
| 插一条修订 | `docx track --file b.docx --text "新增文字" --after "锚点文字" [--author 名] [--out c.docx] [--new-paragraph]` | docx（真 `w:ins` 修订） |
| **标一段为删除** | `docx track --file b.docx --text "要删的原话" --mode delete [--author 名] [--out c.docx]` | docx（`w:del` + `w:delText`，跨样式时按 XML 层切 run） |
| 列修订 | `docx revisions --file c.docx` | 修订列表（ins / delete，含作者与时间） |
| **接受/拒绝（可按作者/ID 筛）** | `docx accept --file c.docx [--author 王工] [--id 3] [--out d.docx]` / `docx reject ...` | 处理后的 docx + kept/dropped/remaining + 筛选条件 |
| **插图** | `docx image --file a.docx --image 图.png [--after "锚点段落"] [--width-cm 14] [--caption "图 1 …"] [--out b.docx]` | docx（图 + 图注 + alt 文本；同 caption 重跑=替换） |
| 出图看效果 | `docx render --file a.docx --out qa/ [--dpi 144] [--pages 1,2] [--cols 2]` | `qa/page-*.png` + `qa/contact-sheet.png` |

Markdown 里写 `![图 1：说明](out/chart.png)` 这一行，`docx build` / `pdf build` 都会把它排成图 + 图注。
`{#锚点}` 写在标题尾部，`docx build` 会把它变成书签（标题文字里不会留下这段）。

`--anchor` 怎么给：**短、连续、原样**。页面上看着连着、但里面被加粗/代码样式切断的地方，锚点会找不到——
先 `docx view` 看清真实文字再挑。

`docx validate` 的深检查（不跑 XSD，但把"改坏了 Word 会弹修复"的那几类查掉）：`pPr/rPr/tcPr/tblPr` 的
schema 顺序、`w:p` 里 `pPr` 必须在最前、`w:sectPr` 必须在最后、批注扩展链 `paraId` 自洽、书签起止配对、
`w:zoom` 缺 `percent`、`w:t` 首尾空格缺 `xml:space`、有 `w:drawing` 就必须有 `word/media/*`。

### Excel（xlsx）

| 要干的事 | 命令 | 产物 |
|---|---|---|
| 按规格建表 | `xlsx build --from 表.json --out out/表.xlsx` | xlsx + 建完立刻体检的读数（含图表/条件格式条数） |
| **加原生图表** | `xlsx chart --file a.xlsx --type bar --data "汇总!B1:B4" --categories "汇总!A2:A4" --title 销量 [--anchor G2] [--out b.xlsx]` | xlsx（真 OOXML 图表对象，不是贴图） |
| 写一个值/公式 | `xlsx set --file a.xlsx --cell "汇总!B3" --value 200 [--formula] [--out b.xlsx]` | xlsx（有备份） |
| 静态体检 | `xlsx verify --file a.xlsx` | `pass / pass_with_warnings / unverified / fail` + 图表 series / 条件格式条数 |
| 重算 | `xlsx recalc --file a.xlsx [--out b.xlsx] [--route libreoffice\|formulas]` | 算过的 xlsx + **到底用哪条路** |
| 读回值 | `xlsx read --file a.xlsx [--sheet 汇总] [--range A1:E5]` | 每格 `value` / `formula` / `cached` / `fmt` |
| 出图 | `xlsx render --file a.xlsx --out qa/ [--dpi 130]` | `qa/page-*.png` + `qa/contact-sheet.png` |

`build` 的规格文件长这样（`rows` 从 A1 开始，其余字段都可省）：

```json
{
  "calc_on_load": true,
  "sheets": [
    {
      "name": "汇总",
      "cols": { "A": 18, "B": 12 },
      "rows": [["产品", "销量", "单价", "金额"], ["产品甲", 120, 150.5, null]],
      "formulas": { "D2": "=B2*C2", "D3": "=SUM(D2:D2)" },
      "styles": { "A1:D1": { "bold": true, "fill": "EDF1F6", "align": "center" },
                  "D2:D3": { "number_format": "#,##0.00" } },
      "merges": ["A4:D4"],
      "freeze": "A2",
      "charts": [
        { "type": "bar", "title": "销量对比", "data": "B1:B4", "categories": "A2:A4", "anchor": "F2" },
        { "type": "pie", "title": "销量结构", "data": "B1:B4", "categories": "A2:A4", "anchor": "F20" }
      ],
      "conditional": [
        { "range": "B2:B4", "rule": "dataBar", "color": "638EC6" },
        { "range": "C2:C4", "rule": "colorScale" },
        { "range": "A2:A4", "rule": "iconSet", "icons": "3Arrows" }
      ]
    }
  ]
}
```

图表类型：`bar`（竖柱）/ `barh`（横柱）/ `line` / `pie` / `doughnut` / `area`；`grouping` 可给 `stacked`。
**饼图/环图必须给 `categories`**，否则切片没标签——这不是"看着能开"就算对。

**重算的三条路，回执里会如实写**：

| route | 交付的 xlsx 里有缓存值吗 | 说明 |
|---|---|---|
| `libreoffice` | **有** | 走随 DSH 打包的 LibreOffice，公式保留、缓存写回，`delivery_file_recalculated: true` |
| `formulas` | **没有** | 只在回执 `computed` 里给数值；交付件缓存仍空，`delivery_file_recalculated: false` |
| `calc_mode_auto` | 没有 | `status: deferred`，只是让 Excel 打开时自己算，**等于没算** |

只要 `delivery_file_recalculated` 不是 `true`，就必须在交付时说明"对方用不支持公式的阅读器会看到空白/0"。

### 图表（chart，自己画 PNG）

| 要干的事 | 命令 | 产物 |
|---|---|---|
| 画一张图 | `chart build --from spec.json --out out/chart.png [--qa-dir out/qa-chart]` | PNG + `contact-sheet.png` + 字形预检读数 |
| 要一份样例 | `chart example --out chart.json` | 可直接改的规格 JSON |

规格（`type` 支持 `bar` / `barh` / `line` / `pie`）：

```json
{ "type": "bar", "title": "季度订单量对比", "subtitle": "单位：万单",
  "categories": ["华东", "华南", "华北"],
  "series": [{ "name": "Q3", "values": [182.5, 96.3, 88.0] },
             { "name": "Q4", "values": [201.4, 104.8, 92.6] }],
  "y_label": "万单", "show_values": true, "width": 960, "height": 560 }
```

**不引 matplotlib 画图**：`chart build` 用 Pillow 自己画，画之前先用 cmap 预检每个字，缺字直接
`GlyphMissing` 失败（matplotlib 画中文缺字形时是静默画方块）。matplotlib 只在**渲染 PDF 里的公式**时用
（mathtext，自带数学字形）。画完给 PNG + contact sheet，人眼可查。

### PDF

| 要干的事 | 命令 | 产物 |
|---|---|---|
| Markdown 出中文 PDF | `pdf build --from a.md --out out/a.pdf [--title 标题] [--author 名] [--font 字体] [--qa-dir qa/]` | pdf + 字体审计 + 文本往返 +（给 `--qa-dir` 时）PNG 与 contact sheet |
| **三线表 / 代码高亮 / 公式 / 脚注** | `pdf build --from a.md --out a.pdf --table-style three-line`（默认就开代码高亮；`--no-highlight` 关） | 顶线+表头线+底线的三线表；Pygments 着色；公式走 mathtext 出图；脚注收进文末「注释」节 |
| **双栏排版** | `pdf build --from a.md --out a.pdf --columns 2` | 两栏流式排版（表格按栏宽排，别再塞宽表） |
| **HTML 出 PDF** | `pdf from-html --from a.html --out a.pdf [--engine auto\|local\|playwright] [--qa-dir qa/]` | `auto` 先试 Chromium 打印（CSS 分页/@page 全保真），起不来落本地链（lxml → 块模型 → ReportLab） |
| 体检 | `pdf inspect --file a.pdf` | 页数/页面尺寸/元信息/**每个字体是否嵌入**/每页字数/是否加密 |
| 抽文本 | `pdf text --file a.pdf [--pages 1-2] [--out t.txt]` | 文本（按页分隔）+ 字数统计 |
| 抽表格 | `pdf table --file a.pdf [--pages 1] [--out t.md\|t.json]` | 表格结构化数据 + Markdown 版 |
| **抽图片** | `pdf image --file a.pdf --out out/imgs/ [--pages 1-2] [--batch 200]` | `img-p001-01.png` 等 + `contact-sheet.png` + 摆放位置（MuPDF 引擎，JBIG2/JPX 扫描件也能解） |
| **表单：看字段** | `pdf form --file a.pdf --info` | 字段名/类型/当前值/是否必填只读 |
| **表单：填值** | `pdf form --file a.pdf --out b.pdf --set name=张三 [--set dept=数据组]` | 填好的 pdf（读回校验，字段名不认识就报 `FieldNotFound`） |
| **加密** | `pdf encrypt --file a.pdf --out b.pdf --password s3cret [--algorithm aes256\|aes128]` | 加密 pdf（立刻验证"不带密码打不开/带密码能开"） |
| **解密** | `pdf decrypt --file b.pdf --out c.pdf --password s3cret` | 明文 pdf（密码错报 `PasswordWrong`） |
| 拆页 | `pdf split --file a.pdf --out out/split/ [--chunk 2]` | 每页（或每 N 页）一个 pdf |
| 合并 | `pdf merge --files a.pdf b.pdf --out out/merged.pdf` | 合并后的 pdf |
| 旋转/删页/取页/裁切 | `pdf pages --file a.pdf --out b.pdf [--rotate 90] [--keep 1-3,5] [--drop 2] [--crop 0,0,595,421]` | 处理后的 pdf |
| 元信息读写 | `pdf meta --file a.pdf [--set title=… --set author=…] [--out b.pdf]` | 读 or 写完的 pdf |
| **出图（大文件分批）** | `pdf render --file a.pdf --out qa/ [--dpi 120] [--pages 1] [--cols 3] [--batch 200]` | `qa/page-*.png` + `contact-sheet.png`；超过 `--batch` 页自动分批，每批一张图 |
| docx/xlsx → pdf | `pdf from-docx --file a.docx --out out/a.pdf` | pdf + 字体嵌入审计 |

`pdf image` 导的是**内嵌位图**；矢量画的图（曲线图表）不会变成 PNG——那种情况用 `pdf render` 截整页。

---

## 2. 回执怎么读（`--json` 的信封）

成功：

```json
{ "ok": true, "action": "docx.build",
  "artifacts": [{"path": "out/a.docx", "kind": "docx", "bytes": 38487}],
  "data": { "...动作自己的读数..." },
  "warnings": ["..."], "degraded": [{"capability":"…","reason":"…","fallback":"…"}],
  "notes": ["..."], "next": ["下一步可以跑什么"] }
```

失败：

```json
{ "ok": false, "action": "docx.comment",
  "error": { "code": "AnchorNotFound", "message": "…", "next": ["…怎么做"], "detail": {...} } }
```

- 先看 `ok`；`ok:false` 时**照 `error.next` 做**，不要瞎换参数重试。
- `warnings` 是"能交付但要知道"（例如"有字体没嵌入，换机器可能变样"）。
- `degraded` 是"这个能力降级了"，`fallback` 写着替代做法。
- 退出码：`0` 成功、`1` 失败、`2` 用法错误。`doctor` 在依赖不齐时也退 `1`。

---

## 3. 中文正确性：三层检查 + 人眼看图

中文出问题有两种，肉眼都看得出来，但自动指标**看不出来**（墨迹率、包围盒认不出字形缺失）。所以我们做三层：

1. **画之前的字形预检**：直接读字体文件的 `cmap`，确认每个字都有字形。缺字就**直接失败**并列出是哪些字
   （错误码 `GlyphMissing`）——绝不产出方块。`pdf build` / `pdf from-html` / `chart build` 都过这一关。
2. **画之后的字体审计**：`pdf inspect` / `build` 的回执里看 `all_fonts_embedded` 与 `non_embedded`。
   没嵌入的字体在本机能看、换机器可能变样，属于"要披露"的项。
3. **文本往返**：`build` 会把写进去的字从 PDF 里抽回来逐字对一遍（`text_roundtrip.missing_chars` 应为空），
   抓"字被悄悄丢掉"。
4. **最后一步永远是人眼**：`docx render` / `pdf render` / `xlsx render` 出一页一张 PNG，再拼一张
   `contact-sheet.png`；`chart build` 也顺手拼一张。**中文是不是方块，只有看图能定论。** 交活前至少看一眼。

`pdf render` 的 `glyph_box_hint` 是"空心方框"启发式线索，只当参考：中文的 `口/日/回/目` 本身就会被命中。

---

## 4. 依赖

装依赖（装进**当前这个 python**，不进仓库、不写 requirements.txt）。这套东西在安装器里是
**Office 组件（默认勾选）**，一次性装好：

```powershell
python -m pip install python-docx openpyxl reportlab Pillow lxml pdfplumber pikepdf pypdfium2
python -m pip install matplotlib pymupdf pypdf cryptography pygments formulas
python -m pip install playwright && python -m playwright install chromium
winget install --id JohnMacFarlane.Pandoc -e
# 可选：不装 LibreOffice 就没有 docx/xlsx→PDF、无损重算、目录页码实测
winget install --id TheDocumentFoundation.LibreOffice -e
```

每一条**装了什么 / 多少 MB / 不装会失去什么**，`doctor --json` 的 `data.deps` 逐条写着
（`installed / version / size_mb / install / fallback`），`data.component` 给整组件体积：

| 组 | 包含 | 实测体积 |
|---|---|---|
| core（必需） | python-docx / openpyxl / reportlab / Pillow / lxml | **36.9 MB** |
| feature（能力件） | pdfplumber / pikepdf / pypdfium2 / formulas / matplotlib / pymupdf / pypdf / cryptography / pygments / playwright | **445.6 MB** |
| external | pandoc（系统装）、Chromium（playwright 下载，约 130 MB） | 210 MB + 130 MB |
| 可选 | LibreOffice（docx/xlsx→PDF、无损重算、目录页码实测） | 约 400 MB |

- `pymupdf` 是 **AGPL-3.0**：自己用没问题，**商业分发要法务过一眼**。不接受就卸掉它，
  抽图会退到 pikepdf（普通编码的图照样能抽，只丢 JBIG2/JPX 扫描件）。
- `playwright` 装完还要 `playwright install chromium`（包在 ≠ 浏览器在）；浏览器不在时
  `pdf from-html` 自动降级到本地链并在 `degraded` 里说明。
- **LibreOffice 不是 pip 包**：优先用**随 DSH 打包的**那份（`office.py` 自己找 `libreoffice-kit` 的
  `cli.js` + 一个 node）；没有就 `winget` 装。`doctor` 的 `data.routes` 会明说每条路通不通。
- 中文字体：默认自动找 `C:\Windows\Fonts\msyh.ttc`（微软雅黑），其次 `simhei.ttf`/`simsun.ttc` 等。
  要指定就 `--font <路径>`，或者设环境变量 `OFFICE_FONT_REGULAR` / `OFFICE_FONT_BOLD`。
- pandoc：先看你机器上有没有（`where pandoc`）。有就白嫖；没有就 `winget` 装，或者
  `python -m pip install pypandoc_binary`（自带 221 MB 二进制）。

**不勾 Office 组件就什么都不装**：仓库里没有 `requirements.txt`、没有内置 wheel、没有 node_modules；
那时候任何 `office.py` 动作都会返回 `ok:false` + `error.code=DependencyMissing` + 带当前解释器绝对路径的
安装命令，并且**不写任何产物**。验证方法：`python -m pip list | Select-String python-docx,openpyxl,matplotlib`。

---

## 5. 能力边界（做不到的会明说，不假装）

| 能力 | 状态 | 原因 / 替代 |
|---|---|---|
| docx 的 OOXML **全量 XSD 校验** | 降级 | 不跑 39 个 XSD（那些 Schema 的许可不允许我们再分发，也不闭源再打包）。改成**结构性深检查**：顺序/首位元素/sectPr 位置/批注扩展链/书签/插图与 media/`w:zoom`/`xml:space`；要"Word 完全不挑"就用 Word/WPS 打开一次 |
| 别人的坏包**自动修复** | 降级 | 我们只修**自己产出**的（`build` 会把 `w:zoom` 的 `w:percent` 补齐，回执 `repairs` 写着）。别人包里的毛病只报不修——不"猜着改"交出去的文档；要修就 `docx prep` 改 XML 再 `pack` |
| docx **表格合并修订**（`vMerge`+`tblGridChange` 的 track） | **不支持** | 改动面太大（要重排 `tblGrid` 与每个 `tcPr`）；日常的"插入/删除 + 按作者接受"已经能用 |
| PDF 里的**目录（ReportLab TOC）** | **不支持** | docx 那条路的目录是整套做的（域+书签+实测页码）；PDF 这边没排上。要目录请先生成 docx 再 `pdf from-docx` |
| docx 渲染保真度 | 降级 | 走 LibreOffice 排版，分页与 Word 可能差一两行；`missing_fonts` 会列被顶替的字体 |
| `docx/xlsx render` 的 `--engine kit` | 降级（已知缺陷） | 实测随包的 `libreoffice-kit render` 把内容放大 4/3 并裁掉右侧（同一文件转 PDF 是正常的），那张图只能当参考 |
| **HTML → PDF 的本地链** | 降级 | `--engine local` 只认 CSS 子集（`@page` 的 size/margin、`page-break-before/after: always`、`colspan/rowspan`）；**要保真就用默认 `auto`（Chromium 打印）**，CSS 分页/@page/浮动全交给浏览器 |
| **公式里的中文** | 降级 | docx 的 OMML 我们给 Word 写了 eastAsia 字体（Word 认）；但 LibreOffice/WPS 的公式引擎只认数学字体 → 中文可能成方块。PDF 那边 mathtext 没有汉字字形 → 含中文的公式退化成文本近似排版。**建议：中文写在公式外面** |
| KaTeX 公式 / Mermaid 图 | **不做** | 都要 node 渲染链（KaTeX 要 JS 运行时、Mermaid 要浏览器），体积与不确定性都不值；用 mathtext（公式）或事先备好的 PNG 顶 |
| LaTeX 路线 | **不支持** | 不引入 `tectonic`；公式多、排版要求高的文档请换工具 |
| 扫描件 OCR | **不支持** | 没有文字层的 PDF 抽不出字（`pdf text` 会明说 0 字） |
| PDF 里**矢量图**当图片导出 | 降级 | `pdf image` 只导内嵌位图（MuPDF 能解 JBIG2/JPX/CCITT）；曲线画的图请用 `pdf render` 截整页 |
| xlsx 透视表 | 降级 | openpyxl 建不了透视表：用 `SUMIFS/COUNTIFS` 的公式汇总顶 |
| xlsx 图表种类 | 覆盖常用 | 柱/横柱/线/饼/环/面积；**散点、雷达、组合图没做**（散点要单独给 x 值，DSL 说不清） |
| 富文件往返（带图表的旧 xlsx 加图表） | 降级 | openpyxl 读写整本工作簿，遇到它不认的扩展块（x14）会丢。`xlsx chart` 会**实测条件格式条数前后变化**并在 `degraded` 里说；要保险就用 `xlsx build` 一次写进 charts |
| `formulas` 重算写回交付件 | 降级 | 只算数值放在回执里；交付件缓存仍空（已实测确认） |
| 双栏排版 + 宽表 | 降级 | `--columns 2` 时表格按**栏宽**排，四列以上的宽表会挤成两行表头；宽表文档别开双栏 |
| 文档渲染交给第三方网页（Kimi 的 doc-k 那类） | **不做** | 文档字节不出本机 |

---

## 6. 常见失败与下一步

| 错误码 | 含义 | 下一步 |
|---|---|---|
| `InputNotFound` | 输入文件不存在 | 核对路径/大小写；用相对当前工作目录的路径 |
| `SkillDirReadOnly` | 想往技能目录写 | `--out` 改成 workspace 里的相对路径 |
| `OutsideWorkspace` | 产物在工作目录外 | 改相对路径；确实要写外面加 `--allow-outside-cwd` |
| `GlyphMissing` | 字体里没这些字的字形 | 换 `--font C:\Windows\Fonts\msyh.ttc`，或把这些字换掉（`chart build` 也可用 `OFFICE_FONT_REGULAR` 换字体） |
| `NoCJKFont` | 找不到中文字体 | 装微软雅黑/黑体，或 `--font` 指定；不要绕过它去画方块 |
| `AnchorNotFound` | docx 里找不到锚点文字 | 先 `docx view`，挑短而连续的一段 |
| `CommentRangeMissing` | 批注没挂上范围 | 锚点换成只落在一个 run 里的文字（别跨加粗/代码片段） |
| `CommentNotFound` | 要回复/标记的批注 id 不存在 | `docx comments --file a.docx` 看现有 id |
| `ReplyChainBroken` | 回复没挂上父批注 | 把回执 + 那份 docx 报给用户；临时替代是把话补进原批注正文 |
| `ResolveStateMismatch` | 标记已解决/撤销没生效 | 同上：commentsExtended 可能被别的工具覆盖了 |
| `ImageNotFound` | 插图找不到图片 | 图要先产出来（`chart build` 会打印路径），Markdown 里写相对工作目录的路径 |
| `BadImage` | 图片读不出尺寸/后缀不对 | 用 PNG/JPEG，别用 SVG/WebP 之外的花样 |
| `BadSpec` | xlsx 图表规格/区域写错 | 看 `error.next` 里的例子；饼图必须给 categories |
| `BadHtml` | HTML 解析失败 | 确认是 UTF-8 的 HTML；片段也行，空文件不行 |
| `EmptySource` | 源文件里没内容 | 确认 `--from` 不是空文件、HTML 不是纯 JS 渲染的空壳 |
| `DependencyMissing` | 缺包或缺 LibreOffice | 按 `error.next` 里的 pip/winget 命令装，再 `doctor` |
| `LibreOfficeFailed` | 转换/渲染失败 | 文件是否被占用、是否加密；`docx validate` 看包结构 |
| `OutputDirNotEmpty` | 渲染目录不空 | 换个新目录名（渲染要求全新目录） |
| `InternalError` | 我们自己的 bug | 把 `error.message` + `detail.traceback` + 复现命令报给用户，别自己改技能目录里的文件 |

---

## 7. 典型串法

**做一份要发出去的中文 Word + PDF：**

```powershell
python skills/office/scripts/office.py doctor
python skills/office/scripts/office.py docx build --from 报告.md --out out/报告.docx --title "季度复盘"
python skills/office/scripts/office.py docx validate --file out/报告.docx
python skills/office/scripts/office.py docx render   --file out/报告.docx --out out/qa-docx   # 看一眼有没有方块/串版
python skills/office/scripts/office.py pdf build     --from 报告.md --out out/报告.pdf --qa-dir out/qa-pdf
#   ↑ 回执里看 preflight.missing=[]、font_audit.all_embedded=true、text_roundtrip.missing_chars=[]
#   ↑ 然后**打开 out/qa-pdf/contact-sheet.png 看一眼**
```

**要一张图，插进 Word 和 PDF（本轮新增的那条链）：**

```powershell
python skills/office/scripts/office.py chart example --out chart.json          # 拿一份规格样例改
python skills/office/scripts/office.py chart build --from chart.json --out out/chart.png
#   ↑ 回执里看 preflight.ok=true（缺字会直接失败，不给你方块图）
python skills/office/scripts/office.py docx image --file out/报告.docx --image out/chart.png --caption "图 1：订单量对比"
#   ↑ 同 caption 重跑 = 替换那张图，不会越插越多
# PDF 那边：在 Markdown 里写一行 ![](out/chart.png)，再 pdf build
```

**给别人的 docx 提意见（批注 + 回复 + 标记已解决 + 修订，全部可读回）：**

```powershell
python skills/office/scripts/office.py docx view --file 来稿.docx
python skills/office/scripts/office.py docx comment --file 来稿.docx --anchor "第三段那句结论" --text "这里缺数据来源" --author 用户 --out 来稿-批注.docx
python skills/office/scripts/office.py docx comment --file 来稿-批注.docx --reply-to 0 --text "补上了，见附录 A" --author 王工 --out 来稿-回复.docx
python skills/office/scripts/office.py docx resolve --file 来稿-回复.docx --id 0 --out 来稿-已解决.docx
python skills/office/scripts/office.py docx track   --file 来稿-已解决.docx --text "（补：来源见附录 A）" --after "第三段那句结论" --author 用户
python skills/office/scripts/office.py docx comments --file 来稿-已解决.docx     # 看 resolved / parent
python skills/office/scripts/office.py docx revisions --file 来稿-已解决.docx
```

**做张带公式、带图表的表，并保证别人打开就能看到数：**

```powershell
python skills/office/scripts/office.py xlsx build  --from 表.json --out out/表.xlsx     # charts/conditional 写在规格里
python skills/office/scripts/office.py xlsx chart  --file out/表.xlsx --type pie --data "汇总!B1:B4" --categories "汇总!A2:A4" --title 结构
python skills/office/scripts/office.py xlsx recalc --file out/表.xlsx --out out/表-算过.xlsx
python skills/office/scripts/office.py xlsx read   --file out/表-算过.xlsx --sheet 汇总 --range A1:E5
python skills/office/scripts/office.py xlsx render --file out/表-算过.xlsx --out out/qa-xlsx   # 图表/条件格式长什么样
#   回执必须是 route=libreoffice 且 delivery_file_recalculated=true，否则要如实告诉对方"缓存值可能没有"
```

**要动 XML（批量改文字、改样式、补字段）：**

```powershell
python skills/office/scripts/office.py docx prep  --file 来稿.docx --out work/     # work/unpacked/ 与 view.txt
#   改 work/unpacked/word/document.xml（lxml/文本替换都行）
python skills/office/scripts/office.py docx pack   --from work/unpacked --out out/改过.docx
python skills/office/scripts/office.py docx diff   --before 来稿.docx --after out/改过.docx   # 只该动你想动的那些段
python skills/office/scripts/office.py docx validate --file out/改过.docx        # 顺序改反了这里会报
```

**拆一份大 PDF、把其中的表和图抽出来：**

```powershell
python skills/office/scripts/office.py pdf text  --file 大.pdf --pages 1-3 --out out/前3页.txt
python skills/office/scripts/office.py pdf table --file 大.pdf --out out/表格.md
python skills/office/scripts/office.py pdf image --file 大.pdf --out out/imgs/    # 内嵌图导成 PNG + contact sheet
python skills/office/scripts/office.py pdf split --file 大.pdf --out out/split/
python skills/office/scripts/office.py pdf merge --files out/split/大-p001.pdf out/split/大-p003.pdf --out out/挑出来.pdf
```

**手上是一份 HTML（导出件/网页存档）要转 PDF：**

```powershell
python skills/office/scripts/office.py pdf from-html --from 页面.html --out out/页面.pdf --qa-dir out/qa-html
#   ↑ 本地渲染链：不联网、不交浏览器；CSS 分页不认，长文会自然流到下一页
```

---

## 8. 这个技能里有什么

```
skills/office/
├── SKILL.md                ← 你正在读的这份（触发只看 frontmatter 的 description）
└── scripts/
    ├── office.py           ← 唯一入口：解析参数、发回执、doctor
    ├── _common.py          ← 路径守卫、备份、回执信封、子进程、图片路径解析
    ├── _md.py              ← 自己写的 Markdown 解析（标题/列表/表格/代码/引用/分页/插图）
    ├── _html.py            ← HTML → 块模型（HTML→PDF 那条路的解析层）
    ├── _font.py            ← 找中文字体 + **解析 cmap 判断字形覆盖**
    ├── _lo.py              ← LibreOffice 适配（优先随包的 libreoffice-kit，其次 soffice）
    ├── _render.py          ← 出图、contact sheet、字体审计、文本往返、方框线索
    ├── _chart.py           ← 图表 PNG（Pillow 画 bar/barh/line/pie，画前查字形）
    ├── docx_ops.py         ← Word：建/校验(含深检查)/预览/拆包/XML/批注(含回复已解决)/修订/插图/出图
    ├── xlsx_ops.py         ← Excel：建/图表/条件格式/写/体检/重算/读/出图
    └── pdf_ops.py          ← PDF：建(md/html)/体检/抽文本抽表格**抽图**/页操作/元信息/出图/转 PDF
```

脚本是纯 Python（3.9+ 语法，实测 3.11 / 3.12），不依赖 Node 包；`siblings` 之间只 import 同目录模块，
运行时不往技能目录写任何东西（`sys.dont_write_bytecode = True`，所以没有 `__pycache__`）。
