# 插件界面协议（UI schema）

插件声明页面、宿主负责渲染。新增页面**不需要重新编译界面**：插件改 `plugin.json` 与 worker 返回值即可。

## 1. 页面注册

`plugin.json` 的 `contributions.views`：

```json
{
  "contributions": {
    "adapters": [{ "worker": "adapter-worker.mjs", "apiVersion": 2, "capabilities": ["ui.api"] }],
    "views": [
      { "id": "mood", "title": "情绪", "icon": "mood", "subtitle": "此刻的状态" }
    ]
  }
}
```

| 字段 | 必填 | 约束 |
|---|---|---|
| `id` | 是 | `^[a-z][a-z0-9-]{0,31}$`，同一插件内唯一 |
| `title` | 是 | 1~24 字，导航里显示的名字 |
| `icon` | 否 | 图标名（白名单见 §5），缺省用 `extension` |
| `subtitle` | 否 | 1~80 字，页面顶部的说明 |

宿主聚合接口：`GET /api/plugin/views` →

```json
[{ "pluginId": "linre-affect", "viewId": "mood", "title": "情绪", "icon": "mood", "subtitle": "此刻的状态" }]
```

只列**已启用**且适配器声明了 `ui.api` 的插件。

## 2. 视图获取

宿主向 worker 发 `ui/handle`：

```json
{ "jsonrpc": "2.0", "id": 7, "method": "ui/handle", "params": { "path": "/ui/mood" } }
```

回执是 §3 的文档对象。`path` 形如 `/ui/<viewId>`；`/state` 是早期自由形状接口，保留兼容但不参与通用渲染。

## 3. 文档对象

```json
{
  "title": "情绪",
  "blocks": [ { "type": "hero", "title": "情绪：平稳。", "badge": "稳", "tone": "primary" } ]
}
```

限制：`blocks` 最多 200 个；文本类字段单条最多 2000 字；`table.rows` 最多 200 行；`chart.points` 最多 500 点。超限宿主截断而不是报错。

## 4. 块类型

所有块共有可选字段 `type`（必填）与 `tone`（语义色，见 §4.17）。

### 4.1 `section` — 分组标题
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 必填 |
| `note` | string | 可选，右侧淡字 |

### 4.2 `hero` — 头部卡
| 字段 | 类型 | 说明 |
|---|---|---|
| `badge` | string | 圆形徽章里的 1~2 个字 |
| `title` | string | 主标题（大字） |
| `subtitle` | string | 可选副标题 |
| `chips` | `[{label, value, tone?}]` | 底下一排小胶囊 |

### 4.3 `metrics` — 指标组
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `items` | `[{label, value, unit?, tone?}]` | 横向等分，`value` 为已格式化字符串 |

### 4.4 `bars` — 进度条组
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `items` | `[{label, value, tone?, trailing?}]` | `value` 是 0~1 的浮点；`trailing` 缺省显示百分比 |

### 4.5 `progress` — 单条大进度
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `label` | string | 左侧说明 |
| `value` | number | 0~1 |
| `footer` | string | 可选，底部补充 |

### 4.6 `list` — 列表
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `items` | `[{tone?, label, detail?, trailing?}]` | 左边小圆点，中间标题，右下小字，右侧尾部 |

### 4.7 `grid` — 卡片网格
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `items` | `[{title, subtitle?, badge?, tone?, dots?, chips?}]` | 自适应列宽（最小 220px） |
| `dots` | `{filled, total}` | 小圆点进度，如强度 3/5 |

### 4.8 `table` — 表格
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `headers` | string[] | 表头 |
| `rows` | string[][] | 行；列数按 `headers` 截断或补空 |

### 4.9 `timeline` — 时间线
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `items` | `[{at, label, detail?, tone?}]` | `at` 是已格式化时间字符串，左侧竖线与圆点 |

### 4.10 `kv` — 键值对
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `items` | `[{key, value}]` | 两列，左右对齐 |

### 4.11 `chips` — 标签云
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `items` | `[{label, tone?}]` | 自动换行 |

### 4.12 `text` — 文本
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `body` | string | 必填；`\n` 分段，不支持 Markdown |

### 4.13 `chart` — 折线
| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string | 可选 |
| `points` | number[] | 每点期望落在 `min`~`max` 之间 |
| `min` / `max` | number | 缺省 -1 / 1 |
| `empty` | string | 无数据时的文案 |

### 4.14 `image` — 图片
| 字段 | 类型 | 说明 |
|---|---|---|
| `src` | string | 宿主可取的相对媒体路径或 http(s) URL |
| `caption` | string | 可选 |
| `aspect` | number | 可选，宽高比，缺省 1.6 |

### 4.15 `actions` — 操作按钮
| 字段 | 类型 | 说明 |
|---|---|---|
| `items` | `[{label, kind?, tone?, payload?}]` | `kind` 目前只定义 `refresh`（重新拉取本页） |

### 4.16 `empty` — 空态
| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | 必填 |

### 4.17 `tone` 取值

| tone | 用途 | 明暗两套由宿主给 |
|---|---|---|
| `primary` | 品牌主色（缺省） | 是 |
| `ok` / `warn` / `danger` / `muted` | 语义状态 | 是 |
| `joy` / `distress` / `concern` / `irritation` / `warmth` / `shyness` | 情绪六维 | 是 |

未知 `tone` 按 `primary` 处理。

## 5. 图标白名单

`icon` 只接受下列名字，其余回落到 `extension`：

`mood` `emoji` `chat` `image` `photo` `chart` `list` `grid` `setting` `extension` `memory` `clock` `tag` `link` `shield` `spark`

## 6. 约束与安全

1. **插件只描述，不执行**：schema 不含脚本、路由、样式覆盖。
2. **宿主兜底**：任何字段缺失或类型不符，该块降级为 `empty`，不影响同页其他块。
3. **长度与数量上限**见 §3，超限截断。
4. **不引入新主题**：颜色只能从 §4.17 的 `tone` 里选，避免各插件各写各的。
