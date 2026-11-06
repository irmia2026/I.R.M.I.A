param(
  [string]$Repo = '',
  [int]$IntervalSeconds = 10,
  [switch]$Once,
  [switch]$Status,
  [switch]$Stop,
  [switch]$StartGuiMinimized,
  [switch]$KeepGui,
  [switch]$NoTray,
  [int]$NodeMaxOldSpaceMb = 512
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrEmpty($Repo)) { $Repo = $PSScriptRoot }
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$AgentRoot = 'C:\Users\admin\AppData\Local\Irmia\Agent'
$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$ServerJs = Join-Path $Repo 'dist\main.js'
$GuiExe = Join-Path $AgentRoot 'gui\irmia_gui.exe'
$DataDir = Join-Path $Repo 'data'
$LogDir = Join-Path $DataDir 'logs'
$CfgPath = Join-Path $Repo 'config.json'
$PidPath = Join-Path $DataDir 'linre-keepalive.pid'
$LoopPidPath = Join-Path $DataDir 'linre-keepalive-loop.pid'
$Sentinel = Join-Path $DataDir 'linre-keepalive.off'

if (Test-Path -LiteralPath $LoopPidPath) { Remove-Item -LiteralPath $LoopPidPath -Force -ErrorAction SilentlyContinue }

function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    Add-Content -LiteralPath (Join-Path $DataDir 'linre-keepalive.log') -Value $line -Encoding UTF8
  } catch { }
  Write-Host $line
}

function Get-Port {
  $port = 7788
  try {
    if (Test-Path -LiteralPath $CfgPath) {
      $cfg = Get-Content -LiteralPath $CfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($cfg.web -and $cfg.web.port) { $port = [int]$cfg.web.port }
    }
  } catch { }
  return $port
}

function Test-PortOpen([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Get-BackendProcesses {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($ServerJs.ToLower()) })
  } catch { return @() }
}

function Start-Backend([int]$Port) {
  if ([string]::IsNullOrEmpty($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe)) {
    Write-Log '找不到 PATH 中的 node.exe，无法启动 Linre'
    return
  }
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $LogDir ("linre-$stamp.out.log")
  $err = Join-Path $LogDir ("linre-$stamp.err.log")
  $argList = @()
  if ($NodeMaxOldSpaceMb -gt 0) { $argList += ('--max-old-space-size=' + $NodeMaxOldSpaceMb) }
  $argList += $ServerJs
  $env:IRMIA_DATA_DIR = $DataDir
  $env:IRMIA_WEB_PORT = "$Port"
  try {
    $process = Start-Process -FilePath $NodeExe -ArgumentList $argList -WorkingDirectory $Repo -WindowStyle Hidden `
      -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Write-Log ("Linre 后端已启动：pid={0}，端口={1}，日志={2}" -f $process.Id, $Port, $out)
  } catch {
    Write-Log ("启动 Linre 后端失败：{0}" -f $_.Exception.Message)
  }
}

if (-not ('GuiWin' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class GuiWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
}
'@ -ErrorAction SilentlyContinue
}

function Open-Gui {
  if (-not (Test-Path -LiteralPath $GuiExe)) { Write-Log ("GUI 不存在：{0}" -f $GuiExe); return }
  $procs = @(Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) {
    $ids = @{}
    foreach ($process in $procs) { $ids[[uint32]$process.Id] = $true }
    $script:guiWindow = [IntPtr]::Zero
    $cb = [GuiWin+EnumWindowsProc] {
      param($hWnd, $lParam)
      $owner = [uint32]0
      [void][GuiWin]::GetWindowThreadProcessId($hWnd, [ref]$owner)
      if ($ids.ContainsKey($owner) -and [GuiWin]::GetWindowTextLength($hWnd) -gt 0) {
        $script:guiWindow = $hWnd
        return $false
      }
      return $true
    }
    [void][GuiWin]::EnumWindows($cb, [IntPtr]::Zero)
    if ($script:guiWindow -ne [IntPtr]::Zero) {
      [void][GuiWin]::ShowWindow($script:guiWindow, 9)
      [void][GuiWin]::SetForegroundWindow($script:guiWindow)
      Write-Log '已唤醒已有界面窗口'
      return
    }
    foreach ($process in $procs) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    Write-Log '界面进程在但没有窗口，已清掉准备重开'
    Start-Sleep -Milliseconds 800
  }
  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $GuiExe
    $startInfo.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($startInfo) | Out-Null
    Write-Log 'Linre GUI 已拉起'
  } catch { Write-Log ("启动 Linre GUI 失败：{0}" -f $_.Exception.Message) }
}

function Invoke-LoopTick {
  if (Test-Path -LiteralPath $Sentinel) { return }
  $port = Get-Port
  if (Test-PortOpen $port) {
    $script:lastStart = $null
  } elseif ($null -eq $script:lastStart -or ((Get-Date) - $script:lastStart).TotalSeconds -ge 90) {
    $script:lastStart = Get-Date
    Start-Backend $port
  }
  if ($KeepGui -and (Test-PortOpen $port)) {
    if (-not (Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue)) { Open-Gui }
  }
}

if ($Status) {
  $port = Get-Port
  $portState = if (Test-PortOpen $port) { '监听中' } else { '未监听' }
  $backendIds = ((Get-BackendProcesses | ForEach-Object ProcessId) -join ',')
  $guiProcs = @(Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue)
  $guiState = if ($guiProcs.Count -eq 0) { '未运行' } else { "$($guiProcs.Count) 个进程，主窗口句柄 $($guiProcs[0].MainWindowHandle)" }
  $sentinelState = if (Test-Path -LiteralPath $Sentinel) { '已暂停' } else { '未暂停' }
  $trayState = if (Test-Path -LiteralPath $PidPath) { '在' } else { '不在' }
  Write-Host ("Linre repo: {0}`n端口: {1}（{2}）`n后端: {3}`n界面: {4}`n托盘: {5}`n哨兵: {6}" -f `
    $Repo, $port, $portState, $backendIds, $guiState, $trayState, $sentinelState)
  exit 0
}

if ($Stop) {
  if (Test-Path -LiteralPath $PidPath) {
    $value = (Get-Content -LiteralPath $PidPath -Raw -ErrorAction SilentlyContinue).Trim()
    if (-not [string]::IsNullOrEmpty($value)) { Stop-Process -Id ([int]$value) -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  }
  foreach ($process in @(Get-BackendProcesses)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Log 'Linre 后端与保活已停止'
  exit 0
}

if (Test-Path -LiteralPath $Sentinel) { Write-Log '检测到 linre-keepalive.off，保活暂停'; exit 0 }

if ($Once) {
  $port = Get-Port
  if (-not (Test-PortOpen $port)) { Start-Backend $port; Start-Sleep -Seconds 5 }
  if ($KeepGui) { Open-Gui }
  exit 0
}

$script:lastStart = $null

if ($NoTray) {
  Set-Content -LiteralPath $LoopPidPath -Value $PID -Encoding UTF8
  while ($true) {
    Start-Sleep -Seconds ([Math]::Max(2, $IntervalSeconds))
    Invoke-LoopTick
  }
}

$existing = @(Get-Process -Name 'pwsh' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID })
$current = [Threading.Thread]::CurrentThread.GetApartmentState()
if ($current -ne [Threading.ApartmentState]::STA) {
  $pwshExe = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
  if (-not [string]::IsNullOrEmpty($pwshExe)) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-WindowStyle', 'Hidden',
      '-File', $PSCommandPath, '-Repo', $Repo, '-IntervalSeconds', $IntervalSeconds,
      '-NodeMaxOldSpaceMb', $NodeMaxOldSpaceMb)
    if ($StartGuiMinimized) { $argList += '-StartGuiMinimized' }
    if ($KeepGui) { $argList += '-KeepGui' }
    Start-Process -FilePath $pwshExe -ArgumentList $argList -WindowStyle Hidden
    exit 0
  }
}

Set-Content -LiteralPath $PidPath -Value $PID -Encoding UTF8

if (-not (Test-PortOpen (Get-Port))) { Start-Backend (Get-Port) }
if ($KeepGui -and -not (Get-Process -Name 'irmia_gui' -ErrorAction SilentlyContinue)) { Open-Gui }

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $notify = New-Object System.Windows.Forms.NotifyIcon
  try { $notify.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($GuiExe) } catch { }
  if ($null -eq $notify.Icon) { $notify.Icon = [System.Drawing.SystemIcons]::Application }
  $notify.Text = 'Linre 后端'
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add('打开界面')
  $openItem.add_Click({ Open-Gui })
  $restartItem = $menu.Items.Add('重启后端')
  $restartItem.add_Click({
    foreach ($process in @(Get-BackendProcesses)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  })
  $logItem = $menu.Items.Add('打开日志')
  $logItem.add_Click({ try { Start-Process -FilePath explorer.exe -ArgumentList $LogDir } catch { } })
  [void]$menu.Items.Add('-')
  $quitItem = $menu.Items.Add('退出保活')
  $quitItem.add_Click({
    try { $script:notify.Visible = $false } catch { }
    try { $script:context.ExitThread() } catch { }
  })
  $notify.ContextMenuStrip = $menu
  $notify.add_DoubleClick({ Open-Gui })

  $context = New-Object System.Windows.Forms.ApplicationContext
  $script:context = $context
  $script:notify = $notify

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = [Math]::Max(5000, $IntervalSeconds * 1000)
  $timer.add_Tick({
    if (-not (Test-PortOpen (Get-Port))) {
      if ($null -eq $script:lastStart -or ((Get-Date) - $script:lastStart).TotalSeconds -ge 90) {
        $script:lastStart = Get-Date
        Start-Backend (Get-Port)
      }
    } else {
      $script:lastStart = $null
    }
    if ($null -ne $script:notify) {
      $label = if (Test-Path -LiteralPath $Sentinel) { 'Linre 后端：已暂停' }
               elseif (Test-PortOpen (Get-Port)) { 'Linre 后端：在线' }
               else { 'Linre 后端：正在启动' }
      try { $script:notify.Text = $label } catch { }
    }
  })
  $timer.Start()
  $script:timer = $timer

  Write-Log ('托盘已就位：pid={0}，双击打开界面，右键可重启后端或退出保活' -f $PID)
  [System.Windows.Forms.Application]::Run($context)

  $script:timer.Stop()
  Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
  try { $notify.Dispose() } catch { }
  Write-Log '托盘已退出'
  exit 0
} catch {
  Write-Log ("托盘创建失败，退回无图标常驻：{0}" -f $_.Exception.Message)
  while ($true) {
    Start-Sleep -Seconds ([Math]::Max(2, $IntervalSeconds))
    Invoke-LoopTick
  }
}
