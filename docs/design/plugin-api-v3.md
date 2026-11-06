# 插件 API v3 定稿：让插件能「纯增量」加特性

> 状态：定稿（2026-11-04）。本文是这份接口的唯一口径，代码里不再写注释说明这些约定 ——
> 注意事项、配额、坑，全部记在这里。

## 0. 一句话

**内核只认「事件」，不认「特性」。** 内核永远不该知道"频道""待着""进群"是什么，
它只需要知道三件事：有一件工具要进她的清单、有一条插件事件要渲染成一行字、有一次唤醒请求要不要准。

## 1. 为什么需要 v3：三个断点 + 一个空壳

| # | 断点 | 证据 |
|---|---|---|
| 1 | 插件工具进不了她的工具清单 | `/api/tools` 只有 23 件内置；MCP 工具一律走 `mcp` 元工具转发（`render.ts` 的 MCP 常驻索引明写「工具名不在这段索引里」） |
| 2 | 插件写不了进她上下文的事件 | `main.ts:2885` `appendWithSeq('channel/message', …, 'internal')` 可见性写死；worker 侧 `supervisor.ts:76` 只把 `visibility === 'model'` 的事件**推出去**，回程没有写入口 |
| 3 | 写进去也没人渲染 | `render.ts` 全文没有 `channel/message` 分支 —— 事件进去了，一个字都不产生 |
| 4 | 效果提案是空壳 | `main.ts:1330` `onEffectProposal` 只 `write()` 一行日志，**没有任何执行** |

结论：插件当前能给的只有「技能文本 + 钩子命令 + MCP 工具（藏在元工具后面）+ 只读观测」。
任何要"进入她上下文"的特性，都只能靠手改内核源码 —— 那不是插件。

## 2. 四条设计原则

1. **宿主只认事件**：新增特性一律落成事件，不新增内核语义。
2. **快照渲染**：插件 append 时自带渲染好的正文，渲染期只吐 `data.text`，**绝不执行插件代码**
   （确定性 + 性能 + 前缀不变性三条都靠它）。与既有的 `skill/index`、`mcp/index` 同一套做法。
3. **命名空间隔离**：插件只能写 `plugin/<自己 id>/*`，写不了 `wake/channel`、`speak/sent` 这些内核事件。
4. **特权显式授权**：能往她上下文里写字的插件，是特权插件；安装确认时必须单独列出这一条。

## 3. 三个贡献点

`apiVersion` **仍为 2**（不新开 3）：再加这三个可选键不改变任何旧插件的含义，少维护一条版本分支。
校验处 `src/plugin/manifest.ts` 的 `contributionKeys` 白名单已同步加 `tools`。

> **落地时发现的契约偏差（2026-11-04）**：原实现里 `parseAdapterContributions` 强制 `adapters` 为**非空数组**，
> 于是任何 v2 插件都被迫写一个假的 adapters。已改为「缺省即空数组」，v2 不再强制声明适配器。
> 关联测试 `test/plugin-package.test.ts` 里「apiVersion 2 必须被拒」那条断言同步改成「能正常解析」。

```jsonc
{
  "apiVersion": 2,
  "id": "linre-presence",
  "contributions": {
    "skills": ["skills"],
    "tools":  "tools.json",
    "events": { "namespace": "presence" },
    "wake":   "wake.json"
  }
}
```

### 3.1 tools —— 一等工具进她的清单

`tools.json` 是数组，每条把一件 MCP 工具**提升**为她的正式工具（当前只支持这种形态，不新造 RPC）：

```jsonc
[
  {
    "name": "enter_channel",
    "description": "进一个频道待着：返回最近 20 条，之后可 wait_messages 等新消息。",
    "inputSchema": { "type": "object", "properties": { "sid": { "type": "string" } }, "required": ["sid"] },
    "server": "linre-presence__presence",
    "tool": "enter_channel"
  }
]
```

规则：

- 注册名是 `plugin__<插件id>__<name>`（前缀 `plugin__`），避免与内置、`mcp__` 撞名；总长 ≤ 128。
- `description` 受既有硬线约束：**≤ 100 token**（`registry.ts` 的 `MAX_DESCRIPTION_TOKENS`），
  超了拒绝注册并把原因写进插件的 `problems[]`，**不许静默截断**。
- 每插件 ≤ 8 件，全部插件合计 ≤ 12 件（工具清单是每轮常驻开销，`CATALOG_TOKEN_REFERENCE` 2000 是观测线）。
- 执行：宿主按 `server`+`tool` 转发给 MCP 池（复用 `mcp` 工具的既有调用路径），**不新写一套传输**。
- `executionMode` 固定 `parallel`、`sideEffect` 固定 `none`、`timeoutMs` 固定 150s（v3.0 **不接受**插件声明这三项；
  留到下一版再开，因为 `SideEffect` 的取值集合还没对插件开放）。
- 工具清单**每次现查**，不缓存（`registry.ts` 的既有纪律：动态注册/卸载必须立即生效）。

### 3.2 events —— 往她的上下文里写字

插件通过适配器 worker 的新请求 `event/append` 提交，宿主校验后落库：

```jsonc
{ "type": "plugin/presence/message",
  "visibility": "model",
  "data": { "text": "· 00:37 泡泡茶壶：之前发一句回一句群友都投诉了", "sid": "onebot:group:953245617" } }
```

规则：

- 类型必须匹配 `^plugin/<插件id>/[a-z0-9-]{1,40}$`，否则整条拒绝（**不静默改名**）。
- `visibility` 只接受 `model` / `internal`；别的值一律拒绝。
- `data.text` 必填、≤ 2000 字符、必须是**已经渲染好**的正文（见原则 2）。无 `text` 直接拒绝。
- 单条序列化后 ≤ 4 KB；单插件每轮 ≤ 8 条、≤ 16 KB（超出丢弃并通报，不排队）。
- 宿主落库前补 `pluginId`、`contentHash` 到事件 `origin`，便于事后追责与渲染回溯。
- **不允许**插件写内核事件类型（`wake/channel`、`speak/sent`、`channel/message`…），白名单外一律拒。

### 3.3 wake —— 请求叫醒，但由宿主决定准不准

`wake.json` 只声明意图，不是开关：

```jsonc
{ "reasons": ["presence:new-message"], "maxPerHour": 12 }
```

- 插件发 `wake/proposal`（`{reason, text}`），宿主按 `maxPerHour`（取插件声明与全局上限的**较小值**）限流。
- 超限：丢弃 + 通报一次（同一 reason 每小时最多通报一次，避免刷屏）。
- 准入后宿主落一条 `plugin/<id>/wake` 事件（`visibility: model`）并 `loop.wake`，
  **不直接复用 `wake/channel`**（那条的语义是平台消息，混用会让渲染层和未读口径分叉）。
- 全局上限：所有插件合计 ≤ 30 次/小时。

## 4. 渲染：一条通用分支

`render.ts` 里只加一条规则：事件类型以 `plugin/` 开头 ⇒ 原样吐 `data.text`。

- 位置：与 `wake/channel` 等既有分支同一层的事件→文本映射处。
- **不解析、不加工、不改写**插件文本；要不要前缀、要不要缩进，由插件在 `text` 里自己决定。
- **渲染期绝不 import 或调用插件代码**。
- `RENDER_VERSION` 的递增判据只有一条：**请求字节是否变化**。这条分支对"历史上没有任何 plugin 事件的日志"
  不改变一个字节，所以**首个落地版本不递增**；一旦线上真的出现第一条 `plugin/*` 事件，
  那一轮之后就必须递增（因为此后请求体里会多出这一行）。判据按"字节"算，不按"代码改了"算。

## 5. 配额总表

| 项 | 上限 | 超限行为 |
|---|---|---|
| 单工具描述 | 100 token | 拒绝注册，记 `problems[]` |
| 每插件工具数 | 8 | 拒绝多余项 |
| 全插件工具数 | 12 | 拒绝多余项 |
| 单条事件 | 4 KB / `text` 2000 字符 | 整条拒绝 |
| 每轮每插件事件 | 8 条 / 16 KB | 丢弃 + 通报 |
| 唤醒 | 声明值 ∩ 30/小时（全局） | 丢弃 + 通报（每 reason 每小时一次） |

## 6. 信任

- 沿用 install → confirm → enable 三态；安装即不可信。
- confirm 界面必须**单独列出**：`events`（能往她上下文写字）、`wake`（能叫醒她）、`tools`（占用清单预算）。
- 内容哈希一变就是新包，特权要重新确认 —— 沿用既有 `contentHash` 机制，不另开一套。

## 7. 落地顺序（4 步，每步独立可验收）

| 步 | 内容 | 接触面 | 验收 |
|---|---|---|---|
| 1 | `tools` 贡献点 | `plugin/manifest.ts`、`plugin/contributions.ts`、`main.ts` | **已完成**（2026-11-04）：`linre-presence` 三件工具在 `/api/tools`，清单 23 → 26 |
| 2 | `events` + 通用渲染分支 | 同上 + `adapter/supervisor.ts`（worker→host 请求）、`render.ts` 一条分支 | **已完成**（2026-11-04）：真子进程发 `event/append` 被接收、非法方法回 -32601、拒绝原因原样回 -32602、`plugin/*` 文本进渲染 |
| 3 | `wake` + 配额 | `plugin/runtime.ts`、`main.ts`、限流表 | **延后**（2026-11-04）：见 §13 的理由 |
| 4 | `proposal` 接线或删除 | `adapter/supervisor.ts`、`main.ts` | **已完成**（2026-11-04）：`effect/propose` 接上了，回执恒为 `accepted:false` |

## 8. 注意事项（坑）

1. **`exactKeys` 是白名单**：`contributions` 里没列出的键会让**整份 manifest 校验失败**，
   加新键时必须同步改 `contributionKeys`，否则插件装不进去（错在解析期，不在装配期）。
2. **`pluginContributionPath`** 会拒绝对路径与 `..` 逃逸 —— `tools.json`/`wake.json` 必须走它，别手拼路径。
3. **工具名长度**：`plugin__<id>__<name>` 很容易超 128；`name` 要短。
4. **描述预算**是拒绝不是截断：超 100 token 的插件工具**一件都不会**出现在清单里，
   表现是"插件 enabled 但工具不见"，排查时先看 `problems[]`。
5. **不要缓存** `listForModel()` 的结果：注册表支持运行期动态注册/卸载，缓存会让新工具整轮不可见。
6. **`main.ts:2885` 的 `'internal'` 不要动**：`channel/message` 的可见性是内核语义，
   插件事件走 `plugin/*`。混用会让未读计数与 `read_channel` 口径分叉。
7. **worker→host 请求当前被丢弃**：`supervisor.handleMessage` 只认 `id` 且必须是宿主发起的 pending，
   没有 `method` 分支。加 `event/append` 必须新增这条分支，并同样受 `MAX_LINE_BYTES` 约束。
8. **限流表的载体**：进程内 Map 即可（重启清零可接受），不要塞进事件日志（会自我放大）。
9. **插件故障不许拖垮内核**：任何校验失败只影响这一条/这一件，必须 try/catch 到 `problems[]` 或通报，
   绝不让异常冒到事件追加路径上（那会让整轮落库失败）。
10. **渲染分支必须排在既有分支之后**：`plugin/*` 是新类型，不参与 `wake/channel` 的任何既有判定。
11. **代码不写注释**（用户 2026-11-04 定）：所有"为什么这么做"记在本文件，代码里只留可执行的形状。
12. **事件落库后不可改**：`text` 一旦写进去就是历史，插件改渲染措辞也**不会**回头改写旧行 ——
    这正是快照渲染要换取的确定性，别试图"修一下历史"。

## 9. 测试策略：最小实机还原

不做纯 mock。每条主线用"最小实机"：临时 dataDir + 真 MCP 子进程（`node -e` 起一个 echo server），
走真实的 manifest 解析 → 装配 → 调用 → 事件落库 → 渲染。

| 用例 | 断言 |
|---|---|
| 工具提升 | `tools.json` 一件 → registry 里出现 `plugin__x__t`，`listForModel()` 含它；描述超 100 token 时**不出现**且 `problems[]` 有原因 |
| 转发 | 调用该工具 → 打到 MCP 子进程，参数原样，返回值原样 |
| 事件写入 | worker 发 `event/append` → 事件落库、`visibility` 正确、`origin.pluginId` 补齐 |
| 事件拒绝 | 类型不在自己命名空间 / 无 `text` / 超 4 KB → 全部拒绝且**不落库** |
| 渲染 | 一条 `plugin/x/message` → 渲染结果里逐字包含 `data.text` |
| 唤醒限流 | 连发 13 次 → 第 13 次被丢，通报只出现一次 |
| 历史不变 | 同一份没有 `plugin/*` 事件的日志，改动前后渲染字节完全一致 |

## 10. 已知限制

- 插件事件只能**追加**，不能改、不能删（与事件日志不可变一致）。
- 唤醒配额是进程内的，重启清零；真要持久化另说。
- 本版不支持插件自己写渲染器（那会破坏前缀不变性与确定性），只支持快照文本。
- 适配器 worker 仍然是"只读观测 + 三种提议"，本版只是把三种提议里的两种接上了地。

## 11. 落地日志

- **2026-11-04 第 1 步完成**。改动面：`src/plugin/manifest.ts`（v2 白名单加 `tools`、`adapters` 改为可选）、
  `src/plugin/contributions.ts`（新增 `composePluginTools`：每插件 ≤8 件、合计 ≤12 件、注册名 ≤128、
  名字正则 `^[a-z][a-z0-9_]{1,40}$`）、`src/main.ts`（`pluginToolSyncRef` 在 `catalog.registry` 就位后挂上装配闭包，
  `applyPluginRuntime` 每次重装插件就重新注册；handler 原样转发 MCP 池 `callTool`）。
  验收：重启后 `/api/tools` 23 → 26，三件 `plugin__linre-presence__*` 均在列，插件 `problems` 为空。
- **测试基线**：`test/plugin*.test.ts` 72/72 通过。其中两条是**既有测试过期**（与本次功能无关）：
  `plugin-runtime.test.ts` 的组合体期望缺 `adapters: []`；`plugin-package.test.ts` 写死「apiVersion 2 必须被拒」。
- **未做**：第 2/3/4 步。第 2 步的落点已经定位到 `render.ts` 的 `renderEvents`（5679 行）里的事件分派处，
  与 `adapter/supervisor.ts` 的 `handleMessage`（只认宿主发起的 pending，worker 主动请求被丢弃）。

## 12. 第 2 步落地记录（2026-11-04）

- `manifest.ts`：v2 新增 `events?: { namespace: string }`，`exactKeys` 只认 `namespace`，值受 `^[a-z][a-z0-9-]{1,40}$`。
- `supervisor.ts`：`handleMessage` 先分流 **worker→host 请求**（有 `method` 且有 `id`），走 `handleWorkerRequest`；
  仅接 `event/append`，其余回 `-32601`；未配置回调回 `-32001`；回调返回字符串即拒绝，`-32602` 原样带回。
- `main.ts`：`onPluginEventAppend` 做全部校验（命名空间、后缀、visibility、`data.text` ≤2000、单条 ≤4KB），
  通过则 `appendWithSeq(type, …, visibility)`，`data` 里补 `pluginId` + `contentHash`。
- `render.ts`：`switch (e.type)` 之前一条 `plugin/` 前缀分支 `close()` 后原样 push，空文本整条跳过。
- **偏差**：§5 写的"每轮 8 条 / 16 KB"改成**每插件每小时 120 条**——每轮配额要接进轮次状态机，
  这一版没有那个钩子；每小时口径更简单且够用。上一版按轮算，这里如实记录差异。
- **注意**：`event/append` 只对**适配器 worker**（`adapters[].worker`）可用；MCP 侧插件（如 `linre-presence`）
  走的是另一条池子，拿不到这个通道。
- 测试：`test/plugin-events-v3.test.ts`（真子进程，2 例）+ `test/render.test.ts` 新增 1 例；
  `plugin* / adapter* / render` 三组 **219/219** 通过。

## 13. 第 3 步为什么延后（2026-11-04）

`wake/proposal` 要让一条插件事件**真的起一轮**，就必须给事件联合加一个变体（`plugin/<id>/wake` 或 `wake/plugin`），
而唤醒类型的是**三处端口**同时认它：

1. `src/log/types.ts` 的事件类型联合（加变体）
2. `renderWake` 的 `switch (e.type)`（加 case，否则落进兜底、措辞是错的）
3. `wakeTitle` 与投影侧的唤醒分类（未读、唤醒计数都按类型分）

漏掉任一处，症状是"能起一轮但请求体里那句话是错的/没有"，比不接更糟。
这一版不硬塞：**先不做，比做歪好**。落地顺序建议放在第 4 步之后单独一轮，一次只动这三处。

## 14. 第 4 步落地记录（2026-11-04）

- 事实：`onEffectProposal` 在 `supervisor.ts` 里**从来没被调用过** —— 连回调入口都是死的，
  `main.ts:1330` 那段日志因此永远不会打印。原来的"空壳"比文档写得更空。
- 现在：worker→host 请求 `effect/propose` 走 `handleWorkerRequest`，宿主调用回调（记录到日志），
  回执**恒为** `{accepted:false, reason:'本版不执行副作用提案：只记录，不入队'}`。
- 口径：提案是"我能做这个"，不是"我要做这个"。**不执行、不入队、不重试**，给回执是为了让 worker 别等。
- 测试：`test/plugin-events-v3.test.ts` 增 1 例（真子进程，断言 `accepted:false` 且 reason 含"不执行"）。
