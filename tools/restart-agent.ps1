# Irmia Agent — 重启（唯一正确姿势）：主进程 + 界面
#
# 为什么要有这个脚本（2026-10-03 的教训）：
#   我先前在命令行里手打重启，过滤条件写成了 `*dist/main.js*` **或** `*snowluma*` ——
#   后半个条件是错的：**SnowLuma 是内置协议端、由 agent 自己托管拉起**
#   （`channels.onebot.managed`：kind=snowluma、autoStart=true、目录 data/services/snowluma），
#   杀它等于把协议端的状态一起掐掉（QQ 登录态、WS 连接），而 agent 重启后虽然会再拉起它，
#   但登录态不会自动回来（要人去 WebUI 登一次）。
#
# 所以这里**只杀主进程**：匹配命令行里含 `dist/main.js` 的 node 进程。SnowLuma 一律不动。
#
# 用法：pwsh -File tools/restart-agent.ps1
#       pwsh -File tools/restart-agent.ps1 -GuiExe 'C:\...\irmia_gui.exe'   # 连界面一起重启
#
# ⚠️ 2026-10-03 血案（第二次教训）：**不要杀这个脚本**。
#   启动器被强杀时，它拉起的 node **会一起死**（在同一个 job 对象里）——"连不上她"就是这么来的。
#   所以现在改成用 WMI 创建进程（`Win32_Process.Create`）：新进程**不在**本脚本的 job 里，
#   就算启动器被掐掉，她也照常跑。
#
# 2026-10-04 加：`-GuiExe` 给了路径就把界面进程也重启一遍（"重启前后端"那个按钮用）。
#   界面由**动作发起方**告诉脚本自己的可执行路径——脚本不该去猜界面装在哪（那是台机器的私事）。

param(
  # 项目根：默认取本脚本所在目录的上级（tools/ 与 src/、dist/ 同级），不写死任何机器路径
  [string]$Repo = '',
  # node.exe：默认取 PATH 上的那个。计划任务/WMI 不继承交互式 shell 的 PATH，
  # 真要换就显式传 -NodeExe 'C:\path\to\node.exe'
  [string]$NodeExe = '',
  # 主进程日志落点：默认 <项目根>\data\logs\（目录不存在会自动建）
  [string]$OutLog = '',
  [string]$ErrLog = '',
  [int]$WaitSeconds = 20,
  # 界面可执行文件（可空）。给了就把它也重启——"重启前后端"。
  [string]$GuiExe = '',
  # 延迟几秒再动手：让发起这次重启的 HTTP 响应先返回，界面不至于拿到一个断掉的连接
  [int]$DelaySeconds = 2
)

# ── 默认值推导：脚本只认"自己在哪"，不认任何一台具体机器的路径 ──
if ($Repo -eq '') {
  if ([string]::IsNullOrEmpty($PSScriptRoot)) { throw '无法从脚本位置推断项目根：请显式传 -Repo <项目根>' }
  $Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}
if ($NodeExe -eq '') {
  $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($null -eq $found) { throw 'PATH 上找不到 node.exe：请用 -NodeExe 指定绝对路径' }
  $NodeExe = $found.Source
}
$logDir = Join-Path $Repo 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if ($OutLog -eq '') { $OutLog = Join-Path $logDir 'agent-console.out.log' }
if ($ErrLog -eq '') { $ErrLog = Join-Path $logDir 'agent-console.err.log' }

if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }

$targets = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*dist/main.js*' }
foreach ($p in $targets) {
  Write-Host "[重启] 停主进程 PID $($p.ProcessId)"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

# 界面：按可执行文件路径找（只杀那一个，不碰别的窗口）
if ($GuiExe -ne '') {
  $guiName = [System.IO.Path]::GetFileNameWithoutExtension($GuiExe)
  $guiProcs = Get-Process -Name $guiName -ErrorAction SilentlyContinue
  foreach ($g in $guiProcs) {
    Write-Host "[重启] 停界面 PID $($g.Id)"
    Stop-Process -Id $g.Id -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 4

# 用 WMI 建进程：脱离本脚本的 job 对象（脚本被杀也不会带走她）。输出仍重定向到那两个日志文件。
$cmd = "cmd.exe /c `"`"$NodeExe`" dist/main.js > `"$OutLog`" 2> `"$ErrLog`"`""
# ShowWindow = 0：WMI 建进程默认会显示控制台窗口，用户会看到一个黑框
$si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$si.ShowWindow = 0
$created = ([wmiclass]'Win32_Process').Create($cmd, $Repo, $si)
if ($created.ReturnValue -ne 0) {
  Write-Host "[重启] WMI 启动失败（$($created.ReturnValue)），退回 Start-Process"
  Start-Process -FilePath $NodeExe -ArgumentList 'dist/main.js' -WorkingDirectory $Repo `
    -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden
} else {
  Write-Host "[重启] 已拉起（pid $($created.ProcessId)，脱离本脚本；日志：$OutLog）"
}

# 界面同样用 WMI 拉起（脱离本脚本，脚本结束也不会带走它）
if ($GuiExe -ne '' -and (Test-Path $GuiExe)) {
  $guiDir = Split-Path -Parent $GuiExe
  $guiCreated = ([wmiclass]'Win32_Process').Create("`"$GuiExe`"", $guiDir, $si)
  if ($guiCreated.ReturnValue -eq 0) {
    Write-Host "[重启] 界面已拉起（pid $($guiCreated.ProcessId)）"
  } else {
    Write-Host "[重启] 界面拉起失败（$($guiCreated.ReturnValue)）：$GuiExe"
  }
}

Start-Sleep -Seconds $WaitSeconds

Get-Content $OutLog | Select-String -Pattern '恢复完成|READY' | Select-Object -First 3
Write-Host "[重启] 完成。（协议端 SnowLuma 由 agent 托管，不在本脚本的管辖范围）"
