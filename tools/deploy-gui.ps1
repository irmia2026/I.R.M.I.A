$ErrorActionPreference = 'Continue'
$env:HTTP_PROXY = ''
$env:HTTPS_PROXY = ''
$env:ALL_PROXY = ''
$repo = 'C:\Users\admin\Documents\linre-src\L.i.N.R.E'
$runId = '42291135553'
$guiRoot = 'C:\Users\admin\AppData\Local\Irmia\Agent\gui'
$staging = Join-Path $repo 'tmp-gui-build'

Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 等待构建 $runId"
gh run watch $runId -R pashippercode/L.i.N.R.E --exit-status 2>&1 | Select-Object -Last 8
if ($LASTEXITCODE -ne 0) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 构建失败，退出码 $LASTEXITCODE"
  exit 1
}
Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 构建成功，开始下载"
if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
gh run download $runId -R pashippercode/L.i.N.R.E -n irmia-gui-windows -D $staging 2>&1 | Select-Object -Last 4
if ($LASTEXITCODE -ne 0) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 下载失败"
  exit 1
}
$exe = Get-ChildItem -LiteralPath $staging -Filter 'irmia_gui.exe' -Recurse -File | Select-Object -First 1
if ($null -eq $exe) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 产物里没找到 irmia_gui.exe"
  Get-ChildItem -LiteralPath $staging -Recurse -File | Select-Object -First 10 FullName
  exit 1
}
$sourceDir = $exe.Directory.FullName
Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 产物目录：$sourceDir"
$backup = "$guiRoot.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $guiRoot -Destination $backup -Recurse -Force
Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 旧界面已备份到 $backup"
Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Copy-Item -Path (Join-Path $sourceDir '*') -Destination $guiRoot -Recurse -Force
Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 已覆盖界面目录"
& cmd.exe /c start "" (Join-Path $guiRoot 'irmia_gui.exe')
Start-Sleep -Seconds 12
$proc = Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $proc) {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 新界面已启动：pid=$($proc.Id) 窗口=$($proc.MainWindowHandle) 标题=$($proc.MainWindowTitle)"
} else {
  Write-Output "[$(Get-Date -Format 'HH:mm:ss')] 新界面没有起来，需要排查"
}
Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
