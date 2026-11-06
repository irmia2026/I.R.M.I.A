# Adapter Framework RFC

- 状态：设计草案；本文定义目标契约，不表示全部已实现。
- 范围：外部消息平台与宿主运行时之间的适配层；不替代插件包、模型、工具或 Profile。
- 原则：平台差异在边界归一化，策略判断由宿主完成，副作用须经宿主授权并留审计。

## 1. 分层与调用流

```text
Platform SDK / Transport
        │ 原始事件、确认、发送
Adapter（平台映射与生命周期）
        │ EventView / MessagePlan
Ingress + Policy + Runtime（宿主）
        │ CapabilityBroker 授权后的 Effect
Effect Dispatcher（预算、确认、执行、审计）
        └──────── Adapter outbound ────────► Platform
```

1. **Transport**：持有平台连接与凭据，处理重连、限流和平台 ACK；不得决定 Agent 权限。
2. **Adapter**：把平台事件转换为规范 `EventView`，并将已授权的 `Effect` 翻译成平台请求。不得绕开宿主直接调用 Agent 工具或写宿主状态。
3. **Ingress / Runtime**：按事件来源、会话及策略建立 turn，生成 `MessagePlan`。同一输入契约不因平台 SDK 类型而分叉。
4. **Policy / CapabilityBroker**：对每项能力做授权；拒绝优先。能力不是适配器声明了就自动可用。
5. **Dispatcher / Audit**：校验计划、执行确认与预算、调用适配器，并记录请求、决策、结果及失败。事件日志仍是运行事实的唯一真相源。

适配器实例按 `adapterId + accountId` 隔离运行态；凭据由宿主凭据存储以引用注入，不放入 manifest、EventView、MessagePlan 或普通日志。

## 2. EventView、Capability 与 Effect

### EventView

`EventView` 是不可变、平台无关的入站快照，至少含 `eventId`、`adapterId`、`accountId`、`conversationId`、`sender`、`occurredAt`、`receivedAt`、消息段、`replyTo` 与有限的来源元数据。消息段使用受限联合类型（文本、图片/文件引用、平台引用等）；二进制负载外置并以宿主受保护的引用表示。原始平台对象不得透传给模型或插件。归一化应确定性、可版本化，缺失或不支持的字段明确标记，不猜测补齐。

重复投递用平台事件标识及适配器命名空间做幂等去重；没有稳定事件标识的平台必须提供明确的降级策略，不得假称 exactly-once。

### Capability

能力是宿主定义的细粒度动作/数据类别（例如 `message.read`、`message.send`、`media.read`、`conversation.metadata.read`），带资源范围、适用场景和危险等级。Adapter 与插件只能声明需求及可处理事件类型；声明不是授权，也不应自行扩展能力词汇。

每次调用按以下集合求交：

```text
effective = requested ∩ manifestDeclared ∩ userGranted ∩ hostPolicy ∩ contextAllowed
```

任一层缺项即拒绝；拒绝和降级都要有可解释的审计决策。平台账号范围、会话范围、owner/guest、危险确认、预算及全局关闭开关均由宿主 policy 收紧，适配器不能提升权限。

**现状限制：**当前插件 `manifest` 是 `apiVersion: 1`，`permissions` 仅作为字符串数组严格解析和保存，尚未接入 policy / CapabilityBroker，不构成授权、拒绝或沙箱。任何 UI 文案不得将其显示为已生效的权限控制。

### Effect

`Effect` 是宿主可校验的副作用意图，不是自由执行代码。初始种类限于 `message.send`、`message.reply`、`reaction.set` 等明确 schema 的平台动作；每项包含目标会话、结构化参数、来源事件/turn、幂等键及所需 Capability。Dispatcher 重新检查权限、目标归属、危险确认和预算后才执行。未知 effect 必须拒绝；执行结果分为成功、拒绝、失败、结果未知，不能把超时推断成未执行。

Adapter 只负责把已经授权的 effect 映射到平台 API；不得在接收事件时暗中回复、调用任意 URL、启动命令或修改宿主事件日志。

## 3. MessagePlan 契约

Runtime 对一次输入产出不可变 `MessagePlan`：`planId`、`sourceEventId`、`conversationId`、按序排列的输出片段/Effect、使用的 Capability、确认要求、预算上限及策略/渲染版本。计划可以是空计划（沉默）；它不是执行成功的证明。

生成阶段只提出意图；Dispatcher 在执行前逐项校验并写入计划/授权决定，执行后再记录每项回执。部分失败不得伪装成整体成功；重试须沿用幂等键并遵守副作用等级。回放使用已记录的计划和结果，不重新执行未知副作用。Adapter 可以报告平台回执，但不能改写原始 EventView 或已提交的审计事实。

## 4. Manifest v2（目标）

v2 是适配器贡献契约的版本，不等于现有插件 manifest。示意结构：

```json
{
  "apiVersion": 2,
  "id": "example-adapter",
  "version": "1.0.0",
  "engine": { "irmia": ">=0.1.0" },
  "adapter": {
    "protocol": "irmia.adapter.v1",
    "entry": "adapter.json",
    "events": ["message.created"],
    "capabilities": ["message.read", "message.send"]
  },
  "permissions": ["message.read", "message.send"],
  "configSchema": "config.schema.json"
}
```

解析器采用严格白名单与版本协商；拒绝未知必需能力、路径越界、符号链接逃逸、重复 id、超限包及不兼容 engine。可选元数据可保留但不执行。版本化文件须不可变、按内容 hash 信任；升级后重新审查和确认。Secret 只允许引用宿主已配置的凭据项，不允许清单内嵌明文。v1 插件（Skills/Hooks/MCP）继续按 v1 解释；不得把当前 v1 `permissions` 字段悄然升级为 v2 权限语义。

## 5. 同步/异步边界

- **同步、纯函数**：manifest/schema 校验、EventView 归一化、能力集合求交、MessagePlan 结构与目标校验、幂等键计算。不得做网络、文件写入或等待用户确认。
- **异步 I/O**：平台连接、入站确认、发送/编辑消息、媒体读取、探活及安装扫描。每个调用需有 timeout、AbortSignal、并发/速率上限和明确结果状态；进程退出要关闭连接与计时器。
- 入站先完成结构校验并落宿主事件事实，再 ACK（平台协议要求先 ACK 时须记录可恢复的 pending 状态）。ACK 丢失可能导致重投，依靠幂等处理而非声称 exactly-once。
- turn 使用固定的策略/配置快照；运行中的 EventView 或 MessagePlan 不因配置切换而被中途改写。未完成的破坏性动作在重启恢复时记为 `unknown` 并待确认，不自动重放。

## 6. 安全禁止项

- 禁止在宿主进程内动态 `import()` 第三方适配器代码；禁止将任意 Dart/JavaScript、WebView 或远程模块当作插件 UI/逻辑执行。
- 禁止把进程隔离描述成安全沙箱；MCP、Hook 及未来 adapter worker 仍是受信任代码，除非另行实现并验证强隔离。
- 禁止传递原始 SDK 对象、明文凭据、完整敏感环境、未筛选私聊/群成员数据给模型、插件或日志。
- 禁止适配器自行访问任意 API/URL、命令行、宿主文件、数据库或危险工具；必须通过受限 Effect 与宿主 dispatcher。
- 禁止以 manifest 请求、插件确认或安装成功替代能力授权；不得绕过 owner/guest、危险确认、保护路径、预算及速率限制。
- 禁止模糊 ACK、超时及失败语义；禁止没有幂等策略地重放可能已执行的副作用。

## 7. 熔断与审计

熔断按 `adapterId + packageHash + operation` 归因，只计连接建立失败、协议损坏、进程崩溃及可判定的系统性超时；用户拒绝、无权限、无效输入、平台业务拒绝、过载和主动取消不计为适配器故障。达到阈值后先写内部隔离事件，再在安全边界停止该适配器的新事件/Effect；冷却后只允许单个半开探测，并记录探测开始、结果、恢复或再次隔离。状态由事件恢复，不能因重启清零。

审计至少记录 package hash、事件/计划/turn 关联 id、能力请求与授权决定、执行类别、耗时、结果/未知状态、熔断计数与恢复时间；敏感内容采用受保护引用或脱敏摘要，绝不记密钥及完整敏感环境。审计写入失败时拒绝新的外部副作用，避免无账执行。

## 8. P0 → P2 路线

- **P0：统一插件底座与安全边界。** 先完成 v1 包的发现、严格校验、不可变 hash、人工信任，以及 Skills/Hooks/MCP 组合、隔离和回归兼容；保持现有行为，不宣称通用 Runtime Profile 热切换或 permissions 策略已落地。适配器规范可先落为接口与契约测试，不扩大 P0 的可执行贡献面。
- **P1：适配器与声明式贡献。** 引入 EventView/MessagePlan/Capability/Effect 类型、Adapter 生命周期协议、v2 manifest 校验与迁移策略；接入首批平台适配器，建立能力 broker、Effect dispatcher、幂等、审计、超时和熔断。v2 权限在宿主调用点强制执行后才可称为有效。其他 prompt/persona、声明式 UI 与 provider 依各自安全评审逐项接入，不开放任意代码。
- **P2：统一 Profile 与机械应用。** 将适配器集合、授权策略和插件集合纳入不可变 Runtime Profile；turn 固定 profileId，变更先 staging，在 turn 边界原子应用并可崩溃恢复。插件/适配器启停共享同一激活事务；旧 turn 收尾后回收资源。审计记录候选、激活/拒绝与实际生效版本。异步语义摘要、自定义传输/通道 worker 不因 P2 自动包含，须单独设计。

## 9. 当前实现口径

当前适配器框架仍属设计目标。现有插件平台的 P0 清单为 `apiVersion: 1`，贡献类型是 Skills、Hooks、MCP，且权限字符串未接 policy。插件 enable/disable 在注入了宿主 `apply` 回调时可尝试热重组装；未注入时保持 `requiresRestart`，即重启后生效语义。热应用失败会恢复先前已装配态并回报 `applyError`，不能报告为已生效。此可选热 apply 不是通用 Profile 热切换，也不改变上述权限现状。

## 参考

- `docs/ARCHITECTURE.md`：事件日志、危险能力默认关闭及运行时边界。
- `docs/superpowers/plans/2026-10-24-plugin-platform-p0.md`：P0 实施约束与验收。
- `docs/superpowers/specs/2026-10-24-runtime-profile-hot-switch-plugin-design.md`：插件与 Profile 分阶段草案。
