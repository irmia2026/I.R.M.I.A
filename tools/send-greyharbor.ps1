#Requires -Version 7
<#
.SYNOPSIS
向灰港的 IRMIA Ingress 入口投递一段文本。

.DESCRIPTION
默认读取 data/greyharbor-ingress.token，向本机 127.0.0.1:7788 的
/webhook/greyharbor 投递一条 wake/webhook 事件。

文本可以来自位置参数，也可以从标准输入读入。

.EXAMPLE
pwsh -File tools/send-greyharbor.ps1 "备份已经跑完"

.EXAMPLE
"提醒我看一眼磁盘" | pwsh -File tools/send-greyharbor.ps1

.EXAMPLE
pwsh -File tools/send-greyharbor.ps1 -DryRun "只看请求体，不真的投递"
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Text,

  [string] $BaseUrl = 'http://127.0.0.1:7788',
  [string] $Path = '/webhook/greyharbor',
  [string] $TokenFile = (Join-Path $PSScriptRoot '..\data\greyharbor-ingress.token'),
  [ValidateSet('info', 'warn', 'critical')]
  [string] $Severity = 'info',
  [string] $Kind = 'greyharbor-message',
  [string] $Title = '',
  [switch] $Prompt,
  [switch] $DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-Token([string] $file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    throw "找不到 token 文件：$file。把灰港 ingress token 写进这个文件，或改用 -TokenFile。"
  }
  $token = (Get-Content -LiteralPath $file -Raw).Trim()
  if ($token -eq '') { throw "token 文件为空：$file" }
  return $token
}

function Get-MessageText {
  if ($null -ne $Text -and $Text.Count -gt 0) {
    $joined = ($Text -join ' ').Trim()
    if ($joined -ne '') { return $joined }
  }
  if ($Prompt) {
    $typed = (Read-Host '输入要发送给灰港的文本').Trim()
    if ($typed -ne '') { return $typed }
  }
  if ([Console]::IsInputRedirected) {
    # Windows 的管道不保证按 UTF-8 交给子进程；显式按 UTF-8 读，避免中文变乱码。
    try { [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
    $stdin = [Console]::In.ReadToEnd().Trim()
    if ($stdin -ne '') { return $stdin }
  }
  throw '没有文本可投递。把文本作为参数，或从标准输入传进来。'
}

function Get-Title([string] $message, [string] $explicitTitle) {
  if ($explicitTitle.Trim() -ne '') { return $explicitTitle.Trim() }
  $firstLine = ($message -split "\r?\n", 2)[0].Trim()
  if ($firstLine -eq '') { $firstLine = '灰港消息' }
  if ($firstLine.Length -gt 200) { return $firstLine.Substring(0, 200) }
  return $firstLine
}

$message = Get-MessageText
$title = Get-Title -message $message -explicitTitle $Title
$dedupeKey = 'greyharbor:manual:{0}:{1}' -f `
  [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'), `
  [guid]::NewGuid().ToString('N').Substring(0, 8)

$payload = [ordered]@{
  kind       = $Kind
  severity   = $Severity
  title      = $title
  message    = $message
  observedAt = (Get-Date).ToString('o')
  dedupeKey  = $dedupeKey
}
$json = $payload | ConvertTo-Json -Compress

if ($DryRun) {
  Write-Output $json
  exit 0
}

$token = Read-Token -file $TokenFile
$base = $BaseUrl.TrimEnd('/')
$url = "$base$Path"

try {
  $response = Invoke-RestMethod `
    -Uri $url `
    -Method Post `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json; charset=utf-8' `
    -Body $json `
    -TimeoutSec 20
  $response | ConvertTo-Json -Compress
} catch {
  $detail = $_.Exception.Message
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    $detail = $_.ErrorDetails.Message
  }
  [Console]::Error.WriteLine("投递失败：$detail")
  exit 1
}
