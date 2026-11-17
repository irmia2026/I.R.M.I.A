# Linux 兼容性

Ubuntu 24.04 LTS x86_64 支持独立后端、systemd 服务和 Flutter 桌面。后端可通过命令行唤醒、查日志、自检，默认使用本机 HTTP API。

## 从源码运行

在 Ubuntu 上准备 Node.js 22 的维护版本，再以普通用户操作。

```sh
npm ci
npm run build
node scripts/smoke-linux.mjs
npm start
```

冒烟测试使用临时目录、随机本机端口和模拟对话。它从独立的构建目录加载 Node 插件，验证技能种子、首次设密、CLI 唤醒、日志落盘、数据目录锁和两次启动。前台后端默认监听 `127.0.0.1:7788`，用 `curl -fsS http://127.0.0.1:7788/api/health` 确认 `status` 为 `ready`。无模型密钥时可走模拟循环。

## 安装系统服务

以下步骤适用于首次部署。系统服务所用的 `/usr/bin/node` 应为 Node 22 或以上。若 Node 安装在其他系统路径，用 `systemctl edit irmia-agent` 清空并覆写 `ExecStart`，保留两项目录参数。服务无法访问 `/home` 内的用户版 Node。

```sh
getent group irmia-agent >/dev/null || sudo groupadd --system irmia-agent
id irmia-agent >/dev/null 2>&1 || sudo useradd --system --gid irmia-agent \
  --home-dir /var/lib/irmia-agent --no-create-home --shell /usr/sbin/nologin irmia-agent
sudo install -d -o root -g root -m 0755 /opt/irmia-agent
sudo cp -R dist skills /opt/irmia-agent/
sudo install -m 0644 scripts/irmia-agent.service /etc/systemd/system/irmia-agent.service
sudo systemd-analyze verify /etc/systemd/system/irmia-agent.service
sudo systemctl daemon-reload
sudo systemctl start irmia-agent
curl -fsS http://127.0.0.1:7788/api/health
```

程序和出厂技能在 `/opt/irmia-agent`，由管理员更新。systemd 建立只有服务账户可访问的 `/var/lib/irmia-agent`，其中保存 `config.json` 和 `data/`。相对配置路径以配置目录为基准，工具的默认工作目录也在这里。模型密钥可通过权限为 `0600` 的 `/etc/irmia-agent.env` 提供，例如写入 `IRMIA_API_KEY=...`，然后重启服务。前台运行新写入的密钥、登录和 Webhook 文件也使用 `0600`。迁移时检查已有凭据文件的归属和权限。

本机 API 首次设密前，只在本机用户可信的环境里启动。启动就绪后可在 Bash 中设置密码，输入不会出现在命令参数或终端输出中。

```bash
read -rs -p 'IRMIA 密码（至少 6 位）: ' irmia_password
printf '\n'
printf '%s' "$irmia_password" |
  /usr/bin/node -e 'process.stdout.write(JSON.stringify({password:require("node:fs").readFileSync(0,"utf8")}))' |
  curl -fsS -o /dev/null -H 'content-type: application/json' --data-binary @- \
    http://127.0.0.1:7788/api/auth/setup
unset irmia_password
```

命令行可以从本机服务账户的工作目录操作，与服务使用同一份配置和数据。

```sh
sudo -u irmia-agent sh -c 'cd /var/lib/irmia-agent && /usr/bin/node /opt/irmia-agent/dist/cli.js status'
sudo -u irmia-agent sh -c 'cd /var/lib/irmia-agent && /usr/bin/node /opt/irmia-agent/dist/cli.js wake --note "Linux 验收"'
sudo -u irmia-agent sh -c 'cd /var/lib/irmia-agent && /usr/bin/node /opt/irmia-agent/dist/cli.js tail --limit 12'
sudo journalctl -u irmia-agent -n 80
sudo systemctl restart irmia-agent
```

需要开机自动启动时，用 `sudo systemctl enable irmia-agent`。主管进程退出时 systemd 会启动新进程。需要停机时用 `sudo systemctl stop irmia-agent`，先让主管进程落盘和释放锁，服务退出后 systemd 再回收剩余进程。首次切换旧服务时，先停旧进程再备份和迁移原有配置、数据目录。检查配置里的绝对路径、外部可执行文件和挂载，再交给服务账户启动。

## 桌面客户端

从构建产物解压桌面包，在 Ubuntu 的图形会话里运行。系统需要 Node.js 22 或以上。使用媒体处理功能时安装 Pillow 和中文字体。

```sh
sudo apt install libgtk-3-0t64 libayatana-appindicator3-1 dbus-bin python3-pil fonts-noto-cjk ripgrep
bash scripts/start-linux-desktop.sh
```

启动器使用回环端口 7788。端口已有 IRMIA 时连接现有进程，已有其他程序时提示更换端口。通过 `IRMIA_WEB_PORT=7790` 指定端口，通过 `IRMIA_CONNECT_ONLY=1` 只连接现有后端。systemd 管理的实例用 `systemctl` 重启和停机。常规关窗只退出桌面，支持 StatusNotifier 的桌面可以将窗口收进托盘。

默认路径均属于当前用户。

| 文件 | 路径，XDG 环境变量设置为绝对路径时可覆盖 |
| --- | --- |
| 配置 | `~/.config/irmia/config.json` |
| 数据和技能 | `~/.local/share/irmia/data/` |
| 实例列表、登录、界面偏好和日志 | `~/.local/state/irmia/` |
| 临时端口记录 | `$XDG_RUNTIME_DIR/irmia/` |

从源码构建需要 Flutter 3.35.4 和 GTK 开发工具链。

```sh
sudo apt install clang cmake ninja-build pkg-config libgtk-3-dev libstdc++-12-dev libayatana-appindicator3-dev
npm ci
npm run build
(cd gui && flutter pub get && flutter build linux --release)
bash scripts/start-linux-desktop.sh
```

在仓库根目录构建供分发的归档。两个包都有 SHA-256 校验文件。

```sh
bash scripts/package-linux.sh ~/irmia-release
bash scripts/package-linux.sh ~/irmia-release --desktop
(cd ~/irmia-release && sha256sum -c ./*.sha256)
```

后端包包含构建好的 Node 程序、随附技能和 systemd 单元。桌面包另含 Flutter 可执行文件和启动器。升级时先停止旧后端并备份配置与数据，再在新目录解压、启动。路径指向旧的 Windows 盘符、程序或插件时，迁移前改写为目标机器的实际路径。归档以 Ubuntu 24.04 x86_64 为验收范围。ARM64、发行版安装包和自动更新仍待独立验证。

## 平台能力

- Linux 的文件名搜索使用有上限的目录遍历，默认递归查找当前工作区。搜索正则在独立线程运行，超限会明确返回结果可能不完整。全文搜索仍使用 `ripgrep`。
- Linux 使用 Pillow 生成大图预览、GIF 帧矩阵和贴纸缩略图。可用 `IRMIA_IMAGE_PYTHON` 指定装有 Pillow 的解释器。贴纸库在 Linux 和 Windows 分别记录两种感知哈希，保留已有数据。
- 桌面截图需要图形会话、支持 Screenshot 的 XDG Portal 后端及 `python3-gi`。首次启动桌面后端时设 `IRMIA_ENABLE_PORTAL_SCREENSHOT=1` 开启。使用系统对话框选取画面，输出在任务工作区。`IRMIA_SCREENSHOT_PYTHON` 可指定装有 GI 的解释器。系统服务和无图形会话时无需安装这些截图组件。
- 可接入单独部署的 OneBot WebSocket 端。模型、通道和插件各自的账户、设备及外部程序按功能配置。Office、Deskhand、Windows 专用启动脚本和窗口标题定位需要各自的平台实现。

## SnowLuma 与外置 OneBot

已有 Linux SnowLuma 安装时，可将解压目录填进「设置 → 协议端 → 安装目录」，保存后重启 IRMIA。IRMIA 优先调用包内的 `launcher.sh`。只有 JS 入口的安装可用 `IRMIA_SNOWLUMA_NODE` 指定符合该发行包要求的 Node。SnowLuma 的 WebUI、许可确认和 QQ 登录由使用者完成。

也可以将协议端独立部署。在 `config.json` 中将 `channels.onebot.enabled` 设为 `true`，填写 `wsUrl` 和 `tokenEnv`，省略 `managed`。凭据值写到对应环境变量或 IRMIA 的本地密钥存储。适配器会自行重连。

本次验收时，SnowLuma 的官方发布接口与公开仓库均返回 HTTP 404。Linux 一键下载和使用真实 QQ 账户的联调待官方发行包可访问后验证。归档内不包含 SnowLuma。 [SnowLuma 发布入口](https://github.com/SnowLuma/SnowLuma/releases)

## 2026-11-18 验收记录

### 桌面与发布包

- 本轮平台回归覆盖 Windows 与 Ubuntu 24.04.5 x86_64，分别通过 656 项和 657 项，均为 0 失败。覆盖独立 OneBot 的收发与重连、Linux 文件名搜索、附件和贴纸、权限以及模拟 SnowLuma 进程生命周期。
- 从桌面归档启动后，在隔离的 X11 会话走通首帧、界面设密、会话落盘、系统关窗及再次连接原后端。Weston Wayland 会话完成首帧渲染并连接本机后端。截图通过隔离的 D-Bus 门户验证了返回图片、取消与清理，真实桌面授权弹窗和桌面发行版的托盘交互仍待验证。
- 重新生成了桌面和无界面归档，均提供 SHA-256 校验文件。GitHub Actions 配置覆盖这两个构建。

### 无界面基础

- Windows 和 Ubuntu 24.04.5 WSL2 分别有 497 项针对性测试通过，均为 0 失败、3 项按平台跳过。
- Windows 全量仍有基线的 25 项失败。Ubuntu 基线在清理泄漏的测试子进程后跑完，共 105 项失败。新版无需人工清理即可跑完全量，报告 91 项失败，其中插件市场测试文件遇到一次 Node 测试运行器反序列化异常，单独重跑通过 19 项。
- 在 Ubuntu 的 systemd 中用专用账户完成了首次启动、设密、登录、正常重启、强制终止后的自动恢复和显式停机。重启保留了凭据，停机释放了锁。进程刚就绪时的 RSS 约为 102 MiB，使用空白数据目录和模拟循环。
- 用本机模拟 Chat Completions 服务走通了真实模型循环，成功发起请求并落盘回复。真实第三方模型账户和 QQ 仍需独立验收。

参考资料 [systemd 的服务目录和文件系统权限](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) · [Flutter Linux 桌面工具链](https://docs.flutter.dev/platform-integration/linux/setup) · [XDG 目录规范](https://specifications.freedesktop.org/basedir/)。
