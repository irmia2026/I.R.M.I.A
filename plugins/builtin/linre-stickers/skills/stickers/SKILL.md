---
name: stickers
description: 表情包自动偷取、AI分类审核与语境配图。当需要查找或发送表情包、收录群友新图、或看到表情包注入提示时读取。
version: 0.2.0
authors:
  - linre
---

# 表情包（linre-stickers v0.2.0）

集成自动偷图、VLM 情绪分类、人工审核工作台、黑名单去重、5 轮纯文字兜底配图以及 MCP 主动检索/收录工具。

## 铁律

- **只认审核过的**：`pending` 与 `disabled` 的图片永远不会出现在推荐注入或 `sticker_find` 结果里。
- **不自己发图**：插件只推荐或返回本机路径，真正发图必须调用宿主 `send_media`。
- **黑名单不可绕过**：被拒绝/删除拉黑的图片会记录 `sha256` 与 `fp64` 感知指纹，后续自动偷图与 `sticker_steal` 都会自动拦截。

## MCP 工具

- `sticker_find({ query?, emotion?, limit? })`：从已入库（`approved`）表情包中按关键词或 9 类情绪（开心/难过/担心/生气/亲近/好奇/无语/得意/害羞）检索并返回可直接交给 `send_media` 的路径。
- `sticker_steal({ filePath, caption?, emotion?, tags? })`：把本地图片收录进待审核池（默认 `pending`），等待人工审核或批量通过。

## 触发与兜底

- 正常命中：当最近消息关键词或 `linre-affect/appraisal` 情绪与已入库表情包强匹配时，注入一行建议。
- 连聊兜底：连续 `fallbackAfterSpeaks`（默认 5）轮 `speak` 未发图时，自动从已入库表情中挑选一张提示顺手带图。
- 单轮上限：每轮最多推荐 1 张，遵循 `cooldownSec` 冷却与最近 5 张反重复。
