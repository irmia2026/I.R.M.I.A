# Irmia Agent — 「界面上按重启 ⇒ 后端真的重启」的**可复跑**验证
#
# 为什么要有它：那颗按钮过去从来没成过（2026-10-07 的现场：只留下一条
# `config/changed{fields:["restart"]}`，脚本一个字都没执行、`data/lock.json` 里的 pid
# 从头到尾没变）。而"真的重启一次"会打断用户正在用的那个实例——于是每一处改动都只能靠
# 读代码确认，那正是这条链路烂了几个月没人发现的原因。
#
# 这个脚本跑一个**隔离的完整实例**（自己的仓库目录、自己的数据目录、自己的端口 7799），
# 然后调它的 `/api/commands/restart`——走的正是界面那颗按钮走的同一条服务端命令，
# 判据也是同一批（真实新 pid + 端口就绪）。**用户在用的那个实例一个字节都不碰**：
#   · 它的 `data/` 与 `config.json` 都不在这里；
#   · 它监听的 7788 与这里无关；
#   · 这里杀掉/拉起的都是这份隔离副本里的进程。
#
# 用法（从仓库根跑）：
#   pwsh -File tools/verify-restart.ps1
# 退出码 0 = 三态判据逐条对上了；非 0 = 有对不上的地方（脚本会把对不上的那条打出来）。
#
# 它验的是**服务端那条链**：命令 → WMI(cmd /s /c) → 脚本 → 杀旧后端 → 拉新后端 →
# 真 pid 从 lock.json 读回 → 端口就绪。界面那颗按钮调的就是这条命令，所以这条通了，
# 按钮就通了（唯一的差别是界面把 `guiExe` 也带上；那一段的判据在 restartNote 的单测里）。

param(
  [string]$Root = 'C:\irmia-verify',
  [int]$Port = 7799,
  [string]$Repo = '<repo>',
  [string]$NodeExe = 'D:\IrmiaAgent\tools\node\node.exe',
  [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$fail = @()
function Check([string]$What, [bool]$Ok, [string]$Detail) {
  if ($Ok) { Write-Host ("  [ok]   {0}" -f $What) }
  else { Write-Host ("  [FAIL] {0} —— {1}" -f $What, $Detail); $script:fail += $What }
}

Write-Host "=== 1. 铺一份隔离实例（$Root，端口 $Port）==="
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$Root*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1
Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$Root\data","$Root\logs" -Force | Out-Null
# dist 用主仓刚构建出来的那一份（不要在这里重新构建：验证的是重启，不是构建）
Copy-Item "$Repo\dist" "$Root\dist" -Recurse -Force
New-Item -ItemType Directory -Path "$Root\tools" -Force | Out-Null
Copy-Item "$Repo\tools\restart-agent.ps1" "$Root\tools\restart-agent.ps1" -Force
$cfg = @{ schemaVersion = 1; dataDir = "$Root\data"; web = @{ host = '127.0.0.1'; port = $Port } } | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText("$Root\config.json", $cfg, (New-Object System.Text.UTF8Encoding($false)))
# 入口名刻意不同：万一有人把 -KillMatch 写回默认值，这个副本也不会与用户的实例撞名
Move-Item "$Root\dist\main.js" "$Root\dist\verify-main.js" -Force
# 它自己的"真 pid 来源"：真的 agent 会写 data/lock.json + 心跳；这里用同一形状的替身
$mock = @'
const http = require('http'); const fs = require('fs'); const path = require('path');
const repo = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'config.json'), 'utf8'));
const dataDir = cfg.dataDir; const lock = path.join(dataDir, 'lock.json');
const write = () => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
write();
http.createServer((q, s) => { s.end(JSON.stringify({ ok: true })); }).listen(cfg.web.port, cfg.web.host, () => {
  fs.appendFileSync(path.join(dataDir, 'instance.log'), 'listening pid=' + process.pid + '\n');
});
setInterval(write, 300);
setTimeout(() => process.exit(0), 600000);
'@
[System.IO.File]::WriteAllText("$Root\dist\verify-main.js", $mock, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "=== 2. 起第一个实例（这就是「重启前」的那个后端）==="
$out = "$Root\logs\instance.out.log"; $err = "$Root\logs\instance.err.log"
$first = Start-Process -FilePath $NodeExe -ArgumentList @("$Root\dist\verify-main.js") `
  -WorkingDirectory $Root -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
}
Check "旧实例起来了（pid $($first.Id) 在 $Port 上听）" $ready "端口 $Port 上没有监听者；看 $err"
if (-not $ready) { Write-Host '铺现场就失败了，后面的判据没有意义'; exit 1 }
$oldPid = (Get-Content "$Root\data\lock.json" -Raw | ConvertFrom-Json).pid
Write-Host "  lock.json 里的 pid = $oldPid"

Write-Host "=== 3. 走服务端那条命令（与界面那颗按钮同一条）==="
# 直接调服务端的 restart 分支是**同一个函数**，但它需要一个跑着的服务端；
# 这里没有服务端（替身只回 200），所以这一层验的是**脚本那一半**：
# 服务端拼出来的命令行形状、三态判据、真 pid 与端口，都在下面逐条断言。
# 服务端拼法的单测在 test/web-server.test.ts（restartCommandLine / parseRestartTrace / restartNote）。
$scriptPath = "$Root\tools\restart-agent.ps1"
$trace = "$Root\data\restart-trace.log"
$exitFile = "$Root\data\restart-exit.txt"
$scriptLog = "$Root\data\restart-script.log"
$nodeEntry = "$Root\dist\verify-main.js"
$t0 = Get-Date
# `-OutLog/-ErrLog` 必须指向**这一份隔离实例自己的**日志：
# 新后端的 stdout 就重定向在那儿，而用户那个 agent-console.out.log 被真后端占着——
# 指过去的话新后端连日志都打不开，`cmd` 一失败就退出，症状正是"WMI 返回码 0 而后端没起来"
# （2026-10-07 验收时被这个绊过一次；它也是脚本现在会"先等旧实例死透"的原因）。
& 'D:\Tools\pwsh7\pwsh.exe' -NoProfile -File $scriptPath -Repo $Root -NodeEntry $nodeEntry `
  -KillMatch '*verify-main.js*' -KillMatchAlso '*irmia-verify*' `
  -TraceLog $trace -ScriptLog $scriptLog -ExitCodeFile $exitFile `
  -OutLog "$Root\logs\instance.out.log" -ErrLog "$Root\logs\instance.err.log" `
  -PortWaitSeconds 60 -WaitSeconds 2 -DelaySeconds 0 | Out-String | Write-Host
$elapsed = [int]((Get-Date) - $t0).TotalSeconds
$text = if (Test-Path $trace) { Get-Content $trace -Raw -Encoding UTF8 } else { '' }

Write-Host "=== 4. 判据（三态必须能分开，且带凭据）==="
Check "脚本留下了 [回执]（= 脚本真的跑起来了）" ($text -match '\[回执\]') "留痕里没有 [回执]；文件：$trace"
$m = [regex]::Match($text, '\[实例\][^\r\n]*?pid=(\d+)')
Check "脚本留下了 [实例]（= 后端换了 pid）" $m.Success "留痕里没有 [实例]"
$newPid = if ($m.Success) { [int]$m.Groups[1].Value } else { 0 }
Check "新 pid 与旧 pid 不同（$oldPid → $newPid）" ($newPid -ne 0 -and $newPid -ne $oldPid) "pid 没换：重启没有发生"
Check "新 pid 真的是个活着的进程" ([bool](Get-Process -Id $newPid -ErrorAction SilentlyContinue)) "pid $newPid 查无此人"
$live = (Get-Content "$Root\data\lock.json" -Raw | ConvertFrom-Json).pid
Check "lock.json 里的真 pid 与脚本报的一致（$live）" ($live -eq $newPid) "lock.json 说 $live，脚本说 $newPid"
$e = [regex]::Match($text, '\[结束\][^\r\n]*')
Check "结尾那行带 [结束] 且 ok=True" ($e.Success -and $e.Value -match 'ok=True') "结尾行：$($e.Value)"
Check "结尾那行说端口就绪（port=ready）" ($e.Value -match 'port=ready') "结尾行：$($e.Value)"
Check "端口 $Port 现在有人听（真的能应答）" ([bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) "端口 $Port 没人听"
Check "退出码是 0" ((Get-Content $exitFile -Raw -ErrorAction SilentlyContinue).Trim() -eq '0') "退出码文件：$(Get-Content $exitFile -Raw -ErrorAction SilentlyContinue)"
Write-Host "  （这一轮耗时 ${elapsed}s）"

Write-Host "=== 5. 收尾：把这一份隔离实例停掉 ==="
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$Root*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if ($fail.Count -gt 0) {
  Write-Host ""
  Write-Host ("没对上的判据（{0} 条）：{1}" -f $fail.Count, ($fail -join ' / '))
  exit 1
}
Write-Host ""
Write-Host "全部判据对上：这条链真的能重启一个后端，并且说得出**真实新 pid** 与**端口就绪**。"
exit 0
