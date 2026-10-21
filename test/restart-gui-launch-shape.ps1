# ════════════════════════════════════════════════════════════════════════════
# 界面拉起**形状**的对照矩阵 —— 一个真界面窗口都不弹（替身是无窗口 exe）
#
# 为什么要有这一条（2026-10-10，第五次复现之后）：
#   生产的界面那一支用的是
#     `cmd.exe /s /c ""<exe>" >> "<ScriptLog>" 2>&1"`（WMI Create）
#   而**外层**（服务端起脚本时，见 src/web/server.ts / restartCommandLine）是
#     `cmd.exe /s /c ""<shell>" "<restart-agent.ps1>" … -ScriptLog <同一个文件> >> "<同一个文件>" 2>&1"`
#   —— 也就是说：**内层的重定向目标正是外层此刻握着的那个文件**。
#   `cmd` 的 `>>` 自己只 FILE_SHARE_READ（不许别人同时写），于是内层那一句在**打开文件**这一步
#   就失败、直接退出：WMI 返回码 0、壳 pid 有，而目标 exe **根本没被执行** —— 这就是
#   `界面拉起=not-appeared` 的形状。
#
# 本脚本把四个变量分成四格（每格只动一个变量），并把"新形状"放进同一张表里：
#   ① 形状：旧（cmd /s /c + >>）/ 新（Start-Process -PassThru，-WorkingDirectory=exe 所在目录）
#   ② 重定向目标：纯 ASCII / **含中文**（例如 `D:\项目\…` 那种路径）
#   ③ 目标文件此刻**有没有被外层持有**（.NET 追加句柄，FileShare.ReadWrite）
#   ④ （信息项）新形状若**偏要**重定向到那个被持有的文件，会怎样
#
# 跑法：pwsh -NoProfile -File test\restart-gui-launch-shape.ps1
#     （`-Keep` 保留沙盒；默认跑完删掉）
# 判据与 `tools\restart-agent.ps1` 的 `Get-ProcsByExePath` 同形：**exe 全路径 + 新出现**，
# 绝不按名字判（这台机器上还有别的同名安装）。
# ════════════════════════════════════════════════════════════════════════════
param(
  [string]$Work = (Join-Path $env:TEMP 'irmia-shape-matrix'),
  [int]$ObserveSeconds = 8,
  [switch]$Keep
)
$ErrorActionPreference = 'Continue'
$passed = 0
$failed = 0

function Say([string]$Text) { Write-Host $Text }
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { $script:passed++; Write-Host ('  OK   ' + $Name + '  ' + $Detail) }
  else { $script:failed++; Write-Host ('  FAIL ' + $Name + '  ' + $Detail) }
}

# ── 沙盒：两个目录，一个纯 ASCII、一个**含中文**（模拟 `D:\项目\…`） ──────────────
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
$DirAscii = Join-Path $Work 'ascii'
$DirCjk = Join-Path $Work '众测-日志目录'
$GuiDir = Join-Path $Work 'gui'
New-Item -ItemType Directory -Force -Path $DirAscii, $DirCjk, $GuiDir | Out-Null

# 替身：**真的 exe**（无窗口、不吃 stdin、忙等），见 test\stand-in\sleeper.cs
$Stand = Join-Path $GuiDir 'irmia_gui.exe'
$src = Join-Path $PSScriptRoot 'stand-in\sleeper.cs'
$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
& $csc /nologo /target:exe ("/out:" + $Stand) $src 2>&1 | Out-Null
$compiled = Test-Path $Stand

Say ('沙盒：' + $Work)
Say ('替身（无窗口）：' + $Stand + '（编译=' + $compiled + '）')
Say ('ASCII 目标目录：' + $DirAscii)
Say ('中文目标目录：' + $DirCjk)
Say ('观测窗：' + $ObserveSeconds + ' 秒/格 · 观测判据 = 同 exe 全路径的新进程')
Say ''
if (-not $compiled) { Say '替身编译失败，后面不用跑了'; exit 2 }

# ── 与 restart-agent.ps1 同形的两个判据函数 ─────────────────────────────────
function Get-StandPids {
  $full = [System.IO.Path]::GetFullPath($Stand)
  $picked = @()
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name = 'irmia_gui.exe'" -ErrorAction SilentlyContinue)) {
    if (-not $p.ExecutablePath) { continue }
    try { if ([System.IO.Path]::GetFullPath($p.ExecutablePath) -ieq $full) { $picked += $p } } catch { }
  }
  return $picked
}
function Stop-Stand {
  foreach ($p in @(Get-StandPids)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
}
function Invoke-Wmi([string]$Cmd, [string]$Dir) {
  $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $si.ShowWindow = 0
  try { return ([wmiclass]'Win32_Process').Create($Cmd, $Dir, $si) } catch { return $null }
}
# 等一个"本次新出现的"替身（唯一的成功判据）
function Wait-New([int[]]$Before, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($p in @(Get-StandPids)) { if ($Before -notcontains [int]$p.ProcessId) { return [int]$p.ProcessId } }
    Start-Sleep -Milliseconds 200
  }
  return 0
}

# ────────────────────────────── 四格矩阵 ──────────────────────────────
Say '════════ 形状 × 重定向目标（含中文）× 目标是否被外层持有 ════════'

function Run-Cell([string]$Name, [string]$Shape, [string]$Target, [bool]$Held, [string]$ArgLine) {
  Stop-Stand
  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue }
  $fs = $null
  $sw = $null
  if ($Held) {
    # "外层持有者"：与 `_research\probe-held-handle.ps1` 的 D1 **同一种持有**
    # （.NET 追加 + FileShare.ReadWrite）——注意它已经**很宽容**了，照样挡不住 cmd 的 `>>`。
    $fs = [System.IO.File]::Open($Target, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $sw = New-Object System.IO.StreamWriter($fs)
    $sw.AutoFlush = $true
    $sw.WriteLine('外层持有者：握着这个文件的写句柄（模拟服务端的 cmd >> 同一文件）')
  }
  $before = @(Get-StandPids | ForEach-Object { [int]$_.ProcessId })
  $note = ''
  if ($Shape -eq 'old') {
    $inner = '""' + $Stand + '"'
    if ($ArgLine -ne '') { $inner = $inner + ' ' + $ArgLine }
    $inner = $inner + ' >> "' + $Target + '" 2>&1' + '"'
    $cmd = 'cmd.exe /s /c ' + $inner
    $created = Invoke-Wmi $cmd $GuiDir
    $rc = '（没建起来）'
    $shell = 0
    if ($null -ne $created) { $rc = [string]$created.ReturnValue; $shell = [int]$created.ProcessId }
    $note = 'WMI 返回码=' + $rc + ' 壳 pid=' + $shell
    Say ('  [' + $Name + '] 形状=旧 · 目标=' + $Target + ' · 被持有=' + $Held)
    Say ('      命令行：' + $cmd)
  } else {
    $sp = @{ FilePath = $Stand; WorkingDirectory = $GuiDir; PassThru = $true; ErrorAction = 'Stop' }
    if ($ArgLine -ne '') { $sp['ArgumentList'] = @($ArgLine) }
    $threw = ''
    $passPid = 0
    try { $p = Start-Process @sp; $passPid = [int]$p.Id } catch { $threw = $_.Exception.Message }
    $note = 'Start-Process -PassThru pid=' + $passPid
    if ($threw -ne '') { $note = 'Start-Process 抛异常：' + $threw }
    Say ('  [' + $Name + '] 形状=新 · 目标=' + $Target + ' · 被持有=' + $Held + ' ⇒ ' + $note)
  }
  $newPid = Wait-New $before $ObserveSeconds
  if ($sw -ne $null) { try { $sw.WriteLine('外层持有者：内层尝试之后我还在写'); $sw.Flush(); $sw.Close(); $fs.Close() } catch { } }
  Say ('      新出现的替身 pid=' + $newPid + ' ⇒ ' + $(if ($newPid -gt 0) { '起来了' } else { '**没出现**' }))
  return [pscustomobject]@{ Name = $Name; NewPid = $newPid; Note = $note }
}

$logAscii = Join-Path $DirAscii 'gui-ascii.log'
$logCjk = Join-Path $DirCjk 'gui-中文日志.log'
$alive = '30000'   # 替身活 30 秒：远长于观测窗

$c1 = Run-Cell '① 旧形状 · ASCII · 没人持有' 'old' $logAscii $false $alive
$c2 = Run-Cell '② 旧形状 · 中文 · 没人持有' 'old' $logCjk $false $alive
$c3 = Run-Cell '③ 旧形状 · ASCII · **被持有**' 'old' $logAscii $true $alive
$c4 = Run-Cell '④ 旧形状 · 中文 · **被持有**（生产形状）' 'old' $logCjk $true $alive
$c5 = Run-Cell '⑤ 新形状 · 中文 · **被持有**' 'new' $logCjk $true $alive

Stop-Stand
Say ''
Say '════════ 判定 ════════'
Check '① 旧形状 + ASCII + 无持有 ⇒ 能起来（形状本身没问题）' ($c1.NewPid -gt 0) ('new pid=' + $c1.NewPid)
Check '② 旧形状 + **中文** + 无持有 ⇒ 也能起来（**路径编码不是原因**）' ($c2.NewPid -gt 0) ('new pid=' + $c2.NewPid)
Check '③ 旧形状 + ASCII + **被持有** ⇒ 起不来（**"目标被外层持有"才是原因**）' ($c3.NewPid -eq 0) ('new pid=' + $c3.NewPid)
Check '④ 旧形状 + 中文 + 被持有（生产形状）⇒ 起不来' ($c4.NewPid -eq 0) ('new pid=' + $c4.NewPid)
Check '⑤ 新形状 + 中文 + 被持有 ⇒ **照样起来**（换成 Start-Process 就绕开了这一条）' ($c5.NewPid -gt 0) ('new pid=' + $c5.NewPid)

# ── 信息项：新形状若**偏要**重定向到那个被持有的文件 ─────────────────────────
#
# 这一格不是"会不会起来"（**会**起来：.NET 的 Start-Process 与 cmd 的 `>>` 不是同一种开法），
# 而是"**那个文件会怎样**"——因为 `tools\restart-agent.ps1` 里有一道闸门：
# `-GuiLog` 与 `-ScriptLog` 是同一个文件时**跳过重定向**。闸门的理由是这一格测出来的：
Say ''
Say '════════ 信息项：新形状 + 重定向到"被持有的那个文件" ════════'
Stop-Stand
$logProbe = Join-Path $DirCjk 'gui-forced-redirect.log'
if (Test-Path -LiteralPath $logProbe) { Remove-Item -LiteralPath $logProbe -Force -ErrorAction SilentlyContinue }
$fsx = [System.IO.File]::Open($logProbe, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
$swx = New-Object System.IO.StreamWriter($fsx); $swx.AutoFlush = $true
1..5 | ForEach-Object { $swx.WriteLine('持有者写的第 ' + $_ + ' 行') }
$sizeBefore = (Get-Item -LiteralPath $logProbe).Length
$before5 = @(Get-StandPids | ForEach-Object { [int]$_.ProcessId })
$forceNote = '（没抛异常）'
try {
  $pf = Start-Process -FilePath $Stand -ArgumentList @($alive) -WorkingDirectory $GuiDir -PassThru -RedirectStandardOutput $logProbe -RedirectStandardError ($logProbe + '.err') -ErrorAction Stop
  $forceNote = '（没抛异常）pid=' + $pf.Id
} catch { $forceNote = '抛异常：' + $_.Exception.Message }
$newPid5 = Wait-New $before5 $ObserveSeconds
Start-Sleep -Milliseconds 500
$sizeAfter = (Get-Item -LiteralPath $logProbe).Length
Say ('  Start-Process -RedirectStandardOutput <被持有的文件> ⇒ ' + $forceNote)
Say ('  新出现的替身 pid=' + $newPid5 + '（**会起来**：.NET 这一层与 cmd 的 `>>` 不是同一种开法）')
Say ('  那个文件：大小 ' + $sizeBefore + ' → ' + $sizeAfter + '（' + $(if ($sizeAfter -lt $sizeBefore) { '**被截断/清空**' } else { '没变' }) + '）')
Say '  ⇒ 所以 tools\restart-agent.ps1 里那道闸门（与 -ScriptLog 同一个文件就**跳过重定向**）的理由是**这一条**：'
Say '    .NET 的重定向是**覆盖**开（FileMode.Create），指到外层正在追加的那份日志上会把**脚本自己的留痕清空**。'
try { $swx.WriteLine('持有者 · 之后'); $swx.Flush(); $swx.Close(); $fsx.Close() } catch { }
Stop-Stand
if (-not $Keep) { Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue }
Say ''
Say ('════ 结果：通过 ' + $passed + ' · 失败 ' + $failed + ' ════')
if ($failed -eq 0) { exit 0 } else { exit 1 }
