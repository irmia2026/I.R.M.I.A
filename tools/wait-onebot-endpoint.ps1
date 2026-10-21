# 等 OneBot 端点出现（第 4 步的可复跑检测）
#
# **它回答的问题**：用户登录 QQ 之后，`config/onebot.json`（或 `config/onebot_<uin>.json`）
# 才会被 SnowLuma 物化、3001 才会开始监听——在那之前，适配器**没有端点可连**，
# 而"没有端点可连"与"连不上"是两句不同的话（前者的下一步是去登录，后者才是排障）。
#
# **它不做什么**：不改任何文件、不启停任何进程、不写事件日志。只读盘 + 一次 TCP 探活，
# 外加把 `/api/protocol-side` 的三档原文打出来（那才是界面看到的同一份口径）。
#
# 用法：
#   pwsh -NoProfile -File tools\wait-onebot-endpoint.ps1                 # 探一次就退出
#   pwsh -NoProfile -File tools\wait-onebot-endpoint.ps1 -Wait -TimeoutSeconds 1800
#
# 端点出现之后，端到端那一条（真实消息进站 → 唤醒 → 她回 → 出站）要**用户先从 QQ 那边
# 发一条给她**：适配器的入站事件只由协议端推送，我们这边造不出来（造出来的就不是实测）。

[CmdletBinding()]
param(
  [string]$Repo = '<repo>',
  [string]$DataDir = '',
  [string]$ApiBase = 'http://127.0.0.1:7788',
  [string]$Token = '',
  [switch]$Wait,
  [int]$TimeoutSeconds = 900,
  [int]$PollSeconds = 5
)

$ErrorActionPreference = 'Stop'

if ($DataDir -eq '') { $DataDir = Join-Path $Repo 'data' }
$serviceDir = Join-Path $DataDir 'services\snowluma'

function Write-Section([string]$title) {
  Write-Host ''
  Write-Host "── $title " -NoNewline
  Write-Host ('─' * [Math]::Max(0, 60 - $title.Length))
}

# ── ① 三档里的第二档：配置在不在、读出的端点是什么（口径与 src/services/snowluma.ts 同一份） ──
function Get-OneBotConfigFacts {
  $configDir = Join-Path $serviceDir 'config'
  $candidates = @()
  if (Test-Path $configDir) {
    $candidates = Get-ChildItem $configDir -File -Filter 'onebot*.json' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
  }
  $endpoint = $null
  $from = $null
  foreach ($file in $candidates) {
    try { $parsed = Get-Content $file.FullName -Raw -Encoding utf8 | ConvertFrom-Json } catch { continue }
    $server = $null
    if ($parsed.networks -and $parsed.networks.wsServers -and $parsed.networks.wsServers.Count -gt 0) {
      $server = $parsed.networks.wsServers[0]
    }
    if ($null -eq $server) { continue }
    $port = 0
    if (-not [int]::TryParse([string]$server.port, [ref]$port)) { continue }
    if ($port -le 0 -or $port -gt 65535) { continue }
    $host_ = if ([string]::IsNullOrWhiteSpace([string]$server.host)) { '127.0.0.1' } else { [string]$server.host }
    $path = if ([string]::IsNullOrEmpty([string]$server.path)) { '/' } else { [string]$server.path }
    $endpoint = [pscustomobject]@{
      wsUrl       = "ws://${host_}:${port}${path}"
      host        = $host_
      port        = $port
      hasToken    = -not [string]::IsNullOrEmpty([string]$server.accessToken)
      tokenMasked = if ([string]::IsNullOrEmpty([string]$server.accessToken)) { '' } else { '***' }
    }
    $from = $file.FullName
    break
  }
  [pscustomobject]@{
    present  = ($null -ne $endpoint)
    files    = @($candidates | ForEach-Object { $_.FullName })
    endpoint = $endpoint
    from     = $from
  }
}

# ── ② 端口探活（不握手：只确认有人听） ──
function Test-TcpPort([string]$TargetHost, [int]$Port, [int]$TimeoutMs = 800) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $task = $client.ConnectAsync($TargetHost, $Port)
    if (-not $task.Wait($TimeoutMs)) { return $false }
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-ProbeOnce {
  $facts = Get-OneBotConfigFacts
  $listening = $false
  if ($facts.present) { $listening = Test-TcpPort $facts.endpoint.host $facts.endpoint.port }
  [pscustomobject]@{ facts = $facts; listening = $listening }
}

# ── ③ 现跑那一句汇总（可选：主进程在跑时走它的 HTTP，与界面看到的是同一份口径） ──
function Get-ApiSummary {
  $headers = @{}
  if ($Token -ne '') { $headers['Authorization'] = "Bearer $Token" }
  elseif (Test-Path (Join-Path $DataDir '.ui-token')) {
    $headers['Authorization'] = 'Bearer ' + (Get-Content (Join-Path $DataDir '.ui-token') -Raw).Trim()
  }
  if ($headers.Count -eq 0) { return $null }
  try {
    $res = Invoke-WebRequest -Uri "$ApiBase/api/protocol-side" -Headers $headers -SkipHttpErrorCheck -TimeoutSec 10
    if ($res.StatusCode -ne 200) { return "（/api/protocol-side 回了 HTTP $($res.StatusCode)）" }
    $body = $res.Content | ConvertFrom-Json
    return $body.summary
  } catch {
    return "（读不到：$($_.Exception.Message)）"
  }
}

function Write-Report($probe) {
  $facts = $probe.facts
  Write-Section '三档 · ② OneBot 配置'
  if (-not $facts.present) {
    Write-Host '  缺失：config/onebot.json（或 config/onebot_<uin>.json）还没有。'
    Write-Host '  ⇒ 这一档的意思就是"协议端从没登录过 QQ"：那一份是登录之后才物化的。'
    Write-Host '  ⇒ 下一步：打开面板（SnowLuma WebUI）→ 同意用户协议与隐私政策 → 接入 QQ 并扫码。'
    if ($facts.files.Count -gt 0) {
      $joined = ($facts.files -join ' / ')
      Write-Host "  （config 目录里有这些 onebot*.json，但都读不出端点：$joined）"
    }
  } else {
    Write-Host "  在：$($facts.from)"
    Write-Host "  端点 = $($facts.endpoint.wsUrl) · 带 token = $($facts.endpoint.hasToken)（值按规矩不打印）"
  }
  Write-Section '三档 · ③ 适配器'
  if (-not $facts.present) {
    Write-Host '  没有端点可连（不是"连不上"——这两句话的下一步不同）。'
  } elseif ($probe.listening) {
    Write-Host "  端口在听：$($facts.endpoint.host):$($facts.endpoint.port)"
    Write-Host '  ⇒ 适配器会自己连上（它按退避重连，退避上限 60 秒）。'
    Write-Host '  ⇒ 接下来做端到端那一条：从 QQ 那边发一条给她，然后看下面这两个证据：'
    Write-Host '     · 进站：data/events 里出现 channel/message（channel=onebot）'
    Write-Host '     · 出站：speak/sent 或 tool/call 的 speak 回执里带 onebot: 回投地址'
  } else {
    Write-Host "  配置里写着 $($facts.endpoint.wsUrl)，但那个端口没人听。"
    Write-Host '  ⇒ 协议端起来了但还没把 OneBot 服务开出来（看它的日志），或者它换过端口。'
  }
  $summary = Get-ApiSummary
  if ($summary) {
    Write-Section '主进程现在这一句（/api/protocol-side.summary）'
    Write-Host "  $summary"
  }
}

Write-Host "协议端目录：$serviceDir"
if (-not (Test-Path $serviceDir)) { throw "协议端目录不在：$serviceDir" }

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ($true) {
  $probe = Get-ProbeOnce
  if ($probe.facts.present -and $probe.listening) {
    Write-Report $probe
    Write-Host ''
    Write-Host '端点已出现。' -ForegroundColor Green
    exit 0
  }
  if (-not $Wait) {
    Write-Report $probe
    Write-Host ''
    Write-Host '端点还没出现（加 -Wait 可以守着等）。' -ForegroundColor Yellow
    exit 1
  }
  if ((Get-Date) -ge $deadline) {
    Write-Report $probe
    Write-Host ''
    Write-Host "等了 $TimeoutSeconds 秒仍没出现（这期间它没登录，或者登录了但 OneBot 服务没开）。" -ForegroundColor Yellow
    exit 1
  }
  Write-Host ("[{0:HH:mm:ss}] 还没有端点，{1} 秒后再看…" -f (Get-Date), $PollSeconds)
  Start-Sleep -Seconds $PollSeconds
}
