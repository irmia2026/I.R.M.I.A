# 插件协议 v2 — 能力面与贡献点（草案）

状态：**draft**，随实现推进逐节转正。版本号 `apiVersion: 2` 已冻结，本文件只增不改。

---

## 0. 这份文件解决什么

插件平台 P0 的贡献面只有三样：`skills` / `hooks` / `mcp`。这三样都是**声明式**的——
插件说自己有什么，宿主决定挂不挂。

但上游把「情绪」和「表情包」这类模块做成了**宿主内建**：情绪要往系统提示里塞一行、
表情包要包住宿主的 `speak` 工具。它们需要的不只是"声明"，而是：

- 调模型（评价器、打标器）
- 往提示里注入一行
- 包装 / 装饰宿主已有工具
- 发媒体、读当前会话上下文
- 自带 HTTP 路由与存储配额

本文件定义这些能力面的**协议形状**，目标是：**插件能实现这类模块，而主仓库一行不改。**

---

## 1. 前缀保护（两条硬规矩）

### 1.1 命名空间前缀

| 归属 | 前缀 | 规则 |
| --- | --- | --- |
| 宿主保留 | `api.` / `system.` / `host.` / `plugin.` | 插件**不得**声明或写入 |
| 插件自有 | `<pluginId>.` | 事件类型、存储 key、工具名一律带此前缀 |

- 事件类型：插件只能写 `"<pluginId>.<event>"`，宿主在 `event/append` 时校验，越界直接拒绝。
- 工具名：全局唯一；冲突时保留宿主定义，插件定义进 `warnings`（现状行为，保持）。
- MCP server 名：必须是 `<pluginId>__<name>`（与 `linre-presence__presence` 同形）。
- 存储 key：由 broker 的 `storageNamespace = pluginId` 隔离，插件看不到别人的 key。

### 1.2 冻结前缀保护

模型请求的前缀（instructions / SELF_BRIEF / 工具 schema）在服务端是**缓存前缀**。
前缀任何一个字节变了，整段缓存失效。

因此：

1. **插件不得改写宿主前缀**。插件对提示的影响只能通过 `prompt/render` 落在 **NOW 层**
   （缓存边界之后），且渲染结果 ≤ 声明的 `maxChars`。
2. **工具清单变化必须显式失效**。插件启用/停用导致工具增减时，宿主必须 bump 缓存代次，
   不允许"清单变了、缓存还以为没变"。这条与 `pluginCompositionRevision` 对齐：
   组合摘要变了 = 前缀必须重建。
3. **插件的提示渲染是每步调用、只读入参**。宿主传进去的上下文按引用值快照，插件返回
   字符串；插件**不能**修改宿主的 instructions 对象。
4. **不得在提示里引入动态时间戳/随机数**。否则每步前缀都不同，缓存永远不命中。
   （宿主侧校验：同一 step 内相同输入必须得到相同输出，测试覆盖。）

---

## 2. 贡献点（contributions）

| 键 | 状态 | 形状 | 说明 |
| --- | --- | --- | --- |
| `skills` | 已有 | `string[]` | 技能目录 |
| `hooks` | 已有 | `string` | 钩子声明文件 |
| `mcp` | 已有 | `string` | MCP server 声明文件 |
| `tools` | 已有 | `string` | 工具门面（`name` / `inputSchema` / `server` / `tool`），每包 ≤8、全局 ≤12 |
| `events` | 已有 | `{ namespace: string }` | 事件命名空间 |
| `adapters` | 已有 | `Array<{ worker, apiVersion: 2, capabilities }>` | 适配器 worker（JSON-RPC 2.0 over stdio） |
| `prompt` | **新增** | `{ slots: string[], maxChars: number }` | 声明要注入的槽位与字数上限 |
| `toolPatches` | **新增（P1）** | `string` | 装饰宿主已有工具（加参数 / 前后钩子） |
| `ui` | **新增（P2）** | `{ api: string }` | 插件自带 HTTP 路由 |

---

## 3. 能力（capabilities）

宿主维护白名单，插件在 `adapters[].capabilities` 里申请，运行时由 `CapabilityBroker.check()`
校验（已有的 `scope` / `expiresAt` / `quota` 语义不变）。

| 能力 | 状态 | scope | 配额 | 说明 |
| --- | --- | --- | --- | --- |
| `event.observe` | 已有 | — | — | 只读 **visibility=model** 的事件（现有 `adapterEventView` 过滤） |
| `event.publish` | 已有 | 自身 namespace | 每小时 120 条 | 写事件，类型必须带插件前缀 |
| `storage.kv` | 已有 | pluginId | maxKeys / maxBytes | 键值存储（`StoragePort`） |
| `asset.resolve` | 已有 | — | — | `MediaPort.resolve` 读资产元数据 |
| `message.propose` | 已有 | — | — | 提交发言/发图草案（走 effect 通道） |
| `model.invoke` | **新增（已实现）** | `light` \| `heavy` | `maxUses` | 调模型，见 §4.1 |
| `prompt.inject` | **新增（已实现）** | 槽位名 | — | 注入提示行，见 §4.2 |
| `asset.store` | **新增（已实现）** | — | 单次 8 MB | 交字节给宿主落地，回宿主相对路径（`send_media` 认得），见 §4.4 |
| `tool.patch` | **新增（P1）** | 工具名 | — | 装饰宿主工具，见 §4.3 |
| `media.post` | **新增（P1）** | 通道名 | `maxUses` | 发媒体到会话 |
| `context.read` | **新增（P1）** | `wake` \| `session` | — | 读当前唤醒通道/会话标识（不含正文） |
| `ui.api` | **新增（P2）** | 路由前缀 | — | 插件自带 HTTP 路由 |

拒绝理由沿用现有的：`capability-denied` / `scope-required` / `scope-denied` /
`grant-expired` / `quota-exhausted` / `quota-bytes-exhausted`。

---

## 4. 新协议的请求 / 回执形状

### 4.1 `model.generate`（worker → 宿主）

```jsonc
// worker 发起
{
  "jsonrpc": "2.0", "id": "...", "method": "model/generate",
  "params": {
    "capability": "model.invoke",
    "lane": "light",                       // light | heavy
    "instructions": "...",                 // 可选，≤ 8192 字
    "input": "...",                        // 必填，≤ 64 KiB
    "text": { "type": "json_schema", "name": "...", "schema": {...} },  // 可选
    "reasoning": { "effort": "low" },      // 可选
    "timeoutMs": 4000                      // 可选，上限由宿主定（默认 10s）
  }
}

// 宿主回执
{
  "jsonrpc": "2.0", "id": "...",
  "result": {
    "text": "...",                          // 拼接后的 message 文本
    "model": "...", "protocol": "...",
    "usage": { "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0 }
  }
}
```

约束：

- **必须消耗一次配额**（`maxUses`），超时/失败也计次（防重试风暴）。
- 宿主把用量写进 `budget/consumed` 事件，`affectEvaluation` / `pluginId` 作为归因字段。
- 插件**不得**自建模型连接；配置里的 key/baseUrl 永不下发给插件进程。
- 失败返回 JSON-RPC error，`data.reason` 区分 `denied` / `timeout` / `upstream`。

### 4.2 `prompt/render`（宿主 → worker）

宿主在每次组装 step 提示时调用；插件返回一行。

```jsonc
// 宿主发起
{
  "jsonrpc": "2.0", "id": "...", "method": "prompt/render",
  "params": {
    "slot": "now-layer",
    "maxChars": 90,
    "context": {
      "turn": 12,
      "step": 3,
      "ts": "2026-11-06T07:00:00.000Z",
      "wake": { "channel": "onebot", "chatType": "c2c" }   // 仅在授予 context.read 时给
    }
  }
}

// worker 回执
{ "jsonrpc": "2.0", "id": "...", "result": { "text": "情绪：明显愉快 → 话变多，主动分享。" } }
```

约束：

- `text` 为空串 = 不注入。
- 超过 `maxChars` 宿主截断并记 `warnings`（不报错，不阻塞）。
- **同一输入必须产出同一输出**（禁止时间戳/随机数进提示，见 §1.2）。
- 超时或异常 = 本步不注入，主流程继续（fail-open）。

### 4.3 `tool.patch`（P1，形状待定）
目标：让插件能装饰宿主工具（表情包要包 `speak`）。当前 `tools` 只能新增，不能包装。

拟定形状（尚未实现）：

```jsonc
// contributions.toolPatches 指向的文件
[
  {
    "tool": "speak",
    "addParameters": { "sticker": { "type": "string", "enum": ["开心", "难过"] } },
    "before": true,     // 调用前回调插件
    "after": true       // 调用后回调插件
  }
]
```

---

### 4.4 `media/store`（worker → 宿主，已实现）

插件**不直接写宿主文件系统**：它交字节，宿主按内容哈希落盘，只回一个
`send_media` 认得的**宿主相对路径**。

```jsonc
// worker 发起
{
  "jsonrpc": "2.0", "id": "...", "method": "media/store",
  "params": { "kind": "image", "data": "<base64>" }
}

// 宿主回执
{ "jsonrpc": "2.0", "id": "...", "result": { "path": "media/plugin/linre-stickers/<sha256>.png", "sha256": "...", "bytes": 68 } }
```

约束：

- 内容寻址（sha256 作文件名）⇒ 同一张图重复提交天然幂等，不重复占盘；
- 只落在 `data/media/plugin/<pluginId>/` 之下 ⇒ 插件之间资产不互相覆盖；
- 单次上限 8 MB，超了直接拒绝；
- 回执只给路径与哈希，**不给绝对路径**（插件不需要知道宿主装在哪）。

## 5. 事件与不变量

### 5.1 事件里存"当时算出的值"，不存公式

上游情绪模块的不变量（`src/affect/types.ts` 原注释）：事件存的是当时算出的 impulse，
不是事后重算的结果。插件化后这条必须保留：

- 插件写的事件必须自带 `plugin` + `pluginVersion` + `contentHash`。
- 插件升级公式后，**历史事件不回算**；投影重建只重放事件。
- 宿主在 `event/append` 校验：无版本字段的插件事件直接拒绝。

### 5.2 审核卡点不能由插件绕过

表情包的 `pending → approved` 是**人工审核**。插件可以采集、可以打标、可以请求发送，
但"这张图能发"这个判断必须落在宿主侧：

- 插件只能把候选写成 `pending`。
- `approved` 只能由人（界面 / `plugin/installed { by: 'human' }` 同级语义）触发。
- 宿主在 effect 层审计：插件试图直接发 `pending` 资产 → 拒绝并记审计。

### 5.3 副作用一律走 effect 通道

发消息、发媒体、改文件、调通道，全部走 `effect/propose` → 宿主 `EffectDispatcher`，
带 `idempotencyKey`。插件**不得**自己直连通道。

---

## 6. 版本协商

| 字段 | 语义 |
| --- | --- |
| `apiVersion` | 协议大版本。v1 = 只有 skills/hooks/mcp；v2 = 增加 tools/events/adapters/prompt/... |
| `engine.irmia` | 宿主版本范围（semver range）。不满足 → 装不上，给出原因。 |
| `contentHash` | 包内容哈希，同 `id@hash` 只可能有一份字节 |

升级规则：

- 新增贡献点/能力 → 只增 `apiVersion` 内字段，**不 bump** 大版本。
- 删除或改变已有字段语义 → 必须 bump 到 `apiVersion: 3`，且宿主同时支持 v2 一个周期。

---

## 7. 落地顺序

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0-a | `model.invoke`（RPC `model/generate`）+ `prompt/render` | ✅ 已实现：`linre-affect` 插件跑通，宿主只加了一处能力门与一次转发 |
| P0-b | 情绪插件测试 | ✅ 已实现：`test/plugin-affect.test.ts` 3 项 + `test/render.test.ts` 插件行用例 |
| P1-a | `asset.store`（RPC `media/store`）+ 表情包插件 | ✅ `linre-stickers` 跑通：只推荐审核过的图，自己不发图 |
| P1-b | 表情包测试 | ✅ `test/plugin-stickers.test.ts` 8 项（含 pending 卡点、冷却、空串沉默） |
| P1-c | `tool.patch`（包装 `speak` 自带表情参数） | 未做：v0 用「推荐 + 现有 `send_media`」已能发图，包装留到有明确需求时 |
| P2 | `ui.api` | 插件自带 `/api/<pluginId>/*` |

### 7.1 P0 的已知缺口（如实记录）

1. **重放不还原插件行**：插件行目前只进请求体，没有写进 `step/start.data`。
   重放出来的历史会比当时少一行「插件：」。补法是 P1 把这一行随 `step/start` 落库
   （与上游 `step/start.data.affect` 同一口径）。
2. **没有历史事件回放**：worker 启动后只看到新事件，重启期间的情绪状态从头累积。
   补法是宿主在握手后补发最近 N 条 `visibility=model` 事件。
3. **额度记账未接**：`model.invoke` 现在只做能力门，还没有按 `maxUses` 记账
   （`CapabilityBroker` 有现成实现，差接线）。

---

## 8. 明确不做

- 不做插件间直接通信（一律经宿主事件总线）。
- 不做插件热升级内存态（升级 = 停旧起新，状态走 storage）。
- 不把宿主配置（key / baseUrl / 路径）下发给插件进程。
- 不允许插件覆盖宿主保留前缀的事件、工具、路由。
