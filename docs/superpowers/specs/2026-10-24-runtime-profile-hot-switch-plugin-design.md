# Runtime Profile 热切换与统一插件平台设计

日期：2026-10-24
状态：草稿；用户已确定插件系统优先，热切换随后接入

## 1. 意图

把目前“修改模型、人格、工具或 MCP 后重启进程 / 切换上下文”的体验，改成不重启进程、保留主对话连续性的热切换。工程模式的插件启停复用同一机制，不另造一套热更事务。

这里的“热”保证：进程不重启、历史不丢、在途 turn 不换配置、压缩未完成也能继续聊、崩溃后可恢复。它不保证模型 KV 缓存保留；更换模型、提示词、人格或工具前缀时，缓存失效是正常结果。

## 2. 已确认的范围

第一版包含：

- 单个主对话的 Runtime Profile 切换。
- 保存与“生效”分离。
- 切换点立即生成机械交接摘要；旧模型异步生成语义摘要。
- 语义摘要迟到后替换同覆盖段的临时摘要，不回吞切换后的消息。
- 统一插件包，先接 Skill、Hook、MCP、提示词、人格覆盖层 / 提案。
- 声明式 Flutter UI 与声明式模型 provider 预设。
- MCP 工具与声明式 UI 动作。

第一版不包含：

- 每个 QQ 会话独立 Profile、独立上下文或多会话隔离。
- 任意 Dart / JavaScript 前端代码下载执行。
- 主进程内动态 `import()` 第三方后端代码。
- 自定义模型传输协议和自定义通道 worker；它们属于后续阶段。
- 插件市场、自动更新、跨机同步和不受信代码的安全沙箱。

主对话指当前共享事件流中的 GUI 主对话。外部通道继续共享该运行档案；不得把本设计表述成已经具备 per-sid 配置。

## 3. 现状与可复用基础

- `src/config/watcher.ts`：已有去抖、串行、超时、失败保留旧配置；当前仅 `mcp.servers` 自动热更。
- `src/runtime/agent-loop.ts`、`src/persona/handoff-note.ts`：已有 turn 边界、确定性机械交接与 `compaction/summary`。
- `src/model/render.ts`：已有摘要遮蔽、render 指纹、MCP / Skill 索引快照。
- `src/skill/skills.ts`：已有内容 hash 与人类信任门。
- `src/mcp/client.ts`：已有进程隔离、超时、在飞上限、副作用保守分类与工具缓存。
- `src/hook/hooks.ts`：已有 Wake / PreToolUse / PostToolUse 和受保护配置。
- `gui/lib/app.dart`：页面按 id 注册，可抽出内置与插件页面的共同注册表。

不能简单扩大 `HOT_RELOAD_FIELDS`：模型和插件切换需要旧配置继续服务在途 turn 与旧模型压缩，当前“就地改唯一 AppConfig”不满足这一点。

## 4. 核心模型

### 4.1 配置分类

建立唯一的字段策略表，所有配置写入、GUI 徽章、watcher 和 ActivationService 共用。未登记字段默认 `process`，不得默认热更。

第一版三类：

- `live`：已经拥有独立即时生效路径的字段，保持原行为，例如压缩线、提及词及已有即时开关。
- `profile`：`models.*`、人格相关字段、`tools.destructiveEnabled` / `planMode` / `taskEnabled`、`mcp.servers`、启用插件集合及提示词 / 人格插件内容。
- `process`：`dataDir`、`web`、路径基准及尚未登记适配器的字段。通道、wake 等不因本设计自动变成可热切字段。

实现时为每个根命名空间列出完整策略；未知字段必须测试为 `process`。现有专用即时命令不强制迁进 Profile。

一次保存混合多类字段时按字段拆开生效，用户已确认不采用整批拒绝或整批等待：

- `live` 部分沿用现有即时路径。
- `profile` 部分生成独立候选，可不受 `process` 部分阻塞而激活。
- `process` 部分保持待重启状态，直到进程接管。
- 回执与 GUI 同时返回三类结果，不用单个枚举吞掉混合状态；`changeId` 只标识其中的 Profile 候选。

拆分以字段策略表为唯一判据。任一类失败不影响其他类已经明确提交的结果，但回执必须逐项说清，不得把整次保存简称为全部成功或全部失败。

`mcp.servers` 从“watcher 自动接管”改为 `profile`：GUI 保存与直接编辑配置都只产生候选版本，点击“生效”后才切换。这是有意的行为变更，需要在 CHANGELOG 和设置页说明。

### 4.2 RuntimeProfile

Profile 是不可变的运行档案，至少包含：

```ts
interface RuntimeProfile {
  id: string
  spec: ProfileSpec
  modelClient: DsClient
  toolCatalog: ToolRegistry
  personaHash: string
  pluginSetHash: string
  renderFingerprint: string
}
```

`ProfileSpec` 是配置与插件贡献的稳定、可序列化子集，不含明文密钥。`LiveSettings` 管理即时字段；`ProcessConfig` 只在启动时读取。不得用同一个可变 `AppConfig` 同时扮演这三者。

每个 turn 在 `turn/start` 固定 `profileId`，该 turn 的所有 step、模型请求、工具执行与压缩判定都读同一份。切换只在 `turn/end` 后发生。模型请求 / 诊断事件应能读到实际 `profileId` 与 render 指纹。

ProfileManager 负责候选构建、当前档案、旧档案引用计数和客户端回收。旧模型客户端至少保留到旧 turn 与切换压缩任务结束；不得在任务进行中只按 LRU 强行释放。密钥只以 `secretRef + version` 引用，事件与 ProfileSpec 不记录明文或明文 hash。

模型密钥变更若影响 Profile，也进入待生效状态；旧任务可暂时持有内存中的旧凭据。通道密钥等已有即时语义不随此规则改变。

## 5. 热切换状态机

### 5.1 保存

1. 校验完整候选配置与插件包；失败则不改变生效状态。
2. 写盘成功后产生 `changeId`、`targetProfileHash`、字段差异和缓存影响分类。
3. 追加 `profile/staged`，当前 Profile 完全不变。
4. 连续保存可取代尚未激活的候选，旧候选标记 `superseded`；已点激活的目标不得被后续保存偷偷换掉。

配置 watcher 不再直接把 Profile 字段写进活配置，而是汇入同一个 staging 入口。

### 5.2 请求生效

1. 用户调用 `profile-activate { changeId }`，服务端再次核对候选 hash。
2. 追加 `profile/switch-requested`。
3. 若 turn 在途，状态为 `waiting-turn`；新到输入仍按旧 Profile 完成当前 turn，不在 step 中间换道。
4. turn 结束后固定 `cutOffSeq`。同一主对话同一时间只允许一个等待切点的激活事务；重复点击按 `changeId` 幂等。
5. 同步生成并落盘机械摘要，随后允许激活。机械摘要失败则保留原文并记录降级，不伪称压缩成功。

### 5.3 激活与异步整理

激活事务追加 `profile/activated { from, to, cutOffSeq, summarySeq?, compactionJobId? }`，此后的新 turn 使用新 Profile。

若旧模型可用，CompactionService 使用旧 Profile、旧 persona 和 `seq <= cutOffSeq` 的冻结事件视图发起一次无工具模型请求：

- `origin = 'profile-switch'`，记录旧 `profileId` 与任务 id。
- 消耗计入全局预算和旧 Profile 对应 lane；不免费、不记到新模型账上。
- 不提供工具，不执行插件命令，不允许直接改人格或记忆文件。
- 输出经长度、结构和空摘要校验后才可写 `compaction/summary`。
- 请求与结果保留现有模型审计 / 重放所需记录。

第一版的“记忆式压缩”直接落在语义交接摘要中，摘要固定包含有证据时的稳定事实、关系信息与未完成任务；没有证据的段落留空，不编造。不新增独立的记忆建议事件、API 或 GUI 页面。自动回写长期记忆不属于第一版切点关键路径；后续若增加，必须使用资产版本 compare-and-swap，冲突时保留建议而非覆盖新写入。

### 5.4 切换中再次修改

激活后允许下一次 staging / activation。旧压缩任务只覆盖自己的 `cutOffSeq`，不得读取或压缩新 Profile 产生的事件。多个任务可并发但受全局模型并发与预算门限制；后续切点更大时，可取消旧任务，取消不损害历史。

## 6. 摘要版本与渲染契约

现有 `CompactionSummary` 仅含 `coveredUpToSeq` 与 `summary`。新增可选字段，旧事件保持合法：

```ts
{
  jobId?: string
  revision?: number
  kind?: 'mechanical' | 'model'
  sourceProfileId?: string
}
```

同一 `jobId + revision` 是幂等键。机械版本先落，模型版本后落；重试不得重复追加同一版本。

抽出唯一 `selectCompactionSummary(events)`，供 render、handoff、replay 与诊断共同使用：

1. 先取最大的 `coveredUpToSeq`，遮蔽点不得回退。
2. 同覆盖范围取日志中最后一条有效摘要；同一任务内 revision 必须单调。
3. 缺新字段的旧摘要按普通有效摘要参与选择，保持原回放行为。
4. 迟到的较小覆盖摘要可以留作审计，但不能重新成为当前摘要。
5. `seq > coveredUpToSeq` 的消息始终按原文渲染，摘要完成与否不改变这一条。

因此无需把模型摘要“合并进”新对话，也不会注入两份同覆盖摘要。原始事件永不改写。

模型摘要为空、超时、超预算或校验失败时，写 `compaction/job{phase:'failed'}`；新 Profile 不回滚，继续使用机械摘要与原文。只有配置 / 插件装配本身失败才在激活前终止切换并保留旧 Profile。

## 7. 恢复与一致性

追加 `compaction/job` 阶段事件：`queued` / `running` / `completed` / `failed` / `cancelled`。`completed` 必须与对应摘要形成可核对的关系。

恢复时：

- `staged` 候选可重新从盘上配置与不可变插件版本重建。
- `switch-requested` 未激活：若原 turn 已结算，重新计算同一切点并继续；不得重复激活。
- 已激活、任务未完成：可按同一 job 继续或标为可重试；重复结果由幂等键吸收。
- 模型请求已发出但结果未知：按现有“未知不猜”原则处理，不盲目产生第二份摘要。
- 所有内部事件默认 `internal`，不进入模型可见历史。
- 进程字段仍需重启时，Profile 恢复以事件和盘上不可变插件版本为准，不能因当前插件目录已升级而重建出另一份提示词。

回滚是“用旧 ProfileSpec 创建一次新的前向切换”，不是回滚事件日志。

## 8. 缓存影响分类

候选生成时比较新旧 Profile 的请求签名，返回：

- `compatible`：已证明不改变请求前缀与模型路由。
- `prefix-breaking`：模型、系统提示词、人格、工具 schema 或冻结索引改变。
- `unknown`：无法证明兼容，按可能失效展示。

禁止把“进程未重启”显示成“缓存已保留”。压缩本身也是上下文变化。界面可显示“会话保留；缓存将重建 / 可能保留”，不展示未实测的节省比例。

## 9. 统一插件包

### 9.1 清单

每个目录含 `plugin.json`：

```json
{
  "apiVersion": 1,
  "id": "example-plugin",
  "version": "1.0.0",
  "engine": { "irmia": ">=0.1.0-beta.12" },
  "contributions": {
    "skills": ["skills"],
    "hooks": "hooks.json",
    "mcp": "mcp.json",
    "prompts": [{ "id": "style", "path": "prompts/style.md", "priority": 100 }],
    "persona": [{ "path": "persona/overlay.md", "mode": "overlay" }],
    "providers": [{ "id": "local", "protocol": "chat-completions", "baseUrl": "http://127.0.0.1:1234", "secretRef": null }],
    "ui": [{ "id": "status", "slot": "page", "definition": "ui/status.json" }]
  },
  "permissions": []
}
```

实际解析器使用严格白名单，未知必填能力拒绝加载；未知可选元数据可保留但不执行。包路径禁止越界与符号链接逃逸，并设置文件数、单文件与总大小限制。

### 9.2 信任与版本

复用 Skill 的方向：安装、升级、内容变化都需人类确认，信任绑定整包内容 hash。增加 `plugin/installed`、`plugin/enabled`、`plugin/disabled`、`plugin/failed` 事件；启停只形成候选，最终由 `profile/activated` 固定生效集合。

旧版本不可被升级静默覆盖。提示词等进入请求的插件素材，要么以不可变内容寻址资产保留，要么在激活时把确切渲染快照写入 `plugin/index` 事件；回放不得依赖“当前插件目录恰好还是旧版”。

提示词按 `priority → pluginId → segmentId` 排序，设置单项与总 token 硬预算。`pluginSetHash` 进入 Profile 和 render 指纹。

人格插件第一版只支持 overlay 或 proposal；不能直接覆盖核心 IDENTITY / CONSTITUTION。overlay 的优先级、冲突顺序与撤回语义必须确定性定义。

### 9.3 工具与 Hook

工具只通过 MCP 提供，暂不做第二套 in-process 工具 SDK。MCP 的 launcher 白名单、超时、副作用、预算、日志与进程回收继续生效。

Hook 使用现有三执行点，不增加任意宿主对象访问。插件配置目录纳入 agent 只读保护。

停用插件只影响新 Profile；旧 turn 的在飞调用完成后再回收对应 worker。若未来支持 per-profile 共用 MCP 池，连接键需包含 Profile / 插件版本，不能误复用另一版本的进程。

### 9.4 模型 provider

第一版只支持声明式 `baseUrl + protocol + model + secretRef`，复用 Responses / Chat Completions。provider 插件仍通过 Profile 切换，不绕过模型预算与审计。自定义流式 driver 后续以进程外协议另案设计。

### 9.5 声明式 UI

把 `PageEntry` 抽成内置与插件共享的注册描述，但插件只能提供受限 schema：

- 页面、设置表单项、状态 / 文本 / 列表 / 指标、聊天消息侧卡。
- 聊天侧卡只能追加展示，不能改写原始消息。
- 动作必须声明目标插件、MCP 工具与参数 schema；由 `PluginCommandRouter` 以 human / owner 场景调用。
- 路由校验插件归属、参数、权限和危险确认，记录 `plugin/command` 与结果；不允许任意 URL、任意 API 路径或任意进程命令。

第一版 UI 数据通过宿主插件 API 获取，Flutter 负责 schema 校验、错误态与版本不兼容占位。任意 Dart、远程模块和 WebView 插件均不在本版。

### 9.6 故障熔断与半开恢复（P0，用户补充）

插件需要自动隔离系统性故障，但不能把一次普通失败当成整个插件不可用。熔断以减少故障风暴为目标，不承诺绝对流畅或替插件判断业务成败。

- 计数键为 `pluginId + contentHash + contributionKind + contributionName`；同一贡献项连续 3 次系统性失败才隔离整个插件。成功只重置该贡献项的连续计数。
- 系统性失败包括 MCP 启动失败、协议错误、进程崩溃与连续超时，以及 Hook 的执行错误 / 超时。MCP 工具自己返回的业务 `isError`、参数错误、用户拒绝、过载和主动取消不计入。
- 包内容非法仍属 `invalid`，不靠反复熔断修复；未确认和人工禁用也不进入自动恢复。
- `plugin/quarantined` 先落 internal 事件，再在 turn 边界移除该插件的 Skill roots、Hook entries 与 MCP declarations。当前在途调用沿用现有收尾 / 超时纪律，不为统一切换强行制造第二个取消路径。
- 冷却从 30 秒开始，连续失败指数退避，上限 15 分钟。重启后由事件恢复剩余冷却，不重置故障账。
- 冷却结束进入 `probing`，同一插件至多一个半开探测。Skill 重扫、Hook 配置重解析；MCP 用真实 `listTools` 探测。不得为探测执行有副作用的 Hook；Hook-only 插件把下一次真实调用作为唯一半开探测。
- 探测全部必要条件成功后写 `plugin/recovered`，在 turn 边界恢复贡献；失败写新的 `plugin/quarantined` 并进入下一档冷却。`plugin/probe-started` 防止重启或并发造成多个半开探测。
- 熔断状态是运行期安全状态，不等于人工 `plugin/disabled`。人工启停仍沿用 P0 的重启后生效语义；自动隔离与恢复不声称已经实现通用 Profile 热切换。
- API / GUI 展示隔离原因、失败贡献项、连续次数、下次探测时间与探测中状态，不能只显示一个无解释的 disabled。

新增 internal 事件 `plugin/quarantined`、`plugin/probe-started`、`plugin/recovered`，包含插件 id/hash、贡献项、故障类别、次数与适用的时间字段；不得记录密钥或完整敏感进程环境。

## 10. API 与 GUI

新增或扩展：

- `GET /api/runtime/profile`：active、staged、切换状态、压缩任务、缓存影响。
- `POST /api/commands/profile-activate`：按 changeId 激活，幂等。
- `POST /api/commands/profile-discard`：丢弃未激活候选。
- `GET /api/plugins`：版本、贡献、信任、状态与待生效差异。
- 插件安装 / 启停命令：只负责 staging，不声称已经生效。

配置保存回执按 `live` / `profile` / `process` 三部分分别返回结果；Profile 部分附 changeId。三类可在同一次保存中并存，不再用单一枚举或含义混杂的“已保存但需重启”覆盖所有情况。

设置页与扩展页复用同一待生效条：

- “有更改待生效”按钮。
- `waiting-turn`：显示等待当前轮结束。
- 激活后：显示“已切换；语义整理进行中 / 完成 / 失败，机械摘要可用”。
- 激活前说明会额外发起一次旧模型压缩请求及其预算 lane，并展示缓存影响；第一版不预估 token 或金额，也不要求 provider 提供定价元数据。
- 失败提供重试摘要或继续当前状态，不强迫回滚。

GUI 通过现有 SSE / 状态刷新读取状态，不另建一份本地事务状态。

## 11. 安全边界

- Profile、插件和 UI 动作不改变现有 owner / guest 鉴权方向；人类 UI 动作也不得借插件绕过危险确认。
- 进程外只提供崩溃隔离，不是安全沙箱。MCP、Hook、未来 worker 都是受信任代码。
- 密钥经宿主 broker 解析；插件清单、事件、UI 与日志不含明文。
- provider 的新端点、通道外传与危险工具仍需要明确授权。
- 插件包、prompt、UI schema、provider 与 MCP 声明都进行大小、路径和结构校验。
- 插件申请权限只是声明；真正的边界必须在宿主调用点执行。

## 12. 分阶段交付

用户已调整优先级：**先做插件系统，热切换随后接入**。插件前几阶段沿用当时的重启 / 即时生效语义，不得为了等待 Profile 而搁置，也不得提前声称插件启停已经无重启。

### P0：统一插件底座（优先）

接入插件清单、发现、严格校验、信任、不可变版本与 Skill / Hook / MCP 贡献。先把现有能力组合成真正可安装、可审查、可启停的插件包；此阶段沿用现有生效语义。

### P1：提示词、人格、声明式 UI 与 provider

增加 prompt / persona 贡献及确切素材快照，随后增加页面 / 聊天侧卡 schema、PluginCommandRouter 和模型 provider 预设。需要 Profile 才能保证的语义先明确标为重启后生效。

### P2：Profile 与机械切换

实现字段策略、不可变 Profile、turn 绑定、staging / activation、机械摘要、事件与恢复，并把插件启停接入同一事务。

### P3：旧模型异步摘要

增加 CompactionService、摘要版本选择、迟到结果、失败降级、旧客户端生命周期与 GUI 状态。

### P4：自定义模型与通道 worker

另案定义流式协议、背压、幂等、媒体与安全边界，不在前序阶段隐含承诺。

## 13. 验收与测试

至少覆盖：

1. 保存后旧 Profile 不变；激活后新 turn 才使用新配置。
2. turn 中请求激活，所有 step 仍使用旧 Profile。
3. 重复保存、重复点击、旧 changeId、候选被取代均幂等或明确拒绝。
4. 机械摘要未生成 / 模型摘要失败时仍能切换，历史原文不丢。
5. 模型摘要迟到只替换同覆盖段；切换后的用户与助手原文仍在。
6. 两个切点乱序完成时，小覆盖摘要不能遮蔽大覆盖摘要。
7. 在每个阶段崩溃恢复，不产生重复激活、重复摘要或重复副作用。
8. 旧模型压缩计账、无工具、旧密钥不泄露，旧客户端在任务结束后才回收。
9. 老日志没有新摘要字段时，render / replay 结果保持兼容。
10. 缓存影响分类与实际请求签名一致，不宣称必然保缓存。
11. 未知配置字段默认 process；现有 live 字段行为不回退。
12. 插件未确认、hash 变化、路径逃逸、超预算与未知能力均被拒绝。
13. 插件提示词顺序与 Profile hash 确定；升级后旧 Profile / replay 仍取得旧素材。
14. 插件停用不打断旧 turn；后续 turn 不再看到新贡献。
15. UI 插件不能执行任意 API / Dart；动作越权、参数错误与危险确认有测试。
16. 标准 `npx tsc --noEmit`、`npm test`、`flutter analyze`、`flutter test` 全部通过，并增加一次真实旧模型切换验收。

## 14. 文档与兼容义务

实现时同步更新 `ARCHITECTURE.md`、README 配置说明、CHANGELOG 和相关源码旧注释，尤其删除“MCP 唯一自动热更字段”与“模型必须重启”的旧口径。事件 schema、render 版本与指纹规则需要按实际请求字节变化升级，不能只改 UI 文案。
