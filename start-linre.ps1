# Linre 手动启动入口：后端持续运行，GUI 由现有 Linre 保活/计划任务管理。
param([switch]$StartGuiMinimized)
$script = Join-Path $PSScriptRoot 'linre-keepalive.ps1'
& (Get-Command pwsh.exe -ErrorAction Stop).Source -NoProfile -ExecutionPolicy Bypass -File $script -Repo $PSScriptRoot -Once -StartGuiMinimized:$StartGuiMinimized
exit $LASTEXITCODE
