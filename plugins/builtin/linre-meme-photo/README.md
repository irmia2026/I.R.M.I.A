# linre-meme-photo

LiNRE 插件：把对话里的图片收进本地表情包图库，按描述/情绪检索，并通过 Linre Adapter Host 提交需要审批的文本+图片 effect proposal。

这是从 [astrbot_plugin_stealer](https://github.com/nagatoquin33/astrbot_plugin_stealer) 迁移的实现。插件同时保留原有 stdio MCP `search_meme` 能力，并新增 Adapter v2 worker；两条入口共享本地图库索引，但 Adapter worker 不直接发送消息。

## 当前能力

- `steal_meme` / `search_meme` / `send_meme` / `list_memes` / `forget_meme`：原有 MCP 工具仍可用。`search_meme` 返回的路径只能交给宿主已有的 `send_media`，不是发送回执。
- `adapter-worker.mjs`：JSON-RPC 2.0 over JSONL worker，供 Linre Adapter Host 启动。
- 事件观察：`event`、`observe` 或 `events/observe` 接收 Host 提供的 image 资产，按 SHA-256 去重并自动建立索引。
- 查询与选择：`query` 按描述、标签或情绪返回结果；结果使用 opaque `assetId`，不泄漏本地路径。
- effect proposal：`effect/propose`（别名 `effects/propose`）根据 `assetId` 生成待审批的 `effect_proposal`，载荷包含文本和 `{ assetId }` 图片引用。

## Adapter Host 要求

Adapter worker **必须由 Linre Adapter Host 启动**；直接在 shell 中运行只会得到 JSONL RPC 流，不提供事件注入、资产解析或 effect 审批。Host 需要负责：

1. 观察并转发消息事件及 image 资产；worker 只接受 Host 授权的资产路径或 base64 资产。
2. 根据 worker 返回的 opaque `assetId` 解析实际媒体。`effect_proposal` 中不会出现 URL、本地 `path` 或图片数据。
3. 审批后由 Host 执行发送；worker 永远不会直接发送，也没有网络 fetch 权限。
4. 处理事件回放。当前 worker 拒绝带 `replay` / `replayed` 标记的事件，回放契约由 Host 管理。

`plugin.json` 使用 `apiVersion: 2` 和 `adapters` 数组声明 worker，同时保留 `contributions.mcp` 与 `contributions.skills`。其中协议字段和 capability 名称（`event.observe`、`asset.resolve`、`storage.kv`、`message.propose`）应与 Host 的 manifest-v2 schema 对齐；Host schema 发生变化时需同步适配 manifest。

## 安全边界

- worker 只读写图库数据目录；事件中的文件路径必须位于 `LINRE_MEME_DATA_DIR`、`LINRE_ADAPTER_ASSET_DIR` 或 `LINRE_WORKSPACE_DIR` 下，并经过 realpath 校验。
- worker 不实现 HTTP、HTTPS 或其他网络 fetch；URL 资产必须先由 Host 下载并以授权资产传入。
- `effect/execute`、`effect/approve`、`send`、`send_message` 等直接发送方法一律返回无权限错误。
- effect 和查询结果只暴露 opaque `assetId`；Host 负责解析到具体媒体。

## 安装

1. 在 Linre Adapter Host 中安装本仓库目录作为插件包。
2. 通过插件管理界面完成人工确认与启用，然后重启 Linre Adapter Host。
3. MCP 服务名为 `linre-meme-photo__meme-photo`；Adapter worker 由 Host 按 manifest 启动。

图库默认写入：

- Windows：`%LOCALAPPDATA%\\linre-meme-photo`
- 其他系统：`~/.linre-meme-photo`
- 也可用 `LINRE_MEME_DATA_DIR` 指定目录；`IRMIA_DATA_DIR` 存在时优先复用它。

网络图片的 HTTPS、私网阻断、重定向和大小限制由 Linre 宿主 `http_download` 或 Adapter Host 负责；插件服务和 worker 都只接收下载后的工作区路径、授权资产或 base64。

## 本地检查

```bash
node --check server.mjs
node --check adapter-worker.mjs
npm test
```

仓库保留原项目 AGPL-3.0 许可证。完整 AstrBot 功能的对应关系和迁移边界见 Skill 说明。
