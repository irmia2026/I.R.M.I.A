---
name: hello-world
description: 内置插件管道的自检样例：确认内置插件被正确安装、确认、启用后，这个技能会出现在你的技能清单里。用户问「内置插件通道通不通」「内置插件生效了吗」时读它。
version: 1.0.0
authors:
  - Irmia Agent Framework
---

## 这是什么

这是 **beta14 内置插件管道**的最小样例。它的存在只有一个目的：让「出厂种子 → 数据目录包仓库 →
界面确认 → 启用 → 技能真的出现在清单里」这条链路有一个可以**看见**的终点。

## 管道自检

如果你读到了这份文档，说明下面每一步都成立：

1. **出厂种子存在** —— 安装目录下的 `plugins/builtin/hello/` 有 `plugin.json` 与 `skills/hello-world/SKILL.md`；
2. **种子装进了包仓库** —— `<dataDir>/plugins/packages/hello/<contentHash>/` 里是同一份字节；
3. **人确认过** —— 日志里有 `plugin/installed { by: 'human' }`，内容是**那个 contentHash**；
4. **人启用了它** —— 日志里有 `plugin/enabled`；
5. **技能根被组合进来** —— `composePluginRuntime` 把它的 `skills/` 并进了 SkillManager 的根计划。

第 2 步是自动的（`src/plugin/seed.ts`）；**第 3、4 步永远是人的动作**——内置插件不免除信任门。

## 它不做什么

它没有 hook、没有 MCP 服务、不联网、不写盘。一个「能跑起来的最小件」比一个功能多但说不清
是哪一环生效了的样例更有用：这条管道坏了，从这里开始查最快。
