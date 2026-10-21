# Irmia Agent — 「重启判据认不认得出命令行形状」的**可复跑**验证（2026-10-07 晚，第二笔修）
#
# 治的是什么：`tools/restart-agent.ps1` 找主进程用的是 `-like '*dist/main.js*'`（正斜杠），
# 而服务端传的入口是**绝对路径**（`-NodeEntry "D:\…\dist\main.js"`）⇒ 拉起之后的命令行里是
# `dist\main.js`（反斜杠）⇒ 匹配不到 ⇒ 什么都没停、什么都没起，结尾却报 `port=ready`
# （那个端口上是**没被换掉的旧实例**）。实测留痕：
#   `[结束] ok=False backendPid=69420 port=ready … 停掉的主进程= （空）`
#
# 这个脚本在**隔离副本**里把三种命令行形状各跑一遍（真杀、真拉、真读 lock.json）：
#   ① 绝对入口 + 反斜杠：`"<node>" "C:\…\root\dist\main.js"`   ← 现场那种形状（默认判据）
#   ② 绝对入口 + 正斜杠：`"<node>" "C:/…/root/dist/main.js"`   ← 分隔符无关的另一半
#   ③ 相对入口：        `-NodeEntry 'dist/main.js'` + `-Repo <root>`（真跑时入口由 -Repo 绝对化）
# 外加一条**如实性**用例：判据故意认不出那个进程时，必须报 `no-target-process` +
# `自检=主进程0个`，**不许**报端口就绪（这正是今晚骗过结尾那行的形状）。
#
# ── 隔离纪律（2026-10-07 晚吃过一次亏，这几条是硬的） ──
#   · 每一次场景都往脚本传 `-KillTag <唯一 tag>` ⇒ 这次拉起的进程命令行里带得出那个 tag，
#     收尾只按 **tag** 找它（绝不用 `*dist/main.js*` 那种宽判据去收尾）；
#   · 场景③ 传的 `-Repo` 是**沙盒**，`-NodeEntry` 是相对沙盒的 `dist/main.js`——
#     不这么写的话脚本会把它解析成真仓库的入口，从而拉起一个**真的后端副本**（这就是那次亏）；
#     脚本侧也一起钉死了：相对路径现在**相对 `-Repo`** 解析，不再用进程 cwd；
#   · 中途与收尾的 Stop-Process 只认 root/tag 两个字符串，用户在用的那个实例一个字节都不碰；
#   · 界面支路用的是**沙盒里自己写的 .cmd 替身**——绝不用
#     `D:\IrmiaAgent\agent\gui\build\…\irmia_gui.exe` 那个真路径起进程（那会给用户弹一个真窗口）。
#
# 用法（从仓库根跑）：pwsh -File tools/verify-restart-match.ps1
# 退出码 0 = 全部判据对上；非 0 = 有对不上的（脚本会把对不上的那条打出来）。

param(
  [string]$Root = 'C:\irmia-verify-match',
  [int]$Port = 7798,
  [string]$Repo = '<repo>',
  [string]$NodeExe = 'D:\IrmiaAgent\tools\node\node.exe',
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$fail = @()
function Check([string]$What, [bool]$Ok, [string]$Detail) {
  if ($Ok) { Write-Host ("  [ok]   {0}" -f $What) }
  else { Write-Host ("  [FAIL] {0} —— {1}" -f $What, $Detail); $script:fail += $What }
}

# 只碰这一份副本里的进程：判据是 root 路径（沙盒独有），**不是** `*dist/main.js*`（那会伤到真实例）
function Stop-SandboxNode {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Root*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400
}

# 收尾专用：**只按 tag** 停（`-KillTag` 让"这次拉起的那个"在命令行里自带唯一标记）。
# 找不到就什么都不做——宁可留一个进程人工看，也不拿宽判据去扫。
function Stop-Tagged([string]$Tag) {
  $hit = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$Tag*" })
  foreach ($p in $hit) {
    Write-Host ("  （收尾）停掉本次拉起的 pid={0}" -f $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 600
}

# 替身后端：写自己的 lock.json、在隔离端口上听，并把"我是谁、我的命令行长什么样"写进日志
$MockJs = @'
const http = require('http'); const fs = require('fs'); const path = require('path');
const repo = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const dataDir = cfg.dataDir;
if (fs.existsSync(path.join(dataDir, 'stop-now'))) process.exit(0);
const write = () => fs.writeFileSync(path.join(dataDir, 'lock.json'),
  JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
write();
fs.appendFileSync(path.join(dataDir, 'shape.log'), 'pid=' + process.pid + ' argv=' + JSON.stringify(process.argv.slice(1)) + '\n');
http.createServer((q, s) => { s.end('ok'); }).listen(cfg.web.port, cfg.web.host, () => {
  fs.appendFileSync(path.join(dataDir, 'shape.log'), 'listening pid=' + process.pid + '\n');
});
setInterval(write, 300);
setTimeout(() => process.exit(0), 300000);
'@

function Initialize-Sandbox {
  Stop-SandboxNode
  Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path "$Root\data","$Root\logs","$Root\tools","$Root\dist" -Force | Out-Null
  # 只搬脚本本身 + 一个替身入口：这一组验的是**判据**（真 dist/main.js 会去连真 dataDir）
  Copy-Item "$Repo\tools\restart-agent.ps1" "$Root\tools\restart-agent.ps1" -Force
  [System.IO.File]::WriteAllText("$Root\dist\main.js", $MockJs, (New-Object System.Text.UTF8Encoding($false)))
  $cfg = @{ schemaVersion = 1; dataDir = "$Root\data"; web = @{ host = '127.0.0.1'; port = $Port } } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText("$Root\config.json", $cfg, (New-Object System.Text.UTF8Encoding($false)))
}

# 起"重启前那个后端"。`-Tag` 给了就把它也缀进命令行（与 -KillTag 同一形状），收尾只按它找。
function Start-OldInstance([string]$EntryFull, [string]$Tag) {
  $args = @($EntryFull)
  if ($Tag -ne '') { $args += "--kill-tag=$Tag" }
  $p = Start-Process -FilePath $NodeExe -ArgumentList $args -WorkingDirectory $Root `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput "$Root\logs\old.out.log" `
    -RedirectStandardError "$Root\logs\old.err.log"
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { break }
  }
  return $p
}

function Invoke-Restart([string]$NodeEntry, [string]$Tag, [string]$FakeGui = '', [string]$FakeGuiArgs = '') {
  $trace = "$Root\data\restart-trace.log"
  $exitFile = "$Root\data\restart-exit.txt"
  Remove-Item $trace, $exitFile -Force -ErrorAction SilentlyContinue
  # 默认 KillMatch（**不传**：验的就是它认不认得出这些形状）；`-KillMatchAlso root` 把范围锁在副本里
  $extra = @()
  if ($FakeGui -ne '') { $extra = @('-GuiExe', $FakeGui) }
  if ($FakeGuiArgs -ne '') { $extra += @('-GuiArgs', $FakeGuiArgs) }
  & 'D:\Tools\pwsh7\pwsh.exe' -NoProfile -File "$Root\tools\restart-agent.ps1" `
    -Repo $Root -NodeEntry $NodeEntry -KillMatchAlso $Root -KillTag $Tag @extra `
    -TraceLog $trace -ScriptLog "$Root\data\restart-script.log" -ExitCodeFile $exitFile `
    -OutLog "$Root\logs\new.out.log" -ErrLog "$Root\logs\new.err.log" `
    -PortWaitSeconds 45 -WaitSeconds 1 -DelaySeconds 0 2>&1 | Out-String | Write-Host
  return @{
    Trace = if (Test-Path $trace) { Get-Content $trace -Raw -Encoding UTF8 } else { '' }
    Exit = (Get-Content $exitFile -Raw -ErrorAction SilentlyContinue)
  }
}

function Assert-Restarted([string]$Label, [string]$Trace, [int]$OldPid) {
  Check "$Label · 留下的 [回执]（脚本真的跑起来了）" ($Trace -match '\[回执\]') '留痕里没有 [回执]'
  $m = [regex]::Match($Trace, '\[实例\][^\r\n]*?pid=(\d+)')
  Check "$Label · 留下的 [实例]（后端换了 pid）" $m.Success "留痕里没有 [实例]：$Trace"
  $newPid = if ($m.Success) { [int]$m.Groups[1].Value } else { 0 }
  Check "$Label · 新 pid 与旧 pid 不同（$OldPid → $newPid）" ($newPid -ne 0 -and $newPid -ne $OldPid) 'pid 没换：重启没有发生'
  Check "$Label · 新 pid 真的是个活着的进程" ([bool](Get-Process -Id $newPid -ErrorAction SilentlyContinue)) "pid $newPid 查无此人"
  $live = (Get-Content "$Root\data\lock.json" -Raw | ConvertFrom-Json).pid
  Check "$Label · lock.json 的真 pid 与脚本报的一致（$live）" ($live -eq $newPid) "lock.json 说 $live，脚本说 $newPid"
  $e = [regex]::Match($Trace, '\[结束\][^\r\n]*')
  Check "$Label · 结尾那行 ok=True" ($e.Success -and $e.Value -match 'ok=True') "结尾行：$($e.Value)"
  Check "$Label · 结尾那行 port=ready（**不是** foreign）" ($e.Value -match 'port=ready') "结尾行：$($e.Value)"
  Check "$Label · 自检说找到了主进程" ($Trace -match '\[自检\] 找到在跑的主进程 \d+ 个') '缺 [自检] 那行'
  Check "$Label · 退出码是 0" ((Get-Content "$Root\data\restart-exit.txt" -Raw -ErrorAction SilentlyContinue).Trim() -eq '0') '退出码文件不是 0'
  return $newPid
}

# ──────────────────────────── 场景：三种命令行形状 ────────────────────────────

$shapes = @(
  @{ Label = '① 绝对入口 + 反斜杠（现场那种形状）'; EntryArg = ("$Root" + '\dist\main.js') },
  @{ Label = '② 绝对入口 + 正斜杠';                 EntryArg = ("$Root" + '/dist/main.js') },
  @{ Label = '③ 相对入口（-Repo 指向沙盒 ⇒ 绝对化到沙盒那份）'; EntryArg = 'dist/main.js' }
)

$shapeIndex = 0
foreach ($shape in $shapes) {
  $shapeIndex += 1
  $tag = "irmia-verify-match-shape$shapeIndex"
  Write-Host ""
  Write-Host ("=== {0} ===" -f $shape.Label)
  Initialize-Sandbox
  $entryFull = "$Root\dist\main.js"
  $old = Start-OldInstance $entryFull $tag
  $oldPid = (Get-Content "$Root\data\lock.json" -Raw | ConvertFrom-Json).pid
  Write-Host "  旧实例 pid=$oldPid（脚本收到的入口参数：$($shape.EntryArg)）"
  $r = Invoke-Restart $shape.EntryArg $tag
  $newPid = Assert-Restarted $shape.Label $r.Trace ([int]$oldPid)
  Check "$Label · 旧实例确实不在了（pid $oldPid）" (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) "pid $oldPid 还活着"
  # 收尾：只按 tag 停（本次拉起的那个），再按 root 兜一遍，最后让替身下次直接退出
  Stop-Tagged $tag
  New-Item -ItemType File -Path "$Root\data\stop-now" -Force | Out-Null
  Stop-SandboxNode
}

# ──────────────────────────── 场景：判据认不出时必须如实说 ────────────────────────────
#
# 这一条是今晚那个形状的**直接回归**：命令行里没有 `dist/main.js`（入口名字不一样），
# 判据命中 0 个 ⇒ 什么都不该停、也不该报"新后端已就绪"。
Write-Host ""
Write-Host '=== ④ 判据认不出（入口名不同）⇒ 必须报 no-target-process，不许报端口就绪 ==='
Initialize-Sandbox
$tag = 'irmia-verify-match-other'
$otherEntry = "$Root\dist\other-entry.js"
Copy-Item "$Root\dist\main.js" $otherEntry -Force
$old = Start-OldInstance $otherEntry $tag
$oldPid = (Get-Content "$Root\data\lock.json" -Raw | ConvertFrom-Json).pid
Write-Host "  在跑的实例 pid=$oldPid（入口 other-entry.js，判据 *dist/main.js* 认不出它）"
$r = Invoke-Restart $otherEntry $tag
$t = $r.Trace
$endLine = [regex]::Match($t, '\[结束\][^\r\n]*').Value
Check '④ 自检**明说**没找到主进程' ($t -match '\[自检\] 没有找到在跑的主进程') "留痕里没有那句自检：$t"
Write-Host ("  ④ 结尾那行（原文）：{0}" -f $endLine)
Check '④ 结尾 ok=False' ($endLine -match 'ok=False') $endLine
Check '④ 结尾说清了原因（no-target-process）' ($t -match '失败=no-target-process') '结尾缺 失败=no-target-process'
Check '④ 结尾**不报** port=ready（端口上那个不是本次拉起的）' (-not ($endLine -match 'port=ready')) $endLine
Check '④ 结尾说清"没找到主进程"' ($t -match '本次没有找到在跑的主进程') '结尾那句话不见了'
Check '④ 退出码非 0' ((Get-Content "$Root\data\restart-exit.txt" -Raw -ErrorAction SilentlyContinue).Trim() -eq '1') '退出码文件不是 1'
Check '④ 旧实例没有被误杀（还活着）' ([bool](Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) "pid $oldPid 不在了——不该动它"
Stop-Tagged $tag
New-Item -ItemType File -Path "$Root\data\stop-now" -Force | Out-Null
Stop-SandboxNode

# ──────────────────────────── 界面支路的替身（**沙盒自备的 exe**） ────────────────────────────
#
# 为什么必须是一个**真 exe**：脚本的"新进程出现了吗"按 **exe 文件名**找进程
# （`Get-Process -Name <exe 去扩展名>`）。`.cmd` / `.ps1` 替身实际的进程名是 `cmd.exe` / `pwsh.exe`
# ⇒ 永远找不到 ⇒ 只会得到"没等到新进程"，那条用例就测不到该测的东西（本机实测过）。
# 本机 `Add-Type -OutputAssembly` 编不出 exe（PowerShell 明确不支持 ConsoleApplication/WindowsApplication），
# 所以这里的替身是：**把 node.exe 复制一份改名**，配一份小脚本——
#   · 它**不是** irmia_gui、也不是它的副本（用户明令：绝不用真 GUI 路径起进程）；
#   · 它把自己看到的 **cwd** 写进文件（证明脚本把工作目录传对了）；
#   · `-Seconds` 决定它活多久：30 秒 ⇒ 应该判成功；1 秒 ⇒ 必须判"起来又退"。
$FauxGuiScript = @'
const fs = require('fs');
// argv[2] = 活多少秒（默认 30），argv[3] = 把"我看到的 cwd"写哪儿
const seconds = Number(process.argv[2] || '30');
const outFile = process.argv[3] || 'cwd.txt';
fs.writeFileSync(outFile, process.cwd());
setTimeout(() => process.exit(0), seconds * 1000);
'@
function New-FauxGui([string]$Dir) {
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $exe = Join-Path $Dir 'irmia-faux-gui.exe'
  if (-not (Test-Path $exe)) { Copy-Item $NodeExe $exe -Force }
  $script = Join-Path $Dir 'faux.js'
  [System.IO.File]::WriteAllText($script, $FauxGuiScript, (New-Object System.Text.UTF8Encoding($false)))
  return $exe
}
# 真跑时脚本给界面的 ArgLine 是空的（界面不接受我们的参数），所以验收走 `-GuiArgs`
# 把"活多久 / cwd 写哪儿"递进去——那条口子只为验收存在，正常重启一个字节都不变。
function FauxGuiArgs([string]$Dir, [int]$Seconds) {
  return '"' + (Join-Path $Dir 'faux.js') + '" ' + $Seconds + ' "' + (Join-Path $Dir 'cwd.txt') + '"'
}
function Stop-FauxGui([string]$Dir) {
  Get-CimInstance Win32_Process -Filter "Name='irmia-faux-gui.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -like "$Dir*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
}

# ──────────────────────────── 场景：界面支路（**沙盒替身**，绝不碰真 irmia_gui） ────────────────────────────
#
# 2026-10-07 晚用户报「GUI 的重启不了，托盘的杀了就没起来」，留痕里那一支是
# `停界面 PID 67852 → 拉起读数 … ⇒ 拉起失败：没等到新的 irmia_gui 进程`。
# 隔离对照（用**真 exe 的沙盒副本**）做下来：同一条命令行能拉起、且活过 5 秒 ⇒ 那条失败的确切
# 原因**未查明**。这一组不去猜原因，只把"以后不许再出现的两种误报"钉死：
#   · 拉起后**必须活过 3 秒**才算成功（过去"出现过一次"就算成功）；
#   · 工作目录**必须显式 = exe 所在目录**，并且替身会把它**自己看到的 cwd 写下来**当凭据。
#
# 替身是**沙盒里自己写的 .cmd**（不是真 irmia_gui，也不是它的副本）：
#   · `cwd.cmd`：把当前目录写进固定文件、然后睡 30 秒 ⇒ 应该判"拉起成功"
#   · `dies.cmd`：同样写 cwd、1.5 秒后自己退 ⇒ 应该判"拉起失败（起来又退了）"
Write-Host ''
Write-Host '=== ⑤ 界面支路（沙盒替身 exe）：拉起成功 = 活过 3 秒 + cwd 是 exe 所在目录 ==='
Initialize-Sandbox
# 这一支要的是"后端好好的、只有界面要重启"那个形状（用户报的正是它）：先起一个真在听的替身后端
$oldGuiCase = Start-OldInstance "$Root\dist\main.js" 'irmia-verify-match-gui-old'
$oldGuiPid = (Get-Content "$Root\data\lock.json" -Raw | ConvertFrom-Json).pid
Write-Host "  旧后端 pid=$oldGuiPid（这一支的重点是界面）"
$guiDir = "$Root\faux-gui"
$fakeGui = New-FauxGui $guiDir
$cwdFile = Join-Path $guiDir 'cwd.txt'
$tag = 'irmia-verify-match-gui'
$r = Invoke-Restart -NodeEntry 'dist/main.js' -Tag $tag -FakeGui $fakeGui -FakeGuiArgs (FauxGuiArgs $guiDir 30)
$t = $r.Trace
$endLine = [regex]::Match($t, '\[结束\][^\r\n]*').Value
Write-Host ("  ⑤ 结尾那行（原文）：{0}" -f $endLine)
$guiPidMatch = [regex]::Match($endLine, 'guiPid=(\d+)')
$guiPid = if ($guiPidMatch.Success) { [int]$guiPidMatch.Groups[1].Value } else { 0 }
Check '⑤ 结尾 guiPid 非 0（界面那一支真的拉起来了）' ($guiPid -ne 0) $endLine
Check '⑤ 拉起后 3 秒仍在跑（活过观察窗才算成功）' ($guiPid -ne 0 -and [bool](Get-Process -Id $guiPid -ErrorAction SilentlyContinue)) "pid $guiPid 不在了"
Check '⑤ 留痕写明了界面的工作目录' ($t -match '拉起界面：工作目录=') '缺那行留痕'
Check '⑤ 替身记下的 cwd = 它自己所在目录（不是仓库、不是脚本的 PWD）' `
  ((Test-Path $cwdFile) -and ((Get-Content $cwdFile -Raw).Trim().TrimEnd('\') -ieq $guiDir.TrimEnd('\'))) `
  "替身记的是：$(if (Test-Path $cwdFile) { (Get-Content $cwdFile -Raw).Trim() } else { '（没写出来）' })；期望 $guiDir"
Check '⑤ 结尾 ok=True（后端与界面都成了）' ($endLine -match 'ok=True') $endLine
Check '⑤ 没有失败原因' (-not ($endLine -match '失败=')) $endLine
if ($guiPid -ne 0) { Stop-Process -Id $guiPid -Force -ErrorAction SilentlyContinue }
Stop-FauxGui $guiDir
Stop-Tagged $tag
New-Item -ItemType File -Path "$Root\data\stop-now" -Force | Out-Null
Stop-SandboxNode

Write-Host ''
Write-Host '=== ⑥ 界面支路：替身起来又自己退 ⇒ 必须判失败，不许误报成功 ==='
Initialize-Sandbox
$oldGuiCase2 = Start-OldInstance "$Root\dist\main.js" 'irmia-verify-match-gui2-old'
$oldGuiPid2 = (Get-Content "$Root\data\lock.json" -Raw | ConvertFrom-Json).pid
Write-Host "  旧后端 pid=$oldGuiPid2（这一支的重点是「起来又退」的界面）"
$guiDir2 = "$Root\faux-gui2"
# 只活 1 秒：它写得下 cwd（证明真被拉起来过），但**活不过 3 秒观察窗** ⇒ 必须判失败
$fakeGui2 = New-FauxGui $guiDir2
$cwdFile2 = Join-Path $guiDir2 'cwd.txt'
$r2 = Invoke-Restart -NodeEntry 'dist/main.js' -Tag 'irmia-verify-match-gui2' -FakeGui $fakeGui2 -FakeGuiArgs (FauxGuiArgs $guiDir2 1)
$t2 = $r2.Trace
$endLine2 = [regex]::Match($t2, '\[结束\][^\r\n]*').Value
Write-Host ("  ⑥ 结尾那行（原文）：{0}" -f $endLine2)
Check '⑥ 替身确实被拉起来过（它写下了自己的 cwd）' (Test-Path $cwdFile2) '替身没写 cwd：这条用例没测到该测的东西'
Check '⑥ 结尾 ok=False（它起来又退了）' ($endLine2 -match 'ok=False') $endLine2
Check '⑥ 失败原因说清是界面没起来' ($t2 -match '失败=gui-not-started') '结尾缺 失败=gui-not-started'
Check '⑥ 留痕说清"起来又退了"（不是含混的"没等到"）' ($t2 -match '就退出了') '缺"3 秒内就退出了"那句话'
Check '⑥ guiPid=0（没把它算成拉起成功）' ($endLine2 -match 'guiPid=0') $endLine2
Stop-FauxGui $guiDir2
Stop-Tagged 'irmia-verify-match-gui2'
New-Item -ItemType File -Path "$Root\data\stop-now" -Force | Out-Null
Stop-SandboxNode

# ──────────────────────────── 收尾 ────────────────────────────
Write-Host ""
Write-Host '=== 收尾：把这份副本里的进程全部停掉 ==='
Stop-SandboxNode
Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue

if ($fail.Count -gt 0) {
  Write-Host ""
  Write-Host ("没对上的判据（{0} 条）：{1}" -f $fail.Count, ($fail -join ' / '))
  exit 1
}
Write-Host ''
Write-Host '全部判据对上：正斜杠 / 反斜杠 / 相对入口三种命令行形状都认得出，'
Write-Host '判据认不出时也如实说"没找到主进程"，不拿端口就绪冒充成功。'
exit 0
