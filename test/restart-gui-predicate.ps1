# ════════════════════════════════════════════════════════════════════════════
# `tools\restart-agent.ps1` 界面判据与四态读数 —— 隔离验收（**一个窗口都不弹**）
#
# 钉三件事（上级 2026-10-08 的裁决）：
#   ① **备用安装不许被误杀**：另一个目录下**同名**的 exe 在跑 ⇒ 跑完必须**仍然活着**（正面断言）
#   ② **目标安装的界面照旧被停**（现有行为不变）
#   ③ **四种形态各自可分辨**：没出现 / 出现即退 / 出现但无窗口 / 出现且有窗口
#
# 2026-10-10 晚（界面那一支换成 `Start-Process` 之后）加的四条：
#   ④ **留痕里必须写着用的是哪条形状**（`形状=Start-Process`，结尾行里也有 `界面形状=`）；
#   ⑤ **"没出现"那一族的分类变细了**：零字节坏 exe 现在当场抛异常 ⇒ `spawn-threw`
#      （旧形状只会"WMI 返回码 0 + 什么都没说"）——所以 (a) 断言的是**这一族**，并打印是哪一种；
#   ⑥ **"出现即退"第一次抓得住"比采样还快就退"**：活 0ms 的替身
#      （旧形状的采样判据只能把它报成 not-appeared，两者分不开）；
#   ⑦ **闸门**：`-GuiLog` 与 `-ScriptLog` 是同一个文件（**且那个文件正被外层持有**，生产形状）
#      ⇒ 跳过重定向、界面照旧起来（见 test\restart-gui-launch-shape.ps1 第 ⑥ 格测出的理由：
#      .NET 的重定向是覆盖开，指到外层正在追加的日志上会把脚本自己的留痕清空）。
#
# 替身是**现场编译的无窗口 exe**（`test\stand-in\sleeper.cs`，只忙等、不建窗口、不吃 stdin）。
# **绝不碰用户正在跑的界面**（它在 D:\IrmiaAgent\... 下，本脚本的沙盒在 %TEMP% 下）。
#
# 2026-10-10 晚的两条**替身纪律**（换形状时被这条判据咬到过，都是替身的问题、不是脚本的问题）：
#   · 替身必须编译成 **GUI 子系统**（`/target:winexe`）：真 `irmia_gui.exe` 就是 GUI 子系统
#     （`gui\windows\runner\main.cpp` 里那个 `CreateAndAttachConsole` 只在**调试器**下才走），
#     而**控制台子系统**的替身被 `Start-Process` 拉起时会**多出一个控制台窗口** ——
#     于是"出现但无窗口"这一态会被误读成"出现且有窗口"（旧形状看不出来：它那层 cmd 带
#     `ShowWindow=0` + 重定向，控制台窗口本来就不会出现）。
#   · 长命替身要**活够**：一次 `Run-Script` 现在要 ~60 秒（观察窗 40 秒 + 两次 3 秒复看 + 收尾），
#     所以 ①② 那两个替身用 180 秒，而不是 `sleeper.cs` 的默认 60 秒（默认值会在检查之前自己到期，
#     于是"备用安装没被误杀"被误判成 FAIL —— 那一次留痕里**没有**"匹配回落"、也**没停**备用那个 pid，
#     是替身自己到点了）。
#
# 跑法：pwsh -NoProfile -File test\restart-gui-predicate.ps1
# ════════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script = Join-Path $Repo 'tools\restart-agent.ps1'

$Box = Join-Path $env:TEMP 'irmia-gui-predicate-test'
$DirA = Join-Path $Box 'install-a\gui'     # 目标安装
$DirB = Join-Path $Box 'install-b\gui'     # 备用安装（**同名** exe，不同目录）
$Logs = Join-Path $Box 'logs'
$passed = 0; $failed = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { $script:passed++; Write-Host ("  OK   " + $Name + "  " + $Detail) }
  else { $script:failed++; Write-Host ("  FAIL " + $Name + "  " + $Detail) }
}
function Say([string]$T) { Write-Host $T }
function Is-Running([int]$ProcId) { return ($null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)) }
function Kill-Box {
  foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($p.ExecutablePath -and $p.ExecutablePath.ToLowerInvariant().StartsWith($Box.ToLowerInvariant())) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
# 替身必须**真的是一个 exe**：`.cmd` 垫片由 cmd.exe 代跑，进程的 ExecutablePath 是 cmd.exe，
# 按全路径永远匹配不到——那样的替身会把四态全"假装"成"没出现"（第一版就这么踩了）。
function Build-Sleeper([string]$OutPath) {
  $src = Join-Path $PSScriptRoot 'stand-in\sleeper.cs'
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  # `/target:winexe` = **GUI 子系统**：与真 `irmia_gui.exe` 同一个子系统，绝不建控制台窗口
  # （理由见文件头那两条替身纪律）。少一个控制台窗口，"无窗口"那一态才是真的无窗口。
  & $csc /nologo /target:winexe ("/out:" + $OutPath) $src 2>&1 | Out-Null
  return (Test-Path $OutPath)
}
function Wait-Running([int]$ProcId, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Is-Running $ProcId) { return $true }
    Start-Sleep -Milliseconds 100
  }
  return $false
}
function Start-Stand([string]$Path, [string]$ArgLine) {
  $a = @()
  if ($ArgLine -ne '') { $a = @($ArgLine) }
  $p = Start-Process -FilePath $Path -ArgumentList $a -PassThru -WindowStyle Hidden
  return $p.Id
}
function Run-Script([string]$GuiExe, [string]$Tag, [string]$GuiArgs, [string]$GuiLog, [switch]$HoldScriptLog) {
  $trace = Join-Path $Logs ($Tag + '-trace.log')
  $scriptLog = Join-Path $Logs ($Tag + '-script.log')
  Remove-Item $trace, $scriptLog -Force -ErrorAction SilentlyContinue
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script,
    '-Repo', $Box, '-GuiExe', $GuiExe, '-GuiOnly', '-DelaySeconds', '0',
    '-PortWaitSeconds', '2', '-WaitSeconds', '1', '-TraceLog', $trace, '-ScriptLog', $scriptLog)
  # `-GuiArgs` 是脚本本来就有的口子（"替身要按参数活多久"），替身靠它决定睡多久
  if ($GuiArgs -ne '') { $argv += @('-GuiArgs', $GuiArgs) }
  if ($GuiLog -ne '') { $argv += @('-GuiLog', $GuiLog) }
  # 生产形状的那个自变量：`-ScriptLog` **此刻正被外层（服务端的 cmd）持有写句柄**。
  # 复现它只需要一个"追加 + FileShare.ReadWrite"的持有者（与 `_research\probe-held-handle.ps1`
  # 的 D1 同一种持有；注意它已经很宽容了，照样挡得住 cmd 的 `>>`，见 shape 矩阵第 ③ 格）。
  $holdFs = $null
  $holdSw = $null
  if ($HoldScriptLog) {
    $holdFs = [System.IO.File]::Open($scriptLog, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
    $holdSw = New-Object System.IO.StreamWriter($holdFs)
    $holdSw.AutoFlush = $true
    $holdSw.WriteLine('外层持有者：这个文件的写句柄在我手上（模拟服务端的 cmd >> 同一文件）')
  }
  $out = & pwsh @argv 2>&1 | Out-String
  $code = $LASTEXITCODE
  if ($holdSw -ne $null) { try { $holdSw.WriteLine('外层持有者：脚本跑完了，我还在写'); $holdSw.Flush(); $holdSw.Close(); $holdFs.Close() } catch { } }
  $traceText = ''
  if (Test-Path $trace) { $traceText = (Get-Content $trace -Encoding UTF8 | Out-String) }
  return [pscustomobject]@{ Out = $out; Code = $code; Trace = $traceText; ScriptLog = $scriptLog }
}
function State-Of($run) {
  # 六态都认（"没出现"那一族有三种）：四态判据没变，变的是失败**分类**变细了（见文件头 ⑤）
  $s = ''
  if ($run.Trace -match '界面拉起=(not-appeared|spawn-threw|spawn-failed|appeared-then-exited|alive-no-window|alive)') { $s = $Matches[1] }
  return $s
}

# ── 准备沙盒 ────────────────────────────────────────────────────────────────
Kill-Box
Start-Sleep -Milliseconds 500
if (Test-Path $Box) { Remove-Item -Recurse -Force $Box -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $DirA, $DirB, $Logs | Out-Null
$GuiA = Join-Path $DirA 'irmia_gui.exe'    # 目标：活 60 秒
$GuiB = Join-Path $DirB 'irmia_gui.exe'    # 备用：**同名**、不同目录、活 60 秒
$okA = Build-Sleeper $GuiA
$okB = Build-Sleeper $GuiB
$BadExe = Join-Path $DirA 'irmia_bad.exe'  # 没出现：零字节，cmd 建不起来
[System.IO.File]::WriteAllBytes($BadExe, @())
$DieExe = Join-Path $DirA 'irmia_die.exe'  # 出现即退：只活 2 秒
$okD = Build-Sleeper $DieExe

Say ("沙盒：$Box")
Say ("目标安装替身：$GuiA（编译=$okA）")
Say ("备用安装替身：$GuiB（**同名**、不同目录，编译=$okB）")
Say ("出现即退替身：$DieExe（编译=$okD）")
$hostGui = @(Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -notlike ($Box + '*') } | ForEach-Object { $_.Id })
Say ("用户那个界面（本脚本绝不碰）：$($hostGui -join ',')")
Say ''

if (-not ($okA -and $okB -and $okD)) {
  Say '替身编译失败，后面不用跑了'
  exit 2
}

# ════════════════ ①② 判据：只停目标全路径，备用安装不许被误杀 ════════════════
Say '════ ①② 判据：全路径匹配（备用安装不许被误杀 · 目标照旧被停） ════'
$pidA = Start-Stand $GuiA '180000'   # 活 180 秒：一次 Run-Script 要 ~60 秒，替身必须活够（见文件头）
$pidB = Start-Stand $GuiB '180000'   # 备用那个同理：它"还在跑"正是本节的正面断言
$aUp = Wait-Running $pidA 8
$bUp = Wait-Running $pidB 8
Say ("  起好两个替身：目标 pid=$pidA（活=$aUp）· 备用 pid=$pidB（活=$bUp）")
if ($aUp -and $bUp) {
  $r = Run-Script $GuiA 'case12'
  Start-Sleep -Seconds 1
  $aliveA = Is-Running $pidA
  $aliveB = Is-Running $pidB
  Check '① 备用安装（同名、不同目录）**没被误杀**' ($aliveB -eq $true) ("备用 pid=$pidB 跑完仍在=" + $aliveB)
  Check '② 目标安装的界面**被停掉**' ($aliveA -eq $false) ("目标 pid=$pidA 跑完仍在=" + $aliveA)
  Check '① 留痕提到目标路径、不提备用路径' `
    (($r.Trace -match [regex]::Escape($GuiA)) -and ($r.Trace -notmatch [regex]::Escape($GuiB))) `
    '留痕按全路径写'
  $stopLine = @($r.Trace -split "`n" | Where-Object { $_ -match '停界面 PID' })
  if ($stopLine.Count -gt 0) { Say ('    停界面留痕：' + $stopLine[0].Trim()) }
} else {
  Check '替身起得来（测试前置）' $false ('目标活=' + $aUp + ' 备用活=' + $bUp)
}
Kill-Box
Start-Sleep -Milliseconds 500
Say ''

# ════════════════ ③ 四态可分辨 ════════════════
Say '════ ③ 四种形态各自可分辨（替身一律无窗口） ════'

# (a) 没出现：零字节坏 exe。
#     2026-10-10 之后这一格断言的**是"没出现"那一族**（not-appeared / spawn-threw / spawn-failed）：
#     换成 `Start-Process` 之后，"建不起来"会**当场抛异常**（spawn-threw，带上异常原文），
#     而旧形状只会"WMI 返回码 0 + 什么都没说"（not-appeared）。分类变细了，不是判据松了。
$ra = Run-Script $BadExe 'case-a'
$sa = State-Of $ra
$notAppearedFamily = @('not-appeared', 'spawn-threw', 'spawn-failed')
Check '(a) 没出现 ⇒ 落在"没出现"那一族' ($notAppearedFamily -contains $sa) ("State=" + $sa + " 退出码=" + $ra.Code)

# (a2) 形状必须写进留痕（2026-10-10 加：下次出问题，第一句要能回答"用的是哪条形状"）
Check '(a2) 留痕写着形状=Start-Process（拉起读数与结尾行各一处）' `
  (($ra.Trace -match '形状=Start-Process') -and ($ra.Trace -match '界面形状=Start-Process')) `
  '拉起读数/结尾行都带形状'

# (b) 出现即退：活 2 秒的替身（活过采样、活不过 3 秒复看 ⇒ 必须被看见过）
#     参数从脚本本来就有的 `-GuiArgs` 进去（替身靠它决定睡多久）
$rb = Run-Script $DieExe 'case-b' '2000'
$sb = State-Of $rb
Check '(b) 出现即退 ⇒ appeared-then-exited' ($sb -eq 'appeared-then-exited') ("State=" + $sb + " 退出码=" + $rb.Code)

# (b2) **比采样更快就退**（活 0ms）：旧形状的采样判据只能报 not-appeared（两者分不开），
#      新形状有 `-PassThru` 的 pid 与退出码在手 ⇒ 必须报 appeared-then-exited，且带上退出码。
$rb2 = Run-Script $DieExe 'case-b2' '0'
$sb2 = State-Of $rb2
Check '(b2) 起来就退（0ms）⇒ appeared-then-exited（新形状才分得出这一态）' ($sb2 -eq 'appeared-then-exited') ("State=" + $sb2 + " 退出码=" + $rb2.Code)
Check '(b2) 退出码被写进留痕（旧形状读不到退出码）' ($rb2.Trace -match '退出码 [0-9-]+') '留痕含 ExitCode'

# (c) 出现但无窗口：活 60 秒的无窗口替身
Kill-Box
Start-Sleep -Milliseconds 500
$rc = Run-Script $GuiA 'case-c'
$sc = State-Of $rc
Check '(c) 活着但无窗口 ⇒ alive-no-window' ($sc -eq 'alive-no-window') ("State=" + $sc + " 退出码=" + $rc.Code)

# (d) 闸门：`-GuiLog` == `-ScriptLog`，而那个文件**正被外层持有**（生产形状）
#     ⇒ 跳过重定向，界面照旧起来（若把两个流指过去，.NET 会**覆盖**开、清空脚本自己的留痕）
Kill-Box
Start-Sleep -Milliseconds 500
$rd = Run-Script $GuiA 'case-d' '' (Join-Path $Logs 'case-d-script.log') -HoldScriptLog
$sd = State-Of $rd
Check '(d) 重定向目标与 -ScriptLog 同一个文件（且被外层持有）⇒ 跳过重定向，界面照旧起来' ($sd -eq 'alive-no-window') ("State=" + $sd + " 退出码=" + $rd.Code)
Check '(d) 留痕写明"跳过重定向"与理由' ($rd.Trace -match '跳过：与脚本自己的 stdout 落点') '留痕含跳过原因'

Say ''
Say '──────── 四态留痕原文（证据） ────────'
foreach ($t in @(@('a 没出现', $ra), @('b 出现即退', $rb), @('b2 起来就退(0ms)', $rb2), @('c 出现但无窗口', $rc), @('d 闸门(跳过重定向)', $rd))) {
  Say ("  [" + $t[0] + "]")
  $hit = @($t[1].Trace -split "`n" | Where-Object { $_ -match '界面读数|窗口读数|拉起失败读数|拉起读数|拉起成功' } | Select-Object -First 2)
  if ($hit.Count -eq 0) { Say '    （没抓到行）' } else { $hit | ForEach-Object { Say ('    ' + $_.Trim()) } }
}
Say ''
Say '──────── 结尾行（`[结束]`：四态与失败原因都写在这里） ────────'
foreach ($t in @(@('a', $ra), @('b', $rb), @('b2', $rb2), @('c', $rc), @('d', $rd))) {
  $end = @($t[1].Trace -split "`n" | Where-Object { $_ -match '\[结束\]' } | Select-Object -First 1)
  if ($end.Count -gt 0) { Say ('  [' + $t[0] + '] ' + $end[0].Trim()) }
}

Kill-Box
Start-Sleep -Milliseconds 500
Say ''
Say ("════ 结果：通过 $passed · 失败 $failed ════")
$hostGui2 = @(Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -notlike ($Box + '*') } | ForEach-Object { $_.Id })
Say ("用户那个界面（必须仍在跑）：$($hostGui2 -join ',')")
if ($failed -eq 0) { exit 0 } else { exit 1 }
