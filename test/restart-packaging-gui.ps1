# ════════════════════════════════════════════════════════════════════════════
# `packaging\restart.ps1`（随包那份）界面支的两处补丁 —— 隔离验收（**一个真窗口都不弹**）
#
# 2026-10-10，上级裁定改的两处（只动这两处 + 注释）：
#   (a) 界面支补 `-WorkingDirectory <exe 所在目录>`：过去没有 ⇒ 界面继承外层 cmd 的 cwd（安装根），
#       而 Flutter 的 Windows 产物要**就地**找 `flutter_windows.dll` 与 `data\`（工作目录给错 =
#       起来就自己退，而"拉起"那一层照样报成功）。
#   (b) 拉起后读**窗口/存活**：过去只有 `$proc.Id` 一句 ⇒ "起来就退"和"起来了"在留痕里是同一句话。
#       现在落地与 `tools\restart-agent.ps1` **逐字同口径**的四态判据
#       （not-appeared / appeared-then-exited / alive-no-window / alive），
#       判据落在 `-PassThru` 给的 pid 上——**不用**"同路径新进程"那种采样（那个会认错人）。
#
# 本脚本**钉住**的四件事（每一条都有正面读数）：
#   ① `-WorkingDirectory` 真的是 exe 所在目录 —— 判据不是"留痕里写着"，而是**替身自己写下的 cwd**
#      （替身把 `cwd=` 写进 `<exe>.cwd.txt`）；
#   ② 四态**各自可分辨**，且 `StateNote` 的措辞与开发机那份同口径（与 `test\restart-gui-predicate.ps1`
#      对 `tools\restart-agent.ps1` 做的事一样）；
#   ③ **不用采样判据**：函数体内不许出现同路径进程的"拉起前后采样"那套（那正是"认错人"的来源）；
#   ④ 端到端（`-GuiOnly` 走真脚本、真替身）：留痕里那行 `[结束]` 得带上
#      `界面拉起=<态>（<一句话>）`，与开发机那份的结尾行同形。
#
# 两条**安全纪律**（这份脚本面向装机版，绝不许拿用户的东西做实验）：
#   · 替身一律在 `%TEMP%` 的沙盒里现场编译，收尾只杀"exe 全路径在沙盒里"的进程，**绝不按名字杀**；
#   · `-Repo` 指向沙盒 ⇒ 真 `data\`、真 `config.json`、真界面、真后端一个都不碰（沙盒里没有 node，
#     所以"停旧后端"那一段找不到任何目标；端到端走的是 `-GuiOnly`，它本来就一个后端都不动）。
#
# 跑法：pwsh -NoProfile -File test\restart-packaging-gui.ps1
#       pwsh -NoProfile -File test\restart-packaging-gui.ps1 -Keep   # 留沙盒
# ════════════════════════════════════════════════════════════════════════════
param(
  [string]$Work = '',
  [switch]$Keep
)

$ErrorActionPreference = 'Continue'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Script = Join-Path $RepoRoot 'packaging\restart.ps1'
if ($Work -eq '') { $Work = Join-Path $env:TEMP 'irmia-packaging-restart-check' }

$Box = $Work                       # 沙盒 = 传给脚本的 -Repo
$Logs = Join-Path $Box 'logs'
$passed = 0
$failed = 0

function Say([string]$T) { Write-Host $T }
function Check([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { $script:passed++; Write-Host ('  OK   ' + $Name + '  ' + $Detail) }
  else { $script:failed++; Write-Host ('  FAIL ' + $Name + '  ' + $Detail) }
}
function Kill-Box {
  # 收尾判据：**exe 全路径在沙盒里**（与脚本自己的 `Get-GuiProcesses` 同形），绝不按名字杀
  foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if (-not $p.ExecutablePath) { continue }
    $path = ''
    try { $path = [System.IO.Path]::GetFullPath($p.ExecutablePath) } catch { continue }
    if ($path.ToLowerInvariant().StartsWith($Box.ToLowerInvariant())) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 400
}
function Remove-Box {
  # 不用 `Get-ChildItem -Recurse`：本机实测**路径不存在时它会卡住**（这一条是踩过的），
  # 清沙盒交给 cmd 的 `rd /s /q`（快、且不存在时静默）。
  if (Test-Path -LiteralPath $Box) { & cmd.exe /c ('rd /s /q "' + $Box + '"') 2>&1 | Out-Null }
}
function Build-Cs([string]$SrcName, [string]$OutPath, [string]$Target) {
  $src = Join-Path $PSScriptRoot ('stand-in\' + $SrcName)
  $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { $csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  # 替身必须**真的是 exe**（`.cmd` 垫片由 cmd.exe 代跑，全路径永远匹配不到——那种替身会把四态全假装成"没出现"）
  & $csc /nologo ('/target:' + $Target) ('/out:' + $OutPath) $src /r:System.Windows.Forms.dll /r:System.Drawing.dll 2>&1 | Out-Null
  return (Test-Path $OutPath)
}
function Get-CwdOf([string]$ExePath) {
  $f = $ExePath + '.cwd.txt'
  if (-not (Test-Path -LiteralPath $f)) { return '' }
  $cwd = ''
  foreach ($line in @(Get-Content -LiteralPath $f -Encoding UTF8)) {
    if ($line -like 'cwd=*') { $cwd = $line.Substring(4) }
  }
  return $cwd
}
function Run-ScriptGuiOnly([string]$Tag, [string]$GuiExe) {
  $trace = Join-Path $Logs ($Tag + '-trace.log')
  $scriptLog = Join-Path $Logs ($Tag + '-script.log')
  Remove-Item $trace, $scriptLog -Force -ErrorAction SilentlyContinue
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script,
    '-Repo', $Box, '-GuiExe', $GuiExe, '-GuiOnly', '-DelaySeconds', '0',
    '-Port', '7811', '-ProbeHost', '127.0.0.1', '-PortWaitSeconds', '1', '-WaitSeconds', '1',
    '-TraceLog', $trace, '-ScriptLog', $scriptLog)
  $out = & pwsh @argv 2>&1 | Out-String
  $code = $LASTEXITCODE
  $text = ''
  if (Test-Path -LiteralPath $trace) { $text = (Get-Content -LiteralPath $trace -Encoding UTF8 | Out-String) }
  return [pscustomobject]@{ Out = $out; Code = $code; Trace = $text; TracePath = $trace }
}

# ── 沙盒（**先杀干净再建**：上一次跑剩的替身不许混进这一次的读数） ───────────────
Kill-Box
Remove-Box
$GuiDir = Join-Path $Box 'gui'          # 界面所在目录（工作目录应当是**它**）
$NowinDir = Join-Path $Box 'gui-nowin'  # 第二个目录：验"无窗口"那一态 + 由外向内比 cwd
New-Item -ItemType Directory -Force -Path $GuiDir, $NowinDir, $Logs | Out-Null

$GuiAlive = Join-Path $GuiDir 'gui_alive.exe'      # 有窗口（屏幕外），活到收尾
$GuiDie = Join-Path $GuiDir 'gui_die.exe'          # 无窗口，活 2 秒：出现即退
$GuiNowin = Join-Path $NowinDir 'gui_nowin.exe'    # 无窗口，活 60 秒：出现但无窗口
$GuiMissing = Join-Path $GuiDir 'gui_missing.exe'  # 盘上不存在 ⇒ Start-Process 抛异常

$okAlive = Build-Cs 'windowed.cs' $GuiAlive 'winexe'
$okDie = Build-Cs 'cwd-nowin.cs' $GuiDie 'winexe'
$okNowin = Build-Cs 'cwd-nowin.cs' $GuiNowin 'winexe'

Say ('仓库：' + $RepoRoot)
Say ('脚本：' + $Script)
Say ('沙盒（= -Repo，真 data\ 与 config.json 都不碰）：' + $Box)
Say ('替身：有窗口=' + $GuiAlive + '（编译=' + $okAlive + '）')
Say ('      无窗口·2 秒=' + $GuiDie + '（编译=' + $okDie + '）')
Say ('      无窗口·60 秒=' + $GuiNowin + '（编译=' + $okNowin + '）')
Say ('      不存在=' + $GuiMissing)
Say ('用户那边的界面（本脚本一个都不碰，只数一下）：' + (@(Get-Process -Name 'irmia_gui','irmia_gui.exe' -ErrorAction SilentlyContinue).Count) + ' 个')
Say ''
if (-not ($okAlive -and $okDie -and $okNowin)) { Say '替身编译失败，后面不用跑了'; exit 2 }

# 把两个值带进子进程：`$GuiPath` 是"当前这一格要拉的那个 exe"，`$Win32Ready` 是窗口读数探针装好了没
$env:IRMIA_GUI_PATH = $GuiAlive
$env:IRMIA_SCRIPT = $Script
$env:IRMIA_TRACE = (Join-Path $Logs 'fn-trace.log')
$env:IRMIA_NOWIN = $GuiNowin
$env:IRMIA_MISSING = $GuiMissing
$env:IRMIA_DIE = $GuiDie
$fnFile = Join-Path $Logs 'fn-probe.ps1'

# ── 函数的四态：在子进程里**从脚本正文里取出**那三个定义（AST），一个一个调 ────────
#
# 为什么用 AST 取出而不是 dot-source 整个正文：正文一跑就会去停进程/拉进程，还有 `exit`；
# 而我们要的是"**这一份文件的这个函数**"在四态下的读数。取出来的是**盘上那份的原文**，
# 不是我另抄的一份 —— 所以这里量到的措辞就是随包脚本里的措辞。
$fnScript = @'
$ErrorActionPreference = 'Continue'
$Script = $env:IRMIA_SCRIPT
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$parseErrors)
"PARSE_ERRORS=" + @($parseErrors).Count
# 探针自带一个 `Write-Trace`：脚本正文里那个会写 `data\restart-trace.log`（**不许**碰），
# 而函数体每一态都要调它。这里换成"写进沙盒 + 打屏"，于是四态的**原始留痕**也一并拿到。
$script:TraceOk = $true
function Write-Trace([string]$Line) {
  try { Add-Content -LiteralPath $env:IRMIA_TRACE -Value $Line -Encoding UTF8 } catch { }
  Write-Host ('TRACE| ' + $Line)
}
foreach ($name in @('Resolve-Abs', 'Get-WindowNote', 'Invoke-DetachedStartProcess')) {
  $def = $ast.FindAll({ param($n) ($n -is [System.Management.Automation.Language.FunctionDefinitionAst]) -and ($n.Name -eq $name) }, $true) | Select-Object -First 1
  if ($null -eq $def) { "MISSING_FUNCTION=$name"; exit 3 }
  Invoke-Expression $def.Extent.Text
}
# 窗口读数探针：脚本里那段 `Add-Type` 是**正文**（不在任何函数里），而且它传的是**字符串**，
# 不是 TypeDefinitionAst ⇒ 取"包含 Add-Type 与 Win32 的那个 if 语句"整段来执行（就是盘上那段原文）。
$probe = $ast.FindAll({ param($n) ($n -is [System.Management.Automation.Language.IfStatementAst]) -and ($n.Extent.Text -match 'Win32') -and ($n.Extent.Text -match 'Add-Type') }, $true) | Select-Object -First 1
if ($null -eq $probe) { 'MISSING_TYPE=Win32'; exit 4 }
Invoke-Expression $probe.Extent.Text
"WIN32_READY=" + [bool]('Win32' -as [type])

function Show([string]$tag, $info) {
  "STATE[$tag]=" + $info.State
  "NOTE[$tag]=" + $info.StateNote
  "OK[$tag]=" + $info.Ok
  "EXPID[$tag]=" + $info.ExePid
  "WIN[$tag]=top=" + $info.WindowTop + " visible=" + $info.WindowVisible
  "EXIT[$tag]=" + $info.ExitCode
  "CMD[$tag]=" + $info.Cmd
  "REDIR[$tag]=" + $info.Redirect
}

$dir1 = Split-Path -Parent $env:IRMIA_GUI_PATH
$dir2 = Split-Path -Parent $env:IRMIA_NOWIN
$dir3 = Split-Path -Parent $env:IRMIA_DIE

# ① 没出现：盘上没有这个 exe（Start-Process 抛异常，异常原文进 StateNote）
Show 'notappeared' (Invoke-DetachedStartProcess $env:IRMIA_MISSING '' $dir1 '')
# ② 出现即退：无窗口替身，活 2 秒
Show 'died' (Invoke-DetachedStartProcess $env:IRMIA_DIE '2000' $dir3 '')
# ③ 出现但无窗口：无窗口替身，活 60 秒
Show 'nowin' (Invoke-DetachedStartProcess $env:IRMIA_NOWIN '60000' $dir2 '')
# ④ 出现且有窗口：有窗口替身（屏幕外）
Show 'alive' (Invoke-DetachedStartProcess $env:IRMIA_GUI_PATH '0' $dir1 '')
# 附带：正文里不许有"同路径进程采样"那套判据（那正是"认错人"的来源）
$body = (Get-Content -LiteralPath $Script -Raw -Encoding UTF8)
"SAMPLING_PRESENT=" + [bool]($body -match '拉起前同路径进程')
"PASTHRU_MENTIONED=" + [bool]($body -match '-PassThru')
exit 0
'@
[System.IO.File]::WriteAllText($fnFile, $fnScript, (New-Object System.Text.UTF8Encoding($true)))
Remove-Item $env:IRMIA_TRACE -Force -ErrorAction SilentlyContinue
$fnOut = & pwsh -NoProfile -ExecutionPolicy Bypass -File $fnFile 2>&1 | Out-String
$fnCode = $LASTEXITCODE
Say '════ ① 函数的四态读数（从随包脚本正文里取出来的那个函数） ════'
Say ('（子进程退出码=' + $fnCode + '）')
Say $fnOut.TrimEnd()
Say ''

function FnVal([string]$key) {
  # 取**最后一个**读数：同一格里万一打了两次，后一次才是那一格的结论
  $all = [regex]::Matches($fnOut, [regex]::Escape($key) + '=(.*)')
  if ($all.Count -gt 0) { return $all[$all.Count - 1].Groups[1].Value.Trim() }
  return ''
}
$stNot = FnVal 'STATE[notappeared]'
$stDie = FnVal 'STATE[died]'
$stNow = FnVal 'STATE[nowin]'
$stAli = FnVal 'STATE[alive]'
$noteNot = FnVal 'NOTE[notappeared]'
$noteDie = FnVal 'NOTE[died]'
$noteNow = FnVal 'NOTE[nowin]'
$noteAli = FnVal 'NOTE[alive]'
$exitDie = FnVal 'EXIT[died]'
$winAli = FnVal 'WIN[alive]'
$cmdAli = FnVal 'CMD[alive]'

Check '① 没出现 ⇒ not-appeared（措辞：没出现：…）' (($stNot -eq 'not-appeared') -and ($noteNot -like '没出现：*')) ('State=' + $stNot + ' · Note=' + $noteNot)
Check '② 出现即退 ⇒ appeared-then-exited（措辞：出现即退：…；带退出码）' (($stDie -eq 'appeared-then-exited') -and ($noteDie -like '出现即退：*') -and ($exitDie -ne '')) ('State=' + $stDie + ' · ExitCode=' + $exitDie)
Check '③ 出现但无窗口 ⇒ alive-no-window（措辞：出现但无窗口：pid N 活着，窗口 top-level=0 visible=0）' (($stNow -eq 'alive-no-window') -and ($noteNow -like '出现但无窗口：pid * 活着，窗口 top-level=0 visible=0')) ('State=' + $stNow + ' · Note=' + $noteNow)
Check '④ 出现且有窗口 ⇒ alive（措辞：出现且有窗口：pid N 活着，窗口 top-level=N visible=N）' (($stAli -eq 'alive') -and ($noteAli -like '出现且有窗口：pid * 活着，窗口 top-level=* visible=*')) ('State=' + $stAli + ' · Note=' + $noteAli)
Check '④ 窗口读数是真的（visible≥1，不是空读数被当成有窗口）' ($winAli -match 'visible=[1-9]') ('WIN=' + $winAli)
Check '④ 复现命令行里带着 -WorkingDirectory（人与留痕都能照抄）' ($cmdAli -match '-WorkingDirectory "') ('CMD=' + $cmdAli)
Check '判据落在 -PassThru 的 pid 上（函数体里没有"同路径进程采样"那套）' ((FnVal 'SAMPLING_PRESENT') -eq 'False') ('SAMPLING_PRESENT=' + (FnVal 'SAMPLING_PRESENT'))
Check '窗口读数探针装得上（Add-Type 那段正文）' ((FnVal 'WIN32_READY') -eq 'True') ('WIN32_READY=' + (FnVal 'WIN32_READY'))

# ── ② 端到端：`-GuiOnly` 走**真脚本**（-Repo=沙盒），留痕里那行 `[结束]` 得带界面读数 ──
Say ''
Say '════ ② 端到端：-GuiOnly 走真脚本（留痕里的 [结束] 行） ════'
Kill-Box
$r1 = Run-ScriptGuiOnly 'gui-alive' $GuiAlive
$end1 = @($r1.Trace -split "`n" | Where-Object { $_ -match '\[结束\]' } | Select-Object -First 1)
if ($end1.Count -gt 0) { Say ('  [有窗口] ' + $end1[0].Trim()) }
$cwd1 = Get-CwdOf $GuiAlive
Check '②(a) 端到端：界面起来了 ⇒ 结尾行带 界面拉起=alive（+ 窗口读数，且**只出现一次**）' (($r1.Trace -match '界面拉起=alive（出现且有窗口：pid \d+ 活着，窗口 top-level=\d+ visible=[1-9]\d*）') -and (@([regex]::Matches($r1.Trace, '界面拉起=')).Count -eq 1)) ('退出码=' + $r1.Code)
Check '②(b) 被拉起的那个进程**自己的 cwd** = exe 所在目录（判据来自替身写的 .cwd.txt）' ($cwd1 -ieq $GuiDir) ('替身写的 cwd=' + $cwd1 + ' · 期望=' + $GuiDir)
Check '②(c) 退出码 0（拉起成功）' ($r1.Code -eq 0) ('退出码=' + $r1.Code)
Check '②(d) 留痕里写着形状与工作目录（下次出问题第一句能回答"用的哪条形状"）' (($r1.Trace -match '形状=Start-Process') -and ($r1.Trace -match [regex]::Escape($GuiDir))) '留痕含形状与工作目录'

Kill-Box
$r2 = Run-ScriptGuiOnly 'gui-nowin' $GuiNowin
$end2 = @($r2.Trace -split "`n" | Where-Object { $_ -match '\[结束\]' } | Select-Object -First 1)
if ($end2.Count -gt 0) { Say ('  [无窗口] ' + $end2[0].Trim()) }
$cwd2 = Get-CwdOf $GuiNowin
Check '②(e) 端到端：活着但没有可见窗口 ⇒ 结尾行带 界面拉起=alive-no-window，且**照旧算拉起成功**（ok=True/退出码 0，与开发机那份同一分寸）' `
  (($r2.Trace -match '界面拉起=alive-no-window（出现但无窗口：pid \d+ 活着，窗口 top-level=0 visible=0）') -and ($r2.Code -eq 0) -and ($r2.Trace -match '\[结束\] ok=True')) ('退出码=' + $r2.Code)
Check '②(f) 无窗口那一支照样写着 界面读数（alive-no-window）（人是看不见的，必须说出来）' ($r2.Trace -match '界面读数（alive-no-window）：出现但无窗口') '留痕含 界面读数'
Check '②(g) 第二个目录的替身：cwd = **它自己**的目录（不是第一个替身的，也不是安装根）' ($cwd2 -ieq $NowinDir) ('替身写的 cwd=' + $cwd2 + ' · 期望=' + $NowinDir)

# ── ③ 第二条调用点：走**普通支**（真后端 + 真界面，都在沙盒里） ────────────────
#
# 界面在脚本里有**两个**调用点（`-GuiOnly` 支 + 第 ⑤ 步）。② 只盖住了第一个；这里走完整那条：
# 脚本会 ① 停旧后端（沙盒里没有，0 个）② 用真 `node.exe` 拉起一个**假后端**（写 lock.json + 监听端口）
# ③ 等"新 pid + 端口就绪" ④ 再按**同一个函数**拉界面。假后端是**沙盒里的一行 node 脚本**，
# 它只写 `$Box\data\lock.json`、只监听 7811；真 data\、真 7788、真实例一概不碰。
Say ''
Say '════ ③ 第二条调用点：普通支（假后端 + 替身界面，全在沙盒里） ════'
$FakeNode = Join-Path $Box 'fake-backend.js'
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
$FakeEntry = Join-Path $Box 'dist\main.js'
New-Item -ItemType Directory -Force -Path (Join-Path $Box 'dist'), (Join-Path $Box 'data') | Out-Null
if ($null -eq $NodeExe) { $NodeExe = 'node.exe' }
# 假后端：**在沙盒的 cwd 里**写 lock.json（自己那个 pid）+ 监听 7811，然后把 cwd 也写进去，
# 于是"后端被拉起的那个进程站在哪儿"这一条也有正面读数（与界面替身的 `.cwd.txt` 同一路证据）。
$js = 'const fs=require("fs"),path=require("path"),net=require("net");' +
      'const out=path.join(process.cwd(),"data");' +
      'try{fs.mkdirSync(out,{recursive:true});}catch(e){}' +
      'fs.writeFileSync(path.join(out,"lock.json"),JSON.stringify({pid:process.pid,cwd:process.cwd(),startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString(),fake:true}));' +
      'net.createServer(()=>{}).listen(7811,"127.0.0.1");' +
      'setInterval(()=>{},1000);'
[System.IO.File]::WriteAllText($FakeNode, $js, (New-Object System.Text.UTF8Encoding($false)))

if (-not (Test-Path -LiteralPath $FakeEntry)) {
  # 这个文件**就是**假后端：它是 `-NodeEntry` 指的那条干净入口（`Resolve-Abs` 只吃"一条路径"）。
  # 为什么不把代码塞进 `-NodeEntry`：那一栏先过脚本的 `Resolve-Abs`（相对路径按 -Repo 解析），
  # 塞进去会被解析成 `<沙盒>\<引号开头的那一整串>`——本机实测脚本如实报
  # `spawn-failed · 没有这个入口：…\"C:\…\main.js" -e …`。所以替身老老实实落成一个文件。
  [System.IO.File]::WriteAllText($FakeEntry, $js, (New-Object System.Text.UTF8Encoding($false)))
}
# 入口只给一条干净路径；`-e` 那一套不用了（上面那条注释记着为什么）
$NodeEntryArg = $FakeEntry
$trace3 = Join-Path $Logs 'full-trace.log'
$scriptLog3 = Join-Path $Logs 'full-script.log'
Remove-Item $trace3, $scriptLog3 -Force -ErrorAction SilentlyContinue
# 界面替身的 cwd 读数**先删掉**：不删的话读到的是上一次 ② 留下的旧文件（本机实测踩过：
# ③ 明明没拉起界面，那条断言却因为旧 .cwd.txt 而"通过"）。
Remove-Item -LiteralPath ($GuiAlive + '.cwd.txt') -Force -ErrorAction SilentlyContinue
$argv3 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script,
  '-Repo', $Box, '-NodeEntry', $NodeEntryArg, '-NodeExe', $NodeExe,
  '-GuiExe', $GuiAlive, '-DelaySeconds', '0',
  '-Port', '7811', '-ProbeHost', '127.0.0.1',
  '-PortWaitSeconds', '20', '-WaitSeconds', '5',
  '-TraceLog', $trace3, '-ScriptLog', $scriptLog3,
  '-OutLog', (Join-Path $Logs 'fake-backend.out.log'))
$out3 = & pwsh @argv3 2>&1 | Out-String
$code3 = $LASTEXITCODE
$trace3Text = ''
if (Test-Path -LiteralPath $trace3) { $trace3Text = (Get-Content -LiteralPath $trace3 -Encoding UTF8 | Out-String) }
$end3 = @($trace3Text -split "`n" | Where-Object { $_ -match '\[结束\]' } | Select-Object -First 1)
if ($end3.Count -gt 0) { Say ('  [普通支] ' + $end3[0].Trim()) }
$cwd3 = Get-CwdOf $GuiAlive
$lock3 = Join-Path $Box 'data\lock.json'
$lock3Text = ''
if (Test-Path -LiteralPath $lock3) { $lock3Text = (Get-Content -LiteralPath $lock3 -Raw -Encoding UTF8) }
Check '③(a) 第二条调用点：普通支也落到**同一个函数**（留痕带 -WorkingDirectory 与四态读数）' (($trace3Text -match '拉起界面：形状=Start-Process') -and ($trace3Text -match '-WorkingDirectory "') -and ($trace3Text -match '界面拉起=alive（出现且有窗口：pid \d+ 活着，窗口 top-level=\d+ visible=[1-9]\d*）')) '留痕含形状/工作目录/四态'
Check '③(b) 后端那一支**一字未动**（仍是 cmd /s /c + WMI 那条形状，判据与凭据照旧）' (($trace3Text -match 'cmd\.exe /s /c') -and ($trace3Text -match '\[实例\] 后端已接管 pid=')) '留痕含 WMI 形状与 [实例]'
Check '③(c) 新 pid 来自 lock.json（假后端自己写的那个），端口 127.0.0.1:7811 就绪' (($end3.Count -gt 0) -and ($end3[0] -match 'port=ready') -and ($lock3Text -match '"pid"')) ('lock.json=' + $lock3Text.Trim())
# 大小写不敏感 + 走 JSON 解析再比：node 看到的 cwd 与 `$env:TEMP` 那串大小写不一致
# （`C:\Windows\Temp` vs `C:\WINDOWS\TEMP`），而 JSON 里反斜杠是转义的（拿原文比会假失败）
$lock3Cwd = ''
try { $lock3Cwd = [string](ConvertFrom-Json $lock3Text).cwd } catch { }
Check '③(c2) 假后端（真 node.exe、WMI 拉起）的 cwd = 沙盒根（后端的 cwd 纪律一字未动）' ($lock3Cwd -ieq $Box) ('lock.json.cwd=' + $lock3Cwd + ' · 期望=' + $Box)
Check '③(d) 第二条调用点拉起的替身：cwd = exe 所在目录（与 ② 同一读数，另一条路）' ($cwd3 -ieq $GuiDir) ('替身写的 cwd=' + $cwd3 + ' · 期望=' + $GuiDir)
Check '③(e) 普通支成功 ⇒ 退出码 0、结尾行 ok=True' (($code3 -eq 0) -and ($end3[0] -match '\[结束\] ok=True')) ('退出码=' + $code3)
Kill-Box

Say ''
Say '──────── 沙盒留痕原文（证据，最后 6 行） ────────'
foreach ($t in @(@('有窗口', $r1), @('无窗口', $r2))) {
  Say ('  [' + $t[0] + '] ' + $t[1].TracePath)
  $lines = @($t[1].Trace -split "`n" | Where-Object { $_.Trim() -ne '' })
  $tail = @($lines | Select-Object -Last 6)
  foreach ($l in $tail) { Say ('    ' + $l.Trim()) }
}
Say ('  [普通支] ' + $trace3)
$lines3 = @($trace3Text -split "`n" | Where-Object { $_.Trim() -ne '' })
foreach ($l in @($lines3 | Select-Object -Last 7)) { Say ('    ' + $l.Trim()) }
Say ''
Say '──────── 函数那一支的原始留痕（证据，含窗口读数行） ────────'
$fnLines = @($fnOut -split "`n" | Where-Object { $_ -match '^TRACE\| ' })
if ($fnLines.Count -eq 0 -and (Test-Path -LiteralPath $env:IRMIA_TRACE)) {
  $fnLines = @(Get-Content -LiteralPath $env:IRMIA_TRACE -Encoding UTF8)
}
foreach ($l in @($fnLines | Select-Object -Last 10)) { Say ('    ' + $l.Trim()) }

Kill-Box
Remove-Box
Say ''
Say ('════ 结果：通过 ' + $passed + ' · 失败 ' + $failed + ' ════')
if ($failed -eq 0) { exit 0 } else { exit 1 }
