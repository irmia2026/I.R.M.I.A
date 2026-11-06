# linre-file-helper 插件

专为林芮编写的直接发送本地文件的 MCP 扩展插件。

### 功能说明
- 提供 `send_file` MCP 工具，能够直接将本地文件打包或通过 OneBot 协议端 / 容器机制发送到妈的 QQ 私聊。
- 自动处理路径解析、文件合法性检查与错误兜底汇报。

### 安装与装配
1. 打开框架网页界面 ->「扩展」页 -> Plugins 区 -> **安装**；
2. 填入插件目录的绝对路径：`C:\Users\admin\Documents\linre-src\L.i.N.R.E\src\plugins-src\linre-file-helper`；
3. 核对 SHA256 哈希后点击**审核**与**启用**；
4. 重启框架即可在 MCP 列表加载 `linre-file-helper__send_file` 工具。
