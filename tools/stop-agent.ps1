<#
Irmia Agent — 停（把"停她"也变成一条正式路径）：只停后端，默认不动界面。

## 为什么要有这个脚本

以前"停她"只有手动 `Stop-Process` 一条路，而那是**硬杀**——每改一次运行期代码、每排一次障
都要来一下，手法却从来没有被写下来过（`restart-agent.ps1` 只负责重启，没有"只停"这个动作）。
这个脚本把三件事一次做完：**停**、**核实真的停了**、**把现场（锁文件 / 界面 / 日志痕迹）报出来**。

## ⚠️ 实测过的第一件事：这个框架在 Windows 上**没有**"优雅停机"这条外部通道

别指望 `Stop-Process -Id <pid>` 不带 `-Force` 是"温和信号"——在 Windows 上它走的是
`TerminateProcess`，与硬杀**完全一样**。2026-10-05 用一个只装了 SIGINT/SIGTERM 处理器的
node 探针（用与 restart-agent.ps1 **同一个 WMI 启动方式**拉起：`cmd.exe /c node …`、无窗口）
实测了四种发法：

| 发法 | 结果 |
|---|---|
| `Stop-Process -Id <pid>`（不带 -Force） | 进程**立刻死**，探针收不到任何信号（与硬杀无异） |
| `taskkill /PID <pid>`（不带 /F） | 拒绝：*This process can only be terminated forcefully* |
| `AttachConsole <pid>` + `GenerateConsoleCtrlEvent(CTRL_BREAK)` | **附不上**（WMI 起的进程压根没有控制台） |
| `Stop-Process -Force` | 死（对照组） |

结论：**她是由 WMI 以"无控制台"方式拉起来的**，而 Windows 的控制台事件只能发给"有控制台"的
进程——所以 SIGINT/SIGTERM 那套优雅退出（`src/main.ts` 里确实装了这两个处理器）**从外部够不着**。
写一个"先温和、超时才强杀"的脚本只是演给人看：第一步就已经是硬杀了。

## 那"硬杀"在这个框架里到底丢了什么（如实说）

- **丢**：`session/end` 事件、投影缓存落盘、定时器表 flush、`managedService.stop()`（协议端
  SnowLuma 的收尸）、锁文件的正常释放——这些都在 `stop()` 那条路里，进程被掐就都不会跑。
- **不丢**（框架本来就是按"随时被杀"设计的，design §1 第 1 条）：下一次启动时
  `recover` 读 `data/lock.json` 判"pid 已经不在了"（`pid-gone`）→ 自动接管；未闭合的 turn 由
  恢复流程补 `turn/end{interrupted}` 并把输入退回队列。**所以硬杀不会让她丢活、也不会留下
  "起不来"的锁**——这正是这个脚本敢用硬杀的依据。
- **要留意**：协议端（SnowLuma）的登录态不在这套恢复范围里——硬杀不会给它收尸，重启后
  agent 会重新拉起它，但 QQ 登录态可能要人去 WebUI 再登一次（`restart-agent.ps1` 文件头记过同一件事）。

所以这个脚本**不假装优雅**：它用最少的动作停掉后端，然后把"停干净了没有"核实给你看。
哪天真的要优雅停机，正确的做法是在框架里开一条控制面（例如某个已鉴权的接口），而不是在
外面猜怎么发信号。

## 用法

```
pwsh -File tools/stop-agent.ps1                 # 停后端，界面留着（人还在看那一屏）
pwsh -File tools/stop-agent.ps1 -IncludeGui     # 连界面一起停
pwsh -File tools/stop-agent.ps1 -WhatIf         # 只报告不动作（排障：先看它到底找到了谁）
pwsh -File tools/stop-agent.ps1 -WaitSeconds 30 # 等它退出的上限（默认 20 秒）
pwsh -File tools/stop-agent.ps1 -DataDir D:\IrmiaAgent\data
```

## 为什么默认不动界面

界面是**给人看的**：停后端常常只是为了改运行期代码再起一次，这时把窗口也关掉，人还得重新
找它、重新定位。所以"停后端"与"关窗"是两件事，只有显式 `-IncludeGui` 才一起做。

## 判据与 `restart-agent.ps1` 必须一致（两处不许漂）

两边都用同一条判据找主进程：

    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
      Where-Object { $_.CommandLine -like '*dist/main.js*' }

这一条刻意**不匹配 SnowLuma**：它是内置协议端、由 agent 自己托管拉起
（`channels.onebot.managed`），杀它等于把协议端状态一起掐掉（见 restart 脚本文件头那场血案）。
改这一条判据时，**两个脚本要一起改**——各写一套 pid 查找逻辑，迟早会出现"重启找得到、停找不到"
（或者反过来）那种极难查的分岔。

本脚本在它之上多做了两件事（都不改变"谁算她在跑"这个结论，只是把结论说得更准）：
  ① 先读 `data/lock.json` 的 pid——那是**权威**（她只会在真正拿到锁之后才开始干活）；
  ② 但**仍然要过一遍命令行判据**：pid 会被系统复用，锁文件也可能是上一次没来得及清的陈旧记录
     （心跳陈旧、pid 早就不在）。两边一致时才动手；不一致就如实报出来（下面 `-WhatIf` 的输出）。

## 退出码

  0 = 停干净了（或者本来就没在跑）；1 = 超时/仍活着（需要人工看一眼）
#>

param(
  # 仓库根（= 启动 node 时的工作目录；也与 restart-agent.ps1 的默认值一致）
  [string]$Repo = '<repo>',
  # 数据目录（读 lock.json、报锁状态用）。默认 <Repo>\data
  [string]$DataDir = '',
  # 界面可执行文件（可空）。给了且 -IncludeGui 时才动它
  [string]$GuiExe = '',
  # 停界面
  [switch]$IncludeGui,
  # 只报告不动作（排障）
  [switch]$WhatIf,
  # 等它退出的上限（秒）
  [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Continue'
if ($DataDir -eq '') { $DataDir = Join-Path $Repo 'data' }
$lockPath = Join-Path $DataDir 'lock.json'

# 界面按可执行文件名找（只要那个名字的进程，不碰别的窗口）。没给路径就按出厂名猜一个。
$guiName = 'irmia_gui'
if ($GuiExe -ne '') { $guiName = [System.IO.Path]::GetFileNameWithoutExtension($GuiExe) }

function Get-AgentProcesses {
  # ⚠️ 与 restart-agent.ps1 的判据**必须一致**（见文件头那段）。SnowLuma 一律不匹配。
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*dist/main.js*' }
}

function Get-LockRecord {
  if (-not (Test-Path $lockPath)) { return $null }
  try {
    $raw = Get-Content $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $raw.pid) { return $null }
    return $raw
  } catch {
    Write-Host "[停] lock.json 读不出来（$($_.Exception.Message)）——按'没有锁记录'处理，仍会用命令行判据找她"
    return $null
  }
}

function Test-PidAlive([int]$ProcessId) {
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Format-LockLine {
  param($Before, $After)
  $aliveAfter = $false
  if ($After -ne $null) { $aliveAfter = Test-PidAlive ([int]$After.pid) }
  $heldBefore = ($Before -ne $null)
  $heldAfter = ($After -ne $null)
  if ($Before -ne $null) {
    Write-Host ("[停] 锁文件（停之前）：pid {0} · 起于 {1} · 最近心跳 {2}" -f $Before.pid, $Before.startedAt, $Before.heartbeatAt)
  } else {
    Write-Host "[停] 锁文件（停之前）：不存在或读不出（她没在跑时就是这样）"
  }
  Write-Host ("[停] 锁文件（停之后）：{0}" -f $(if ($heldAfter) { "还在，pid $($After.pid) · 该 pid 还活着=$aliveAfter" } else { '不存在或读不出' }))
  if ($heldAfter -and -not $aliveAfter) {
    # 这是硬杀之后**正常**的样子：她来不及释放锁就走了，下一次启动会判 pid-gone 并接管
    Write-Host "[停] 说明：锁文件留着一份陈旧记录（它记的 pid 已经不在了）——这是硬杀的正常结果；"
    Write-Host "      下一次启动时 recover 会判 pid-gone 自动接管，不需要人工删这个文件。"
  }
  return @{ heldBefore = $heldBefore; heldAfter = $heldAfter; aliveAfter = $aliveAfter }
}

# ──────────────────────────────── 1. 她现在在不在 ────────────────────────────────

Write-Host "=== 停 Irmia Agent 后端 ==="
$lock = Get-LockRecord
$procs = @(Get-AgentProcesses)
$guiProcs = @(Get-Process -Name $guiName -ErrorAction SilentlyContinue)

if ($lock -ne $null) {
  $lockAlive = Test-PidAlive ([int]$lock.pid)
  Write-Host ("[停] 锁记录：pid {0}（这个 pid 现在{1}）· 最近心跳 {2}" -f $lock.pid, $(if ($lockAlive) { '活着' } else { '已经不在了' }), $lock.heartbeatAt)
  $match = $procs | Where-Object { $_.ProcessId -eq [int]$lock.pid }
  if ($lockAlive -and $null -eq $match) {
    Write-Host "[停] 注意：锁里的 pid 活着，但它的命令行不是 dist/main.js——那可能是 pid 被别的程序复用了。"
    Write-Host "      以命令行判据为准（下面列出的才是她）。"
  }
}

if ($procs.Count -eq 0) {
  Write-Host "[停] 没找到在跑的后端（命令行含 dist/main.js 的 node 进程）——不需要停。"
  if ($guiProcs.Count -gt 0) {
    Write-Host ("[停] 界面还在跑：{0}" -f (($guiProcs | ForEach-Object { "pid $($_.Id)" }) -join '、'))
  }
  if ($WhatIf) { Write-Host '[停] -WhatIf：不做任何动作。' }
  exit 0
}

foreach ($p in $procs) {
  Write-Host ("[停] 找到后端：pid {0} · 起于 {1}" -f $p.ProcessId, $p.CreationDate)
  if ($p.CommandLine.Length -gt 160) {
    Write-Host ("         命令：{0}…" -f $p.CommandLine.Substring(0, 160))
  } else {
    Write-Host ("         命令：{0}" -f $p.CommandLine)
  }
}

if ($guiProcs.Count -gt 0) {
  Write-Host ("[停] 界面在跑：{0}（默认不动它，要一起停加 -IncludeGui）" -f (($guiProcs | ForEach-Object { "pid $($_.Id)" }) -join '、'))
}

if ($WhatIf) {
  Write-Host '[停] -WhatIf：只报告，不动作。（要真停就去掉 -WhatIf）'
  if ($IncludeGui -and $guiProcs.Count -gt 0) { Write-Host '[停] -WhatIf：本来还会停界面。' }
  exit 0
}

# ──────────────────────────────── 2. 停 ────────────────────────────────

# 为什么直接 -Force：见文件头那张实测表——在这个启动方式下，不带 -Force 也是硬杀（连一步温和
# 的余地都没有），所以没有"先温和、超时才强杀"这回事，不写那种只有安慰作用的代码。
foreach ($p in $procs) {
  Write-Host "[停] 终止后端 pid $($p.ProcessId)（Windows 上这是硬杀：优雅退出的处理器从外部够不着，理由见脚本文件头）"
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$still = @(Get-AgentProcesses)
while ($still.Count -gt 0 -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
  $still = @(Get-AgentProcesses)
}

# ──────────────────────────────── 3. 报现场：pid / 锁 / 界面 ────────────────────────────────

$after = Get-LockRecord
$lockFacts = Format-LockLine -Before $lock -After $after

$guiNow = @(Get-Process -Name $guiName -ErrorAction SilentlyContinue)
if ($IncludeGui -and $guiNow.Count -gt 0) {
  foreach ($g in $guiNow) {
    Write-Host "[停] 终止界面 pid $($g.Id)"
    Stop-Process -Id $g.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  $guiNow = @(Get-Process -Name $guiName -ErrorAction SilentlyContinue)
}

Write-Host ''
if ($still.Count -eq 0) {
  Write-Host "[停] 后端已停：pid $(($procs | ForEach-Object { $_.ProcessId }) -join '、') 已经不在进程表里。"
} else {
  Write-Host "[停] ⚠ 还有后端进程没停掉（等了 $WaitSeconds 秒）：$(($still | ForEach-Object { "pid $($_.ProcessId)" }) -join '、')"
  Write-Host "      可能原因：权限不够（她由别的账户/更高完整性级别启动），或者 pid 是刚被别人复用出来的。"
}

if ($guiNow.Count -gt 0) {
  Write-Host ("[停] 界面仍在运行：{0}{1}" -f (($guiNow | ForEach-Object { "pid $($_.Id)" }) -join '、'), $(if ($IncludeGui) { '（-IncludeGui 也停不掉，请看权限）' } else { '（按设计不动它）' }))
} else {
  Write-Host '[停] 界面：没有在运行。'
}

# 日志里的停机痕迹：硬杀**不会**有 session/end，所以这里找的是"进程日志的最后几行"——
# 报出来是为了让人一眼看到"她是在哪一步被掐掉的"，而不是把"没有 session/end"当成异常。
$outLog = Join-Path 'D:\irmia' 'agent-console.out.log'
if (Test-Path $outLog) {
  Write-Host ''
  Write-Host "[停] 进程日志尾部（$outLog）："
  Get-Content $outLog -Tail 5 | ForEach-Object { Write-Host "      $_" }
  Write-Host '[停] 说明：硬杀不会写 session/end 事件（那一步在框架自己的停机流程里，见脚本文件头）。'
  Write-Host '      要确认"下一次能不能正常接管"，看她下次启动的日志里有没有 instance/takeover（pid-gone）。'
}

if ($still.Count -gt 0) { exit 1 }
exit 0
