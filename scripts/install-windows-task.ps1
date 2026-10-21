<#
.SYNOPSIS
    Irmia Agent — Windows 计划任务守护（docs/design.md §4.8、docs/milestones.md M4-5/M4-6）

.DESCRIPTION
    把 Irmia Agent 注册成计划任务，做无人值守的第一道防线：**开机即起、死了就拉**。
    三个框架都没有内置"挂了自动拉起"，这是必须自己补的洞——本脚本补的就是这个洞。

    注册出来的任务 IrmiaAgent 的语义：
      · 触发器   AtStartup（开机触发，带 $StartupDelaySeconds 秒延迟：系统刚起来时磁盘与网络还在热身）
      · 行动     <node.exe> "<项目根>\dist\main.js"，WorkingDirectory = 项目根
                 （工作目录必须是项目根：data/ 目录、config.json、persona 都按 cwd 解析）
      · 失败重启 RestartCount 999 / RestartInterval 1 分钟：崩溃后 1 分钟内被重新拉起
      · 电源     AllowStartIfOnBatteries + DontStopIfGoingOnBatteries（笔记本掉电不停机）
      · 超时     ExecutionTimeLimit = 0（无限制）：否则默认 3 天后任务会被计划程序杀掉
      · 单实例   MultipleInstances = IgnoreNew：任务层的去重。
                 **进程层的去重由 data/lock.json 负责**——计划程序只知道"上个任务实例还在跑"，
                 而崩溃遗留的陈旧锁只有单实例锁能判（M4-6 验收点）。

    权限：注册 AtStartup + SYSTEM/S4U 的任务需要**管理员权限**的 PowerShell：
        Start-Process pwsh -Verb RunAs -ArgumentList '-NoProfile','-File','<本脚本绝对路径>'
    SYSTEM 账户的任务在无人登录时照常运行——这是"无人值守"的默认选择；
    想跑在当前用户下就传 -UserId <用户名>（S4U 登录类型：不存密码、不登录也跑）。

.PARAMETER Action
    Install（默认）注册/覆盖任务；Uninstall 停止并删除任务；Status 只查询不动手。

.PARAMETER TaskName
    任务名，默认 IrmiaAgent。

.PARAMETER ProjectRoot
    项目根目录，默认为本脚本所在目录的上级（即仓库根）。

.PARAMETER NodeExe
    node.exe 绝对路径，默认为 PATH 上找到的那个。

.PARAMETER UserId
    运行账户，默认 SYSTEM；传用户名则用 S4U 登录类型。

.PARAMETER StartupDelaySeconds
    开机触发后的延迟秒数，默认 30。

.EXAMPLE
    pwsh -NoProfile -File scripts\install-windows-task.ps1
    以 SYSTEM 账户注册 IrmiaAgent（开机自启 + 失败 1 分钟重启）。

.EXAMPLE
    pwsh -NoProfile -File scripts\install-windows-task.ps1 -Action Status
    查询任务状态、重启策略、入口路径与单实例锁持有者。

.EXAMPLE
    pwsh -NoProfile -File scripts\install-windows-task.ps1 -Action Uninstall
    停止并删除任务（数据目录一个字节都不动）。

.NOTES
    卸载/重装都不动 data/：事件日志是唯一真相源，守护脚本只负责"让进程活着"。
#>

[CmdletBinding()]
param(
    [ValidateSet('Install', 'Uninstall', 'Status')]
    [string]$Action = 'Install',

    [string]$TaskName = 'IrmiaAgent',

    [string]$ProjectRoot = '',

    [string]$NodeExe = '',

    [string]$UserId = 'SYSTEM',

    [int]$StartupDelaySeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ──────────────────────────────── 解析与校验 ────────────────────────────────

# 项目根：显式传入优先，否则取本脚本所在目录的上级（scripts/ 与 src/、dist/ 同级）
function Resolve-IrmiaProjectRoot {
    param([string]$Root)

    if ($Root -ne '') {
        if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
            throw "项目根目录不存在：$Root"
        }
        return (Resolve-Path -LiteralPath $Root).Path
    }
    if ([string]::IsNullOrEmpty($PSScriptRoot)) {
        throw '无法从脚本位置推断项目根目录：请显式传 -ProjectRoot <项目根>'
    }
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

# node.exe：计划任务不继承交互式 shell 的 PATH，必须落成绝对路径
function Resolve-IrmiaNodeExe {
    param([string]$Exe)

    if ($Exe -ne '') {
        if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
            throw "node.exe 不存在：$Exe"
        }
        return (Resolve-Path -LiteralPath $Exe).Path
    }
    $found = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $found) {
        throw 'PATH 上找不到 node.exe：请用 -NodeExe 指定绝对路径'
    }
    return $found.Source
}

function Get-IrmiaEntryPath {
    param([string]$Root)
    return (Join-Path $Root (Join-Path 'dist' 'main.js'))
}

# ──────────────────────────────── 任务定义 ────────────────────────────────

# 任务四要素一次性构造好：安装与状态查询读同一份定义，避免两处口径漂移
function New-IrmiaTaskSpec {
    param(
        [string]$Root,
        [string]$Node,
        [int]$DelaySeconds,
        [string]$User
    )

    $entry = Get-IrmiaEntryPath -Root $Root
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
        throw "找不到入口 $entry —— 先在项目根执行 npm run build（守护跑的是编译产出，不是源码）"
    }

    $action = New-ScheduledTaskAction -Execute $Node -Argument "`"$entry`"" -WorkingDirectory $Root

    $trigger = New-ScheduledTaskTrigger -AtStartup
    if ($DelaySeconds -gt 0) {
        $trigger.Delay = "PT${DelaySeconds}S"
    }

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    $principal = if ($User -eq 'SYSTEM') {
        New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    }
    else {
        # S4U：不保存密码，用户未登录也运行（无人值守机器的常规账户形态）
        New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest
    }

    return @{
        Action    = $action
        Trigger   = $trigger
        Settings  = $settings
        Principal = $principal
        Entry     = $entry
    }
}

function Get-IrmiaTaskDescription {
    return 'Irmia Agent 无人值守守护：开机自启，异常退出后 1 分钟内自动重新拉起（单实例去重由 data/lock.json 负责）'
}

# 十六进制任务结果 → 人话（常见取值；未知取值原样显示）
function Format-IrmiaTaskResult {
    param([int]$Code)

    switch ($Code) {
        0 { return '成功' }
        267009 { return '正在运行（0x41301）' }
        267011 { return '尚未运行过（0x41303）' }
        267014 { return '被用户或计划程序终止（0x41306）' }
        default { return ("0x{0:X}" -f $Code) }
    }
}

# ──────────────────────────────── 安装 ────────────────────────────────

function Install-IrmiaAgentTask {
    param(
        [string]$TaskName,
        [string]$Root,
        [string]$Node,
        [int]$DelaySeconds,
        [string]$User
    )

    $spec = New-IrmiaTaskSpec -Root $Root -Node $Node -DelaySeconds $DelaySeconds -User $User

    # -Force：已注册时覆盖（改路径/改延迟后重跑本脚本即可生效，不需要先卸载）
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $spec.Action `
        -Trigger $spec.Trigger `
        -Settings $spec.Settings `
        -Principal $spec.Principal `
        -Description (Get-IrmiaTaskDescription) `
        -Force | Out-Null

    Write-Host "已注册计划任务 $TaskName"
    Write-Host "  入口    : $($spec.Entry)"
    Write-Host "  node    : $Node"
    Write-Host "  工作目录: $Root"
    Write-Host "  运行账户: $User"
    Write-Host "  重启策略: 失败后每 1 分钟重启，最多 999 次"
    Write-Host "  提示    : 立即试跑一次用 Start-ScheduledTask -TaskName $TaskName"
}

# ──────────────────────────────── 卸载 ────────────────────────────────

function Uninstall-IrmiaAgentTask {
    param([string]$TaskName)

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Host "计划任务 $TaskName 不存在，无需卸载"
        return
    }

    if ($task.State -eq 'Running') {
        # 先停任务再删：任务删掉不保证已经起来的 node 进程被回收
        Stop-ScheduledTask -TaskName $TaskName
        Write-Host "已停止正在运行的任务实例"
    }

    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "已删除计划任务 $TaskName（data/ 未改动；如需停止已拉起的进程，请结束对应的 node.exe）"
}

# ──────────────────────────────── 状态查询 ────────────────────────────────

function Get-IrmiaAgentTaskStatus {
    param(
        [string]$TaskName,
        [string]$Root
    )

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Host "计划任务 $TaskName：未注册（守护未生效，进程死了不会被拉起）"
        return
    }

    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "计划任务 $TaskName"
    Write-Host "  状态    : $($task.State)"
    Write-Host "  上次运行: $($info.LastRunTime) · 结果 $($info.LastTaskResult)（$(Format-IrmiaTaskResult -Code $info.LastTaskResult)）"
    Write-Host "  下次运行: $($info.NextRunTime) · 错过次数 $($info.NumberOfMissedRuns)"

    foreach ($act in $task.Actions) {
        Write-Host "  动作    : $($act.Execute) $($act.Arguments)"
        Write-Host "  工作目录: $($act.WorkingDirectory)"
    }
    foreach ($trg in $task.Triggers) {
        Write-Host "  触发器  : $($trg.CimClass.CimClassName)（延迟 $($trg.Delay)）"
    }

    $settings = $task.Settings
    Write-Host "  重启策略: 每 $($settings.RestartInterval) 最多 $($settings.RestartCount) 次；"
    Write-Host "            电池:$($settings.DisallowStartIfOnBatteries -eq $false) 超时:$($settings.ExecutionTimeLimit) 多实例:$($settings.MultipleInstances)"

    # 入口与数据目录：任务注册得对，但产物被删掉时守护会一直失败——这里当场看得出来
    $entry = Get-IrmiaEntryPath -Root $Root
    if (Test-Path -LiteralPath $entry -PathType Leaf) {
        Write-Host "  入口    : $entry（存在）"
    }
    else {
        Write-Host "  入口    : $entry（**不存在**，先 npm run build）"
    }

    # 单实例锁：任务是外壳，真正防双写的是这把锁（design §4.8）
    $lockPath = Join-Path (Join-Path $Root 'data') 'lock.json'
    if (Test-Path -LiteralPath $lockPath) {
        $record = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        $alive = $null -ne (Get-Process -Id $record.pid -ErrorAction SilentlyContinue)
        $stateText = if ($alive) { '进程存活，锁有效' } else { '陈旧记录，下次启动会接管' }
        Write-Host "  单实例锁: pid $($record.pid)（$stateText）· 心跳 $($record.heartbeatAt)"
    }
    else {
        Write-Host '  单实例锁: 未持有（没有 lock.json）'
    }
}

# ──────────────────────────────── 入口分发 ────────────────────────────────

switch ($Action) {
    'Install' {
        Install-IrmiaAgentTask `
            -TaskName $TaskName `
            -Root (Resolve-IrmiaProjectRoot -Root $ProjectRoot) `
            -Node (Resolve-IrmiaNodeExe -Exe $NodeExe) `
            -DelaySeconds $StartupDelaySeconds `
            -User $UserId
    }
    'Uninstall' {
        Uninstall-IrmiaAgentTask -TaskName $TaskName
    }
    'Status' {
        Get-IrmiaAgentTaskStatus -TaskName $TaskName -Root (Resolve-IrmiaProjectRoot -Root $ProjectRoot)
    }
}
