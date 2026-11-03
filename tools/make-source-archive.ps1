# 生成"对应源码"归档（AGPL-3.0 第 1 条"Corresponding Source" / 第 6(d) 条）
#
# 为什么需要它：我们分发的是二进制（安装器 / 便携包）。AGPL 要求同时提供**足以生成、安装、
# 运行该二进制的源码**，其中包括打包与安装脚本（packaging/）。公开仓的"脱敏快照"刻意不发
# 内部打包管线，所以发版时必须**另外附一份完整的源码归档**（放在同一个发行页上），
# 这样既满足许可，也不用把私有开发历史公开。
#
# 用法：
#   pwsh -File tools/make-source-archive.ps1 -Version 0.1.0-beta.14
#   pwsh -File tools/make-source-archive.ps1 -Version 0.1.0-beta.14 -OutDir <仓库同级>\dist-release
#
# 产出：<OutDir>\irmia-agent-v<Version>-source.zip（+ 打印大小与 SHA256，供发行说明引用）

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$OutDir = '',
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [switch]$VerifyBuild,
  [string]$Npm = 'npm.cmd',
  [string]$Flutter = 'flutter'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# 输出目录默认放在**仓库同级**的 dist-release（不写死任何本机绝对路径：
# 这个脚本会进公开副本，写死本机路径会被脱敏闸门的词表拦下——2026-10-30 真的栽过一次）。
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path (Split-Path -Parent $Repo) 'dist-release'
}

function Fail([string]$Message) {
  throw $Message
}

if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { Fail 'Version 不能包含路径分隔符或空白' }

# ① 归档内容 = 构建/安装/运行所需的最小子集（不含 data/、构建产物、私有文档）
$IncludePaths = @(
  'src',
  'gui/lib', 'gui/test', 'gui/windows', 'gui/assets', 'gui/.metadata',
  'gui/pubspec.yaml', 'gui/pubspec.lock', 'gui/analysis_options.yaml',
  'packaging',
  'tools',
  'test',
  'scripts',
  'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.test.json', 'config.example.json',
  'examples',
  # 只归档实际随包分发的公开技能，不递归复制含私有资源的 skills 根。
  'skills/irmia-framework', 'skills/office',
  'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
  'docs/ARCHITECTURE.md', 'docs/schema.md'
  # 插件系统文档暂不公开（2026-11-02 用户）：源码归档也不带
  # （docs/plugin-*.md、docs/plugin-platform-*.md 都在仓库里，等可以公开时再加回来）
)

# ② 一定排除的东西（数据、缓存、构建产物、私有文档、git 元数据）
$ExcludeDirs = @('.git', 'node_modules', 'dist', 'build', '.dart_tool', 'data', '.idea', '.vscode', 'coverage', 'ephemeral', '__pycache__')
$ExcludeFiles = @('*.log', '*.zip', '*.exe', '*.dll', '*.pdb', '*.pyc', '*.pyo', '.env', '.installed.json', '.DS_Store', 'Thumbs.db')

$TempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
if ($VerifyBuild) {
  # MSVC/CMake 不能可靠处理中文工程路径；验证目录放在调用方指定的 ASCII 输出目录下。
  $TempRoot = [System.IO.Path]::GetFullPath($OutDir).TrimEnd('\', '/')
  if ($TempRoot -match '[^\x00-\x7F]') { Fail '-VerifyBuild 需要纯 ASCII 的 -OutDir（Windows 工具链限制）' }
  New-Item -ItemType Directory -Force -Path $TempRoot | Out-Null
}
$Stage = Join-Path $TempRoot ("irmia-source-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
$Payload = Join-Path $Stage 'irmia-agent'
try {
New-Item -ItemType Directory -Force -Path $Payload | Out-Null

Write-Host "=== 1/4 拷贝源码（不跟随 .git / 构建产物）"
foreach ($rel in $IncludePaths) {
  $src = Join-Path $Repo $rel
  if (-not (Test-Path $src)) { Write-Host "  跳过（不存在）：$rel"; continue }
  $dst = Join-Path $Payload $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  if ((Get-Item $src).PSIsContainer) {
    $robocopyArgs = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD') + $ExcludeDirs + @('/XF') + $ExcludeFiles
    & robocopy @robocopyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "robocopy 失败：$rel（exit=$LASTEXITCODE）" }
  } else {
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
}

Write-Host "=== 2/4 补齐 gui 的构建必需文件（Flutter 工程壳）"
$guiSrc = Join-Path $Repo 'gui'
foreach ($rel in @('pubspec.yaml', 'analysis_options.yaml')) {
  $p = Join-Path $guiSrc $rel
  if (Test-Path $p) { Copy-Item -LiteralPath $p -Destination (Join-Path $Payload "gui/$rel") -Force }
}

# pubspec 声明的本地资源必须进入归档；目录会连同分辨率变体整体复制。
$pubspec = Join-Path $Payload 'gui/pubspec.yaml'
if (Test-Path -LiteralPath $pubspec) {
  $yaml = [System.IO.File]::ReadAllText($pubspec)
  $section = [regex]::Match($yaml, '(?ms)^  assets:[ \t]*\r?\n(?<body>.*?)(?=^  \S|\z)')
  foreach ($asset in [regex]::Matches($section.Groups['body'].Value, '(?m)^    -[ \t]+(?<path>[^#\r\n]+)')) {
    $assetName = $asset.Groups['path'].Value.Trim().Trim('"', "'")
    $guiRoot = [System.IO.Path]::GetFullPath((Join-Path $Payload 'gui')).TrimEnd('\', '/')
    $assetPath = [System.IO.Path]::GetFullPath((Join-Path $guiRoot $assetName))
    if (-not $assetPath.StartsWith($guiRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
      Fail "gui asset 越过工程目录：$assetName"
    }
    if (-not (Test-Path -LiteralPath $assetPath)) { Fail "源码归档缺少 gui asset：$assetName" }
  }
}

Write-Host "=== 3/4 脱敏扫描（复用出包闸门的私有词表，别自造宽正则）"
# 为什么不用"用户名/绝对路径"这类通用正则：仓库里本来就有形如 <用户目录>/you、/home/me 的占位符
# 这种**文档占位符**，宽正则必然误报，最后只能被关掉。私有词表（真人名/真路径）才是判据。
$gate = Join-Path $PSScriptRoot 'package-gate.ps1'
if (-not (Test-Path $gate)) { Fail "找不到出包闸门：$gate" }
& pwsh -NoProfile -File $gate -Path $Payload | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Fail "私有词表命中（exit=$LASTEXITCODE）。源码归档不许带着私有内容发出去。"
}
Write-Host "  私有词表：无命中"

# 另外只查"像真密钥"的几种形态（占位符不会长这样）
$secretPatterns = @('sk-[A-Za-z0-9]{20,}', 'AKIA[0-9A-Z]{16}', 'ghp_[A-Za-z0-9]{30,}', 'xoxb-[0-9]{10,}')
$secretHits = @()
foreach ($pattern in $secretPatterns) {
  $found = Get-ChildItem -Path $Payload -Recurse -File | Select-String -Pattern $pattern -AllMatches -ErrorAction SilentlyContinue
  foreach ($f in $found) { $secretHits += ("{0}:{1}" -f $f.Path.Replace($Payload, ''), $f.LineNumber) }
}
if ($secretHits.Count -gt 0) {
  $secretHits | Select-Object -First 10 | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
  Fail "源码归档里出现疑似真实密钥 $($secretHits.Count) 处，已中止"
}
Write-Host "  疑似密钥：无命中"

Write-Host "=== 4/4 打包"
$zipName = "irmia-agent-v$Version-source.zip"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zipPath = Join-Path $OutDir $zipName
$pendingZip = Join-Path $OutDir ('.' + $zipName + '.' + [guid]::NewGuid().ToString('n') + '.tmp')
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($Payload, $pendingZip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
if ($VerifyBuild) {
  if (-not $IsWindows) { Fail '归档复验需要 Windows（含 Windows GUI 构建）' }
  $verifyRoot = Join-Path $Stage 'verify'
  [System.IO.Compression.ZipFile]::ExtractToDirectory($pendingZip, $verifyRoot)
  Push-Location (Join-Path $verifyRoot 'irmia-agent')
  try {
    & $Npm ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { Fail '归档复验：npm ci 失败' }
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { Fail '归档复验：后端构建失败' }
    Push-Location 'gui'
    try {
      & $Flutter pub get
      if ($LASTEXITCODE -ne 0) { Fail '归档复验：Flutter 依赖获取失败' }
      & $Flutter build windows --release
      if ($LASTEXITCODE -ne 0) { Fail '归档复验：Windows GUI 构建失败' }
    } finally { Pop-Location }
  } finally { Pop-Location }
  Write-Host '归档解压后后端与 Windows GUI 构建：通过'
}
Move-Item -LiteralPath $pendingZip -Destination $zipPath -Force

$item = Get-Item $zipPath
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
Write-Host ''
Write-Host '源码归档已生成：' -ForegroundColor Green
Write-Host ("  路径   ：{0}" -f $zipPath)
Write-Host ("  大小   ：{0:N0} 字节（{1:N1} MB）" -f $item.Length, ($item.Length / 1MB))
Write-Host ("  SHA256 ：{0}" -f $hash)
Write-Host ''
Write-Host '发版时把它和安装器/便携包放在同一个发行页（AGPL 第 6(d) 条：同一地点、同等便利）。'
} finally {
  $resolvedStage = [System.IO.Path]::GetFullPath($Stage)
  if ([System.IO.Path]::GetDirectoryName($resolvedStage) -ne $TempRoot -or
      [System.IO.Path]::GetFileName($resolvedStage) -notmatch '^irmia-source-[a-f0-9]{8}$') {
    throw '拒绝清理意外的源码暂存目录'
  }
  Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
  if (Get-Variable pendingZip -ErrorAction SilentlyContinue) {
    if (Test-Path -LiteralPath $pendingZip) { Remove-Item -LiteralPath $pendingZip -Force }
  }
}
