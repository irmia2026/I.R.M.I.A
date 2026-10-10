# ════════════════════════════════════════════════════════════════════════════
# 「停掉界面之后**隔多久**才能把它拉起来」—— 真机定时实验（三组：0s / 3s / 10s）
#
# 为什么要有它（2026-10-10 上级给的事实）：
#   生产上 `tools\restart-agent.ps1 -GuiExe <Release>\irmia_gui.exe` 有过**两次**界面没起来的
#   留痕（2026-10-07 11:27、2026-10-08 03:02），两次都是「**停掉旧界面的同一秒**就发拉起命令」
#   的那一组读数，而用户手工 `Start-Process`（隔了几十秒到几分钟）每次都能起来。
#   判据必须落在"**停掉 → 隔多久 → 拉起**"这个自变量上，隔离验收复现不出来正是因为它不碰真界面。
#
# 本脚本**只碰界面**：按**可执行文件全路径**停（与 restart-agent.ps1 的 `Get-ProcsByExePath` 同形），
# 一个后端进程都不动，也不碰 SnowLuma。
#
# 拉起那条命令与 `restart-agent.ps1` 的 `Invoke-Detached` **逐字节同形**：
#     cmd.exe /s /c ""<exe>" >> "<log>" 2>&1"   ← WMI Win32_Process.Create，ShowWindow=0，工作目录=exe 所在目录
# 观测：进程第一次出现的时刻、**可见顶层窗口**第一次出现的时刻、以及观察窗末还活着没有。
#   ★ "可见窗口出现"才是界面的成败判据 —— 进程起来但人看不见，等于没起来。
#
# 跑法（**会真的重启用户的界面 3 次**，每组做完都把它留成"在跑且有窗口"）：
#   pwsh -NoProfile -File test\restart-gui-timing.ps1
# 参数：
#   -GuiExe  默认 D:\IrmiaAgent\agent\gui\build\windows\x64\runner\Release\irmia_gui.exe
#   -Groups  默认 0,3,10（秒）；-ObserveSeconds 默认 30（单组观测上限）
#   -ListOnly 只打印"现在有几个界面、都是谁"，一个进程都不动
# ════════════════════════════════════════════════════════════════════════════
param(
  [string]$GuiExe = 'D:\IrmiaAgent\agent\gui\build\windows\x64\runner\Release\irmia_gui.exe',
  [string]$LogPath = '',
  [int[]]$Groups = @(0, 3, 10),
  [int]$ObserveSeconds = 30,
  [switch]$ListOnly
)
$ErrorActionPreference = 'Continue'

function Say([string]$Text) {
  Write-Host $Text
  if ($script:LogPath -ne '') { Add-Content -Path $script:LogPath -Value $Text -Encoding UTF8 }
}
function Now-Stamp { return (Get-Date).ToString('HH:mm:ss.fff') }

# 与 restart-agent.ps1 的 `Get-ProcsByExePath` **同一判据**：全路径比（`GetFullPath` + `-ieq`），
# 名字只当过滤器。**绝不按名字杀**——那是 2026-10-08 的事故形状（同名安装被一起停）。
function Get-ProcsByExePath([string]$ExePath) {
  if ($ExePath -eq '') { return @() }
  $full = [System.IO.Path]::GetFullPath($ExePath)
  $name = [System.IO.Path]::GetFileName($full)
  if ($name -eq '') { return @() }
  $picked = @()
  foreach ($p in @(Get-CimInstance Win32_Process -Filter ("Name = '" + $name + "'") -ErrorAction SilentlyContinue)) {
    $path = $p.ExecutablePath
    if (-not $path) { continue }
    $same = $false
    try { if ([System.IO.Path]::GetFullPath($path) -ieq $full) { $same = $true } } catch { }
    if ($same) { $picked += $p }
  }
  return $picked
}

# 顶层窗口读数（与 restart-agent.ps1 的 `[Win32]::Count` 同形）：top-level / visible 两档。
if (-not ('Win32Probe' -as [type])) {
  try {
    Add-Type -TypeDefinition ('using System;using System.Runtime.InteropServices;using System.Text;' +
      'public static class Win32Probe {' +
      'delegate bool EnumProc(IntPtr h, IntPtr l);' +
      '[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);' +
      '[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);' +
      '[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);' +
      '[DllImport("user32.dll")] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);' +
      'public static string Count(int target) {' +
      'int c = 0; int v = 0;' +
      'EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == (uint)target) { c++; if (IsWindowVisible(h)) v++; } return true; }, IntPtr.Zero);' +
      'return "top-level=" + c + " visible=" + v; }' +
      'public static string Titles(int target) {' +
      'string r = "";' +
      'EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == (uint)target && IsWindowVisible(h)) { var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); r += "[" + sb.ToString() + "]"; } return true; }, IntPtr.Zero);' +
      'return r; }' +
      '}') -ErrorAction Stop
  } catch { }
}
function Get-WindowNote([int]$TargetPid) {
  try { if ('Win32Probe' -as [type]) { return ([Win32Probe]::Count($TargetPid)) } } catch { }
  return ''
}
function Get-WindowTitles([int]$TargetPid) {
  try { if ('Win32Probe' -as [type]) { return ([Win32Probe]::Titles($TargetPid)) } } catch { }
  return ''
}

# 拉起：与 restart-agent.ps1 的 Invoke-Detached 同形（cmd /s /c ""exe" >> log 2>&1"，ShowWindow=0）
function Invoke-DetachedShape([string]$Exe, [string]$WorkDir, [string]$Log) {
  $inner = '""' + $Exe + '"'
  if ($Log -ne '') { $inner = $inner + ' >> "' + $Log + '" 2>&1' }
  $inner = $inner + '"'
  $cmd = 'cmd.exe /s /c ' + $inner
  $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $si.ShowWindow = 0
  $created = ([wmiclass]'Win32_Process').Create($cmd, $WorkDir, $si)
  return [pscustomobject]@{ Cmd = $cmd; ReturnValue = $created.ReturnValue; ShellPid = $created.ProcessId }
}

# ─────────────────────────── 主流程 ───────────────────────────
$exeFull = ''
try { $exeFull = [System.IO.Path]::GetFullPath($GuiExe) } catch { }
if (-not (Test-Path $exeFull)) { Write-Host ("界面 exe 不在盘上：" + $GuiExe); exit 2 }
$guiDir = Split-Path -Parent $exeFull
if ($LogPath -eq '') { $LogPath = Join-Path $env:TEMP ('irmia-gui-timing-' + (Get-Date -Format 'MMdd-HHmmss') + '.log') }
$script:LogPath = $LogPath
Remove-Item $LogPath -Force -ErrorAction SilentlyContinue

# 本脚本只碰这一个全路径；别的同名安装（沙盒替身等）一个都不动
$others = @(Get-CimInstance Win32_Process -Filter "Name='irmia_gui.exe'" -ErrorAction SilentlyContinue |
  Where-Object { -not $_.ExecutablePath -or ($_.ExecutablePath -ine $exeFull) })
Say ("实验：真机定时 —— 目标 exe = " + $exeFull)
Say ("拉起形态：cmd.exe /s /c """"<exe>"" >> <log> 2>&1""（与 restart-agent.ps1 的 Invoke-Detached 同形），工作目录 = " + $guiDir)
Say ("别的同名安装（本脚本不碰）：" + (($others | ForEach-Object { $_.ProcessId }) -join ',') + "  共 " + $others.Count + " 个")
Say ("留痕：" + $LogPath)
Say ''

if ($ListOnly) {
  foreach ($p in @(Get-ProcsByExePath $exeFull)) {
    Say ("  目标界面 pid=" + $p.ProcessId + " 创建于 " + $p.CreationDate + " 窗口 " + (Get-WindowNote ([int]$p.ProcessId)) + " " + (Get-WindowTitles ([int]$p.ProcessId)))
  }
  Say '（-ListOnly：一个进程都没动）'
  exit 0
}

$results = @()
foreach ($delay in $Groups) {
  Say ('════════════ 组：停掉后等 ' + $delay + ' 秒再拉起 ════════════')
  # ① 停：按全路径，只停目标那一个；先把"停之前有几个"记下来
  $before = @(Get-ProcsByExePath $exeFull)
  Say ('[' + (Now-Stamp) + '] 停之前目标界面进程=[' + (($before | ForEach-Object { $_.ProcessId }) -join ',') + '] 共 ' + $before.Count + ' 个')
  $killed = @()
  $tKill = Get-Date
  foreach ($p in $before) {
    Say ('[' + (Now-Stamp) + '] 停界面 PID ' + $p.ProcessId + '（' + $exeFull + '）')
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $killed += [int]$p.ProcessId
  }
  # 等"真的没了"（Stop-Process -Force 异步收尾）：这一步的耗时单独记，它是本组的一个读数
  $goneMs = -1
  if ($killed.Count -gt 0) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
      $alive = @($killed | Where-Object { $null -ne (Get-Process -Id $_ -ErrorAction SilentlyContinue) })
      if ($alive.Count -eq 0) { break }
      Start-Sleep -Milliseconds 50
    }
    $sw.Stop(); $goneMs = $sw.ElapsedMilliseconds
  }
  Say ('[' + (Now-Stamp) + '] 旧界面已不在（等 ' + $goneMs + 'ms）· 停掉=' + ($killed -join ','))

  # ② 等（自变量）
  if ($delay -gt 0) { Start-Sleep -Seconds $delay }
  $launchAt = Get-Date
  Say ('[' + (Now-Stamp) + '] 停后 ' + ([int](($launchAt - $tKill).TotalMilliseconds)) + 'ms ⇒ 发拉起命令（本组自变量 = ' + $delay + ' 秒）')
  $res = Invoke-DetachedShape -Exe $exeFull -WorkDir $guiDir -Log $LogPath
  Say ('[' + (Now-Stamp) + '] 拉起读数：WMI 返回码 ' + $res.ReturnValue + ' · 壳 pid ' + $res.ShellPid + ' · 命令行 ' + $res.Cmd)

  # ③ 观测：进程第一次出现 / **可见窗口**第一次出现 / 10 秒档 / 观察窗末是否还在
  $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
  $firstPid = 0; $firstProcMs = -1
  $firstWinPid = 0; $firstWinMs = -1
  $tenSecNote = ''
  $lastPid = 0
  $deadline2 = (Get-Date).AddSeconds($ObserveSeconds)
  while ((Get-Date) -lt $deadline2) {
    $live = @(Get-ProcsByExePath $exeFull)
    if ($live.Count -gt 0) {
      $id = [int]$live[0].ProcessId
      $lastPid = $id
      if ($firstPid -eq 0) { $firstPid = $id; $firstProcMs = $sw2.ElapsedMilliseconds }
      $note = Get-WindowNote $id
      if ($note -match 'visible=(\d+)' -and [int]$Matches[1] -gt 0) {
        if ($firstWinPid -eq 0) {
          $firstWinPid = $id; $firstWinMs = $sw2.ElapsedMilliseconds
          Say ('[' + (Now-Stamp) + '] ★ 可见窗口出现：pid ' + $id + ' 在拉起后 ' + $firstWinMs + 'ms · ' + $note + ' ' + (Get-WindowTitles $id))
        }
      }
    }
    if ($tenSecNote -eq '' -and $sw2.ElapsedMilliseconds -ge 10000) {
      $tenSecNote = '10 秒档：进程=' + $firstPid + '（第一次出现 ' + $firstProcMs + 'ms）· 可见窗口=' + $firstWinPid + '（第一次 ' + $firstWinMs + 'ms）'
      Say ('[' + (Now-Stamp) + '] ' + $tenSecNote)
    }
    if ($firstWinMs -ge 0 -and $sw2.ElapsedMilliseconds -gt ($firstWinMs + 1500)) { break }
    Start-Sleep -Milliseconds 100
  }
  $sw2.Stop()
  $liveEnd = @(Get-ProcsByExePath $exeFull)
  $endPid = 0; $endNote = ''
  if ($liveEnd.Count -gt 0) { $endPid = [int]$liveEnd[0].ProcessId; $endNote = Get-WindowNote $endPid }
  $verdict = 'not-appeared'
  if ($endPid -ne 0 -and $endNote -match 'visible=(\d+)') {
    if ([int]$Matches[1] -gt 0) { $verdict = 'alive-visible' } else { $verdict = 'alive-no-window' }
  } elseif ($firstPid -ne 0) { $verdict = 'appeared-then-exited' }
  Say ('[' + (Now-Stamp) + '] 本组结论：' + $verdict + ' · 末态目标界面=[' + (($liveEnd | ForEach-Object { $_.ProcessId }) -join ',') + '] ' + $endNote)
  if ($tenSecNote -eq '') { $tenSecNote = '10 秒档：进程=' + $firstPid + '（第一次出现 ' + $firstProcMs + 'ms）· 可见窗口=' + $firstWinPid + '（第一次 ' + $firstWinMs + 'ms）' }
  $results += [pscustomobject]@{
    Delay = $delay; Verdict = $verdict; FirstPid = $firstPid; FirstProcMs = $firstProcMs
    FirstWinPid = $firstWinPid; FirstWinMs = $firstWinMs; EndPid = $endPid; EndNote = $endNote
    TenSec = $tenSecNote; GoneMs = $goneMs; Killed = ($killed -join ',')
  }
  Say ''
}

# ④ 收尾自检：必须**只留 1 个**界面，而且它要有可见窗口
Say '════════════ 三组读数汇总 ════════════'
foreach ($r in $results) {
  Say ('  等 ' + $r.Delay + ' 秒 ⇒ ' + $r.Verdict + ' · 进程第一次出现 ' + $r.FirstProcMs + 'ms · 可见窗口第一次出现 ' + $r.FirstWinMs + 'ms · 末态 pid=' + $r.EndPid + ' ' + $r.EndNote)
}
$final = @(Get-ProcsByExePath $exeFull)
Say ''
Say ('收尾自检：目标界面进程数=' + $final.Count + '（必须 = 1）· [' + (($final | ForEach-Object { $_.ProcessId }) -join ',') + ']')
foreach ($p in $final) {
  Say ('  pid ' + $p.ProcessId + ' 窗口 ' + (Get-WindowNote ([int]$p.ProcessId)) + ' ' + (Get-WindowTitles ([int]$p.ProcessId)))
}
Say ('留痕：' + $LogPath)
