# 启动 Irmia GUI（主进程需已在跑）
# 用法: .\scripts\start-gui.ps1 [-Exe <irmia_gui.exe 绝对路径>] [-Port 7788]
param(
  # 界面可执行文件：默认取本仓库 gui 的 release 构建产物（相对本脚本推导，不写死机器路径）
  [string]$Exe = '',
  # 主进程监听端口（与 config.json 的 web.port 一致）
  [int]$Port = 7788
)

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ($Exe -eq '') {
  $Exe = Join-Path $repo 'gui\build\windows\x64\runner\Release\irmia_gui.exe'
}
$tokenFile = "$env:APPDATA\Irmia\gui-token"
$tokenSrc = Join-Path $repo 'data\.ui-token'

if (-not (Test-Path $Exe)) { Write-Error "GUI 未编译：$Exe"; exit 1 }

# 主进程在线？不在线就起一个（后台）
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Write-Host '主进程不在，先起主进程…'
  Start-Process -FilePath node -ArgumentList 'dist/main.js' -WorkingDirectory $repo -WindowStyle Hidden
  Start-Sleep -Seconds 4
}

# token 同步到 GUI 存储（首次或主机进程重生后 token 变化都覆盖）
if (Test-Path $tokenSrc) {
  $token = (Get-Content $tokenSrc -Raw).Trim()
  New-Item -ItemType Directory -Force -Path (Split-Path $tokenFile) | Out-Null
  Set-Content -Path $tokenFile -Value $token -NoNewline
}

Start-Process -FilePath $Exe
Write-Host 'GUI 已启动（1350×900）'
