---
name: meme-photo
description: Linre 的轻量表情包图库：当收到图片、需要按情绪找表情或准备发送图片时读取。它提供收图、检索与路径回传；真正发图必须继续调用宿主 send_media。
version: 0.1.0
authors:
  - pashippercode
---

# Meme Photo

这是一个本地表情包图库 MVP，工具由 `linre-meme-photo__meme-photo` 提供。

## 收图

当对方明确分享了图片、表情或照片，并且上下文能提供图片 URL、文件路径或 base64 时，调用 `steal_meme`。不要凭空把普通网页链接当图片收录；网络 URL 必须先调用宿主 `http_download` 下载到工作区，再把返回的本地路径传给 `steal_meme`。如果只有视觉内容而没有可用的输入引用，先继续对话，不要猜路径。

调用时尽量提供简短的 `label`、`tags`、`mood` 和 `source`。服务会按图片 SHA-256 去重，图片默认保存到本机插件数据目录。

## 找图和发图

1. 先调用 `search_meme`，把当前回复的语气、情绪和场景写进 `query` 或 `mood`。
2. 选出最匹配的一张后调用 `send_meme`，优先传 `id`。
3. `send_meme` 只会返回本机图片路径，**不代表已经发出**。必须紧接着调用宿主 `send_media`，传入返回的绝对 `path`。
4. `send_media` 成功后才可以告诉对方图片已发出；失败则如实说明，不重复盲发。

表情包只是语气补充。用户在问严肃问题、错误处理、需要精确信息或没有自然契机时，不要为了调用工具而发送。

## Adapter v2

在 Linre Adapter Host 中，优先让 `adapter-worker.mjs` 观察事件并调用 `query`。worker 返回的是 opaque `assetId`，不是可直接发送的路径；需要发图时调用 `effect/propose` 生成待审批的文本+图片 proposal，由 Host 解析 assetId 并审批发送。worker 不执行网络 fetch、不接受事件回放，也不直接发送任何消息。

## 边界

当前版本不包含 VLM 自动分类、审核池、自动随聊概率发送、Web 管理页、Embedding 或平台专属贴纸协议。可以先用手工标签稳定积累图库；这些能力后续应在 Linre 原生事件与媒体契约确定后分阶段增加。
