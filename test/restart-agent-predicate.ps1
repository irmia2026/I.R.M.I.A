# ════════════════════════════════════════════════════════════════════════════
# `tools\restart-agent.ps1` 的两条**判据**（2026-10-11 与随包那份对齐的那两处）—— 替身验收
#
# ① **主进程判据按安装根锚定**（不许误伤"别的安装"）
#    同一个沙盒里摆**两个**假后端（只是目录不同、都是名为 `node.exe` 的替身）：
#      install-a = 本次要管的这个安装；install-b = "别的安装"（正是要修掉的那个误伤面）。
#    对照只动**一个**变量（两次 `-DryRun`，只读：一个进程都不停、也不拉起任何东西）：
#      · 默认（`-KillMatch` 空）        ⇒ 只命中 install-a 那个
#      · 老默认 `-KillMatch '*dist/main.js*'` ⇒ install-b 也被命中（这就是修掉的那个形状；
#        它还会顺带命中本机真正在跑的后端 —— 判据与安装根无关时"别人的后端"就是这么被杀掉的）
#
# ② **旧实例还活着就拒绝拉起**（`old-not-gone`，与 `packaging\restart.ps1` 同口径）
#    等不到 ⇒ **一个新实例都不起** + `失败=old-not-gone` + 退出码 1 + `[结束]` 仍然恰好一条。
#    "杀不死的进程"在本机**造不出来**（同用户的 `Stop-Process -Force` 一定成功），所以用替身：
#    在子进程里只把**那一个 pid** 的 `Get-Process -Id` 钉成"还活着"（别的 pid 照旧走真 cmdlet）。
#    这不是替脚本做决定 —— 决定（等不到就不拉）与后果（不写 `[实例]`、写 old-not-gone、
#    退出码 1、结尾那句人话）全都是**脚本自己**跑出来的。
#
# 纪律：**绝不碰用户正在跑的界面与后端**（判据按安装根锚定、沙盒在 %TEMP% 下、目标全是替身）、
# 不写真 `data\`、不碰 `config.json`、一个真窗口都不弹（替身是 `/target:winexe`，不建窗口）。
#
# 跑法：pwsh -NoProfile -File test\restart-agent-predicate.ps1
# ════════════════════════════════════════════════════════════════════════════
$ErrorActionPreference = 'Continue'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script = Join-Path $Repo 'tools\restart-agent.ps1'

$Box = Join-Path $env:TEMP 'irmia-restart-agent-test'
$DirA = Join-Path $Box 'install-a'
$DirB = Join-Path $Box 'install-b'
$Logs = Join-Path $Box 'logs'
$passed = 0; $failed = 0
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { $script:passed++; Write-Host ("  OK   " + $Name + "  " + $Detail) }
  else { $script:failed++; Write-Host ("  FAIL " + $Name + "  " + $Detail) }
}
function Say([string]$T) { Write-Host $T }
function Kill-Box {
  foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ($p.ExecutablePath -and $p.ExecutablePath.ToLowerInvariant().StartsWith($Box.ToLowerInvariant())) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
# 替身必须**真的是一个 exe 且名为 node.exe**：`Get-AgentProcesses` 的过滤器是 WMI 的
# `Name = 'node.exe'`，判据则是命令行里的**入口全路径**。所以这里编译 `test\stand-in\sleeper.cs`
# （只忙等、不建窗口、不吃 stdin），把它**改名叫 node.exe** —— 不需要拷一个真 ~100MB 的运行时。
function Build-StandIn([string]$OutPath) {
  $src = Join-Path $PSScriptRoot 'stand-in\sleeper.cs'
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  & $csc /nologo /target:winexe ("/out:" + $OutPath) $src 2>&1 | Out-Null
  return (Test-Path $OutPath)
}
# 起一个"假后端"：命令行 = `<安装根>\node.exe <毫秒> <安装根>\dist\main.js`
# （`sleeper.cs` 的 args[0] 是睡多久，所以入口摆第二个；命令行里因此**带着入口全路径**，
#   而那正是 `Get-AgentProcesses` 读的东西）
function Start-FakeBackend([string]$InstallRoot, [int]$Seconds) {
  $exe = Join-Path $InstallRoot 'node.exe'
  $entry = Join-Path $InstallRoot 'dist\main.js'
  $p = Start-Process -FilePath $exe -ArgumentList ([string]($Seconds * 1000)), $entry -PassThru -WindowStyle Hidden
  return $p.Id
}
function Read-Text([string]$Path) {
  if (-not (Test-Path $Path)) { return '' }
  return (Get-Content $Path -Encoding UTF8 | Out-String)
}
# `-DryRun`：脚本自己的"空跑"支（一个进程都不停），判据走的是真跑那个函数。
function Run-DryRun([string]$InstallRoot, [string]$Tag, [string]$KillMatch) {
  $trace = Join-Path $Logs ($Tag + '-trace.log')
  Remove-Item $trace -Force -ErrorAction SilentlyContinue
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script,
    '-Repo', $InstallRoot, '-DryRun', '-DelaySeconds', '0', '-TraceLog', $trace)
  if ($KillMatch -ne '') { $argv += @('-KillMatch', $KillMatch) }
  $out = & pwsh @argv 2>&1 | Out-String
  $code = $LASTEXITCODE
  return [pscustomobject]@{ Code = $code; Trace = (Read-Text $trace); Out = $out }
}
function Hits($run) {
  $n = -1
  if ($run.Trace -match '此刻命中 (\d+) 个 node\.exe') { $n = [int]$Matches[1] }
  $list = @()
  if ($run.Trace -match '此刻命中 \d+ 个 node\.exe：\[([0-9,]*)\]') {
    $list = @($Matches[1] -split ',' | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
  }
  return [pscustomobject]@{ Count = $n; Pids = $list }
}

# ── 准备沙盒 ────────────────────────────────────────────────────────────────
Kill-Box
Start-Sleep -Milliseconds 500
if (Test-Path $Box) { Remove-Item -Recurse -Force $Box -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Path $DirA, $DirB, $Logs -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $DirA 'dist'), (Join-Path $DirB 'dist') -Force | Out-Null

Say '── ① 主进程判据：按安装根锚定（不是按 `*dist/main.js*`） ──'
if ($Box -match ' ') { Say ("  ⚠️ 沙盒路径含空格（" + $Box + "）：替身的命令行需要引号，本脚本不处理，先停下"); exit 2 }
$okStandIn = $true
foreach ($d in @($DirA, $DirB)) {
  if (-not (Build-StandIn (Join-Path $d 'node.exe'))) { $okStandIn = $false }
}
if (-not $okStandIn) { Say '  ⚠️ 替身编译失败（csc.exe 不在），本脚本无法继续'; exit 2 }
# 入口文件摆上（②里"万一日志说不拉、其实拉了"时它是被拉起的那个目标）
Set-Content -Path (Join-Path $DirA 'dist\main.js') -Value '// 替身入口：本文件不会被真的当作后端跑（除非拒绝那一支失效）' -Encoding UTF8
Set-Content -Path (Join-Path $DirB 'dist\main.js') -Value '// 替身入口（另一个安装）' -Encoding UTF8

$aPid = Start-FakeBackend $DirA 240
$bPid = Start-FakeBackend $DirB 240
Start-Sleep -Milliseconds 800
$aAlive = $null -ne (Get-Process -Id $aPid -ErrorAction SilentlyContinue)
$bAlive = $null -ne (Get-Process -Id $bPid -ErrorAction SilentlyContinue)
Check '两个假后端都起来了（不然下面两条判据都是空跑）' ($aAlive -and $bAlive) ("install-a pid=" + $aPid + " · install-b pid=" + $bPid)

$runDefault = Run-DryRun $DirA 'default'
$hitDefault = Hits $runDefault
Check '默认判据只命中**本安装**那一个' `
  (($hitDefault.Count -eq 1) -and ($hitDefault.Pids -contains $aPid) -and ($hitDefault.Pids -notcontains $bPid)) `
  ("命中 " + $hitDefault.Count + " 个：[" + ($hitDefault.Pids -join ',') + "]（expect [" + $aPid + "]）")
Check '默认判据**不**命中"别的安装"的那一个（install-b 不在名单里）' `
  ($hitDefault.Pids -notcontains $bPid) ("install-b pid=" + $bPid)
Check '留痕里写明判据是"按安装根锚定"' `
  ($runDefault.Trace -match '按安装根锚定') ('空跑自检：' + (($runDefault.Trace -split "`n" | Where-Object { $_ -match '空跑自检' }) -join ' ').Trim())

$runLegacy = Run-DryRun $DirA 'legacy' '*dist/main.js*'
$hitLegacy = Hits $runLegacy
Check '老默认 `*dist/main.js*` 会连"别的安装"一起命中（这就是被修掉的那个形状）' `
  ($hitLegacy.Pids -contains $bPid) ("命中 " + $hitLegacy.Count + " 个：[" + ($hitLegacy.Pids -join ',') + "]（含 install-b=" + $bPid + "）")
Check '可覆盖的口子还在（`-KillMatch` 给了就用它）' `
  ($hitLegacy.Pids -contains $aPid) ("命中 " + $hitLegacy.Count + " 个")

Say ''
Say '── ② 旧实例还活着 ⇒ 拒绝拉起（old-not-gone / 不拉起 / 退出码 1 / [结束] 恰好一条） ──'
# 驱动：子进程里只把**那一个** pid 钉成"还活着"。写成文件而不是 `-Command`：路径里有中文，
# 命令行转义那一层不值得赌（这个文件存 UTF-8 **带 BOM**，5.1 读它也不会拆坏中文）。
$driver = Join-Path $Logs 'zombie-driver.ps1'
$traceR = Join-Path $Logs 'refuse-trace.log'
$scriptR = Join-Path $Logs 'refuse-script.log'
$codeR = Join-Path $Logs 'refuse-code.txt'
Remove-Item $traceR, $scriptR, $codeR -Force -ErrorAction SilentlyContinue
$driverText = @'
# 替身驱动（由 test\restart-agent-predicate.ps1 现场写出）
param(
  [int]$ZombiePid,
  [string]$Repo,
  [string]$Script,
  [string]$TraceLog,
  [string]$ScriptLog,
  [string]$ExitCodeFile
)
$global:IrmiaZombiePid = $ZombiePid

# 只对**那一个** pid 说"它还活着"；其余 pid 照旧问真的 cmdlet。
# 这不是替脚本做决定：决定与后果全部由脚本自己算、自己写。
function Get-Process {
  [CmdletBinding()]
  param([int[]]$Id, [string[]]$Name)
  if ($null -ne $Id -and ($Id -contains $global:IrmiaZombiePid)) {
    return [pscustomobject]@{ Id = $global:IrmiaZombiePid; ProcessName = 'node'; Handles = 0 }
  }
  if ($null -ne $Id) { return Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction SilentlyContinue }
  if ($null -ne $Name) { return Microsoft.PowerShell.Management\Get-Process -Name $Name -ErrorAction SilentlyContinue }
  return Microsoft.PowerShell.Management\Get-Process
}

& $Script -Repo $Repo -NodeExe (Join-Path $Repo 'node.exe') -NodeEntry 'dist\main.js' `
  -OutLog (Join-Path $Repo 'backend.out.log') -ErrLog (Join-Path $Repo 'backend.err.log') `
  -TraceLog $TraceLog -ScriptLog $ScriptLog -ExitCodeFile $ExitCodeFile `
  -DelaySeconds 0 -WaitSeconds 1 -PortWaitSeconds 2 -NodeMaxOldSpaceMb 0
# 脚本在"拒绝拉起"那一支自己 `exit 1` ⇒ 正常情况走不到这一行；走到了就是它没拒绝。
$code = 0
if ($null -ne $LASTEXITCODE) { $code = $LASTEXITCODE }
Write-Host ('脚本正常返回（没有走 exit 那条路）：code=' + $code)
exit $code
'@
Set-Content -Path $driver -Value $driverText -Encoding utf8BOM

$dOut = & pwsh -NoProfile -ExecutionPolicy Bypass -File $driver `
  -ZombiePid $aPid -Repo $DirA -Script $Script -TraceLog $traceR -ScriptLog $scriptR -ExitCodeFile $codeR 2>&1 | Out-String
$dCode = $LASTEXITCODE
$rTrace = Read-Text $traceR
$rScript = Read-Text $scriptR
$rCode = (Read-Text $codeR).Trim()
$endLines = @($rTrace -split "`n" | Where-Object { $_ -match '\[结束\]' })

Check '退出码=1（进程退出码）' ($dCode -eq 1) ('child exit=' + $dCode)
Check '退出码=1（-ExitCodeFile 那一份，服务端读的是它）' ($rCode -eq '1') ('文件里=' + $rCode)
Check '如实报 old-not-gone' ($rTrace -match '拒绝拉起（old-not-gone）') '留痕里有"拒绝拉起（old-not-gone）"'
Check '**没有**拉起新实例（留痕里没有"拉起后端："那一行）' (-not ($rTrace -match '拉起后端：')) '一个拉起动作都没发生'
Check '**没有**写 `[实例]`（那行只在"真的停掉过旧实例"时才敢说）' (-not ($rTrace -match '\[实例\]')) ''
Check '结尾那句人话说了"一个进程都没拉起"' ($rTrace -match '一个进程都没拉起') ''
Check '`[结束]` 仍然**恰好一条**（exit 穿过 finally 没有写出第二条）' ($endLines.Count -eq 1) ('条数=' + $endLines.Count)
Check '那条 `[结束]` 是 ok=False + 失败=old-not-gone' `
  (($endLines.Count -eq 1) -and ($endLines[0] -match 'ok=False') -and ($endLines[0] -match '失败=old-not-gone')) `
  (($endLines | ForEach-Object { $_.Trim() }) -join ' | ')
Check '驱动自己也没崩（不是"没跑起来"那种假绿）' ($rTrace -match '\[回执\] 脚本已启动') '留痕第一行是回执'

Say ''
Say '── 收尾 ──'
Kill-Box
Start-Sleep -Milliseconds 300
$left = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($Box.ToLowerInvariant()) })
Check '替身全部收干净（沙盒里一个进程都不剩）' ($left.Count -eq 0) ('剩 ' + $left.Count + ' 个')
Say ''
Say ('读数：' + $passed + ' 项过 / ' + $failed + ' 项失败')
if ($failed -gt 0) { exit 1 }
exit 0
