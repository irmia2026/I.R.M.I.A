---
name: plugin-dev
description: 写 Irmia 插件包的手册：plugin.json 清单字段、三类贡献（技能/Skill、执行点钩子、MCP 服务）各自的落地形态、整包哈希与「未信任 → 审核 → 启用」状态机、Hook 的 stdin 载荷与 stdout 决定、当前实现的已知坑。用户要写插件、改插件、打包给朋友、或插件装上不生效时读它。
version: 1.0.0
authors:
  - Irmia Agent Framework
---

## Overview

**插件 = 一个目录 + 一份 `plugin.json`**，往框架里加三类能力之一或全部：

| 贡献 | 实际是什么 | 跑在哪 |
|---|---|---|
| `skills` | 若干 `SKILL.md`（你平时读的那种技能） | 框架内，只读 |
| `hooks` | 一个 JSON，声明 shell 命令在 `PreToolUse` / `PostToolUse` / `Wake` 三处被调用 | **子进程**（系统 shell） |
| `mcp` | 一个 JSON，声明 MCP 服务 | **子进程**（stdio） |

三条硬事实，先说在前面（很多人第一反应都会问）：

1. **没有 JS 运行时 API。** 不存在「在框架进程里 require 一段代码」这条路，`src/plugin/` 里也没有给插件的 SDK。插件的一切行为都发生在**你自己起的进程**里，通过 stdin/stdout 与框架对话。
2. **`permissions` 现在只是声明，不做任何强制。** 字段必填（可以写 `[]`），但代码里没有任何执行点去检查它。⇒ **不要对用户承诺权限会被拦住**；要描述成「给人看的声明，提醒安装者这插件想干什么」。
3. **安装 ≠ 信任 ≠ 生效。** 三个动作分开：安装只落盘，审核（确认整包哈希）才授信，启用后还要**重启**才真正装配。

## Trigger

出现下列任一情形，读这份技能：

1. 用户说「写个插件」「给框架加个 hook」「接一个 MCP 服务进插件」
2. 要打包一个插件目录发给别人
3. 插件装上了但 Skill 不出现 / hook 不触发 / MCP 工具调不到
4. 要解释「为什么装完还要重启」「为什么改了文件又变回未信任」
5. 想知道某个能力（权限、卸载、热重载）到底有没有实现 —— 先看 §8，别凭直觉答

## 1. 目录长什么样

```
my-plugin/
├── plugin.json          ← 唯一强制文件
├── hooks.json           ← 可选，名字随意，由清单指向
├── mcp.json             ← 可选，名字随意，由清单指向
├── skills/              ← 可选，作为「技能根」被声明
│   └── companion/
│       └── SKILL.md
└── 其它任何文件/子目录   ← 允许，随便放
```

约束（`src/plugin/package-store.ts`）：

| 项 | 限制 |
|---|---|
| 文件数 | ≤ **256** |
| 单文件 | ≤ **1 MiB** |
| 整包 | ≤ **8 MiB** |
| 符号链接、非常规文件 | 拒绝 |
| 落盘位置 | `<data>/plugins/packages/<id>/<整包哈希>/` |

路径一律**包内相对 POSIX 路径**：`skills` 而不是 `skills\`，不许 `..`、不许绝对路径、不许结尾带 `/`。写错会被拒：`expected a relative POSIX path` / `path escapes the package`。

## 2. `plugin.json` 字段表

**字段是白名单**：多写一个键就整包报废（`unsupported field xxx`）。**没有** `name` / `description` / `author` / `main` / `dependencies` 这些字段 —— 想写说明，写进 README，或写进技能的 `description`。

| 字段 | 类型 | 必填 | 取值 |
|---|---|---|---|
| `apiVersion` | 数字 `1` | ✅ | 只能是 `1`（将来才谈 2） |
| `id` | string | ✅ | `^[a-z0-9-]{1,64}$`，小写字母/数字/连字符 |
| `version` | string | ✅ | 严格 SemVer，如 `1.0.0`、`0.2.1-beta.1`；**不接受** `1.0.0+build` |
| `engine.irmia` | string | ✅ | `>=0.1.0-beta.13` 或精确 `0.1.0-beta.13`（见 §4） |
| `contributions.skills` | string[] | ✅ | 技能根目录列表，可为 `[]` |
| `contributions.hooks` | string | ❌ | 单个 JSON 的相对路径 |
| `contributions.mcp` | string | ❌ | 单个 JSON 的相对路径 |
| `permissions` | string[] | ✅ | 任意非空字符串；可为 `[]`（当前不强制，见 Overview） |

最小可用：

```json
{
  "apiVersion": 1,
  "id": "memory-friend",
  "version": "1.0.0",
  "engine": { "irmia": ">=0.1.0-beta.13" },
  "contributions": { "skills": [] },
  "permissions": []
}
```

## 3. 三类贡献分别怎么落地

### 3.1 `skills`：技能根

`contributions.skills` 里每一项是一个**目录**，目录下每个子目录是一个技能：

```
skills-field/            ← 清单里写 "skills"
└── companion/           ← 技能名
    └── SKILL.md         ← 必须叫这个名字
```

`SKILL.md` 的 frontmatter 必须有 `name` 与 `description`，且 **`name` 必须和目录名一致**（不一致会被列进 rejected）。正文写操作手册，跟内置技能同样的口径。

两条行为要知道：

- **同名时内置技能胜出**，插件那份被忽略并告警。给自己的技能起个不容易撞的名字。
- 插件技能目录是**只读**的（写入要用户来），别指望它自己改自己。

### 3.2 `hooks`：执行点钩子

清单里的 `hooks` 指向一个 JSON，形如 `[ {...}, {...} ]`（也接受 `{"hooks":[...]}`）。每条：

| 字段 | 必填 | 说明 |
|---|---|---|
| `hook` | ✅ | `PreToolUse` / `PostToolUse` / `Wake` |
| `matcher` | ✅ | 非空**正则**。前两者匹配工具名（`Edit|Write`），`Wake` 匹配唤醒来源（`timer` / `file` / `webhook` / `manual` / `heartbeat` / `intention` / `job`） |
| `command` | ✅ | shell 命令串，交给系统 shell 跑 |
| `if` | ❌ | 入参过滤，形如 `Bash(rm *)`；不匹配就**不 fork** |
| `timeoutMs` | ❌ | 单条超时，默认 **10000**；超时杀进程树、丢弃输出 |
| `cwd` | ❌ | 相对**包根**；逃出包根整条被丢弃 |
| `enabled` | ❌ | `false` 保留但不装配 |

**框架往子进程 stdin 写一段 JSON**（要读就用 `JSON.parse` 读 stdin，别假设没有输入）：

```json
{
  "hook": "PreToolUse", "ts": "2026-10-25T07:00:00.000Z", "cwd": "<包根绝对路径>",
  "projection": { "lastSeq": 12, "openTurn": null, "pendingCount": 0, "stepsThisTurn": 0,
                  "tokensToday": 8000, "todoOpen": 0, "failStreak": 0,
                  "idleTicks": 0, "pressure": "normal", "degraded": false },
  "callId": "…", "tool": "Bash", "input": { "command": "ls" }
}
```

`PostToolUse` 多一个 `result: {status, isError, content, durationMs}`；`Wake` 用 `wake: {text, sources[]}` 代替工具三件套。

**你的 stdout 就是决定**（打印一行 JSON；不打 = 不干预）：

```json
{ "permissionDecision": "deny", "permissionDecisionReason": "这条命令会删库",
  "additionalContext": "补充给模型的说明", "systemMessage": "给用户看的一句话" }
```

- `permissionDecision`：`allow` / `deny` / `ask`（只有 `PreToolUse` 有意义）
- 退出码：`0` = 无决定；`2` = 阻塞/拒绝；**其它（含 1）算非阻塞错误**，不会拦住工具
- 注入文本（`additionalContext`）上限 **10000 字符**，超了截断

### 3.3 `mcp`：MCP 服务

清单里的 `mcp` 指向一个 JSON **数组**，每项一个服务：

```json
[{ "name": "chat", "command": "node", "args": ["server.mjs"], "desc": "站内聊天" }]
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | `^[A-Za-z0-9_-]{1,128}$`；真正进索引会变成 **`<插件id>__<name>`** |
| `command` | ✅ | 非空字符串 |
| `args` / `env` / `disabled` / `requestTimeoutMs` / `maxInFlight` / `tools` | ❌ | 与普通 MCP 配置同义 |
| `cwd` | ❌ | 缺省包根；不许逃出包根 |

注意：合并后的名字超过 128 字符会被丢；重名后者忽略。并发上限默认 4，串行请求默认 120 s 超时。

## 4. 版本约束 `engine.irmia`

只支持两种写法，其它一律报 `Invalid engine requirement`：

| 写法 | 含义 |
|---|---|
| `>=0.1.0-beta.13` | 当前版本 ≥ 它（推荐，跨版本活） |
| `0.1.0-beta.13` | **必须精确等于**（内测期别这么写） |

`^`、`~`、`*`、`||` 都不支持。比较对象是框架自身的 `AGENT_VERSION`，不满足时安装/扫描阶段报：

```
Plugin <id> requires Irmia <要求>; current version is <当前>
```

## 5. 整包哈希与状态机

**哈希怎么算**：`sha256`，把包内**全部文件**按相对路径的**码点序**排序，逐个 `update(相对路径)` + `update('\0')` + `update(文件字节)`，输出 64 位小写 hex。改任何一个字节 ⇒ 换哈希。

两个容易踩的点：

- **排序必须是码点序**（`a < b`），不是 `localeCompare`：后者随 locale 与 Node/ICU 版本变，同一只包在不同机器上会算出不同哈希，已信任的包会被打成 `invalid`。
- **哈希只含路径与内容字节，不含文件权限位**：Linux 上 `chmod +x` 不改变哈希（Windows 本来也没这层）。

自己算一遍（装之前核对用）：

```js
// node hash.mjs <插件目录>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
const root = process.argv[2];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(relative(root, full).split(sep).join('/'));
  }
};
walk(root);
files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 码点序：别用 localeCompare，排序会影响哈希
const h = createHash('sha256');
for (const rel of files) { h.update(rel); h.update('\0'); h.update(readFileSync(join(root, rel))); }
console.log(h.digest('hex'));
```

**状态机**（装、审核、启用是三件事，别混）：

| 状态 | 怎么到这 | 下一步 |
|---|---|---|
| `untrusted` | 刚装完；或**内容/版本变了**（新哈希） | 审核确认哈希 → `disabled` |
| `disabled` | 已确认，未启用 | 启用 → `enabled` |
| `enabled` | 生效中 | 停用；连续出系统性故障 → `quarantined` |
| `quarantined` | 同一**贡献**连续 3 次系统性失败 | 等 30 s 进 `probing`，成功一次恢复 |
| `probing` | 半开探测 | 成功 → `enabled`；再失败按 `30s × 2ⁿ`（上限 900 s）退避 |
| `invalid` | 扫描失败、内容被篡改、id 对不上 | 不进 active，只能重装 |

要讲清楚的三点：

- **改了内容 = 新哈希 = 回到 `untrusted`**，旧信任不继承。这就是「我只是改了个 SKILL.md 怎么又要审一遍」的答案。
- 启用/停用都返回 `restartRequired: true` —— **要重启才装配**。
- 只算**系统性失败**（起不来、协议错、崩溃、超时、hook 报错）；业务错误、参数错、被拒绝这些**不计**熔断。

## 6. 装进实例：界面怎么走

1. 把插件目录放到某处（**绝对路径**，不要在包库里，否则拒装）
2. 打开界面 →「扩展」页 → Plugins 区 → **安装**，填绝对路径
3. 卡片出现，状态 `untrusted`；核对 **版本 · 哈希**、`Skills / Hooks / MCP` 三个计数、权限列表
4. **审核**（确认整包哈希）→ `disabled`
5. **启用** → `enabled`，徽章提示「重启后生效」
6. 重启实例 → 技能出现在技能清单、hook 开始触发、MCP 工具进索引

对应的四条服务端命令都要求确认头（等价于界面上那几次确认）：`plugin-install` / `plugin-confirm` / `plugin-enable` / `plugin-disable`，值就是命令名本身，**短语不对或缺失返回 `400 confirm-required`**。

## 7. 出问题先看哪里

| 现象 | 先查 |
|---|---|
| 卡片 `invalid` + 红字 | 清单字段（多半是多写了一个键或路径带了 `\`）、体积超限、符号链接 |
| 技能不出现 | `contributions.skills` 路径对不对；`SKILL.md` 的 `name` 与目录名是否同名；是否撞了内置技能名 |
| hook 不触发 | `matcher` 是正则不是通配；`if` 是否把条目滤掉了；`enabled` 是不是 `false`；`cwd` 是否逃出包根 |
| hook 触发了但没拦住 | 退出码写成了 `1`（非阻塞）；应 `exit 2` 或输出 `permissionDecision: "deny"` |
| MCP 工具调不到 | 合并名是 `<插件id>__<name>`；名字超 128 或重名被丢；`command` 是否真能执行 |
| 状态反复 `quarantined` | 看卡片上的 `kind/name` + `lastError`；起不来的进程要自己先手工跑通 |
| 装完没反应 | 是不是没重启；是不是状态还停在 `disabled` |

## 8. 已知坑（写文档、给承诺之前必读）

1. **`permissions` 不强制**：只有形状校验，没有枚举、没有执行点。描述成「声明」而非「沙箱」。
2. **没有卸载/更新命令**：只有 install/confirm/enable/disable。换新版等于装一个新哈希目录，**旧目录会留着**并继续出现在列表里。
3. **`hooks` / `mcp` 各只能一个文件**，不能 inline、不能数组里塞多份路径。要多份就合并进一个 JSON。
4. **精确版本约束在解析阶段不校验**（解析时拿 `0.0.0` 比了一次且丢弃结果），只在安装/扫描时被真正拦下 —— 报错位置可能比你预期的晚一步。
5. **重启后 `probing` 徽章不会出现**：探针状态只在内存里，折叠事件时写回的是 `quarantined`。
6. **界面上的「连续失败 N 次」是累计值**，不是严格连续计数 —— 别拿它做精确诊断。

## 9. 交付前的自检清单

- [ ] `plugin.json` 六个键齐全，没有多余键
- [ ] `id` 全小写、只含 `-`/数字/字母，≤64
- [ ] `version` 是纯 SemVer，没有 `+build`
- [ ] `engine.irmia` 用 `>=` 且 ≥ 目标实例的版本
- [ ] 所有路径都是包内相对 POSIX 路径，无 `\`、无 `..`、无绝对路径
- [ ] 文件数 ≤256、单文件 ≤1 MiB、合计 ≤8 MiB
- [ ] `skills` 里每个根下都有 `<name>/SKILL.md`，`name` 与目录同名
- [ ] `hooks.json` 每条都有 `hook`/`matcher`/`command`；`matcher` 是合法正则
- [ ] `mcp.json` 是数组，每项 `name` 合规、`command` 能真跑起来
- [ ] 本地先算过哈希，装完界面上的哈希与它一致
- [ ] 目录里放了 README，写清「这个插件要做什么、会起什么进程」——清单里没有 description 字段，这是唯一的说明位
