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
# 产出：<OutDir>\irmia-agent-v<Version>-source.zip
#       + <OutDir>\irmia-agent-v<Version>-source.sanitize-report.json（脱敏报表：命中文件/规则/次数，
#                                                                   **不含具体敏感值**）
#       （+ 打印 zip 大小与 SHA256，供发行说明引用）
#
# 2026-11-05 归档内容：`packs\` 与内置 skills **不再手抄目录名**——统一按
# `src/runtime/subagent-profiles.ts` 的 `builtin:` 安装清单（由 `packaging/builtin-payload.mjs`
# 现算），并在压缩前用同一支脚本 `--check` 按 Profile 里钉的 sha256 逐个复核。
# 为什么源码归档也要这些：二进制包里的 `packs/subagents/skills`、`packs/subagents/tools`、
# 内置 `skills/` 等是"安装角色"的运行期依赖；AGPL 的"对应源码"如果少了它们，拿这份源码
# 构建出来的包仍然会 source-missing——那就不是"足以生成、安装、运行该二进制"的源码。
#
# 2026-11-05「脱敏后归档」（第 4 步）：
#   归档里包含内部 test/**、tools/**（对应源码必须完整），其中确实有私有词（人格名/本机路径/
#   私有工具痕迹）与几个"像密钥"的夹具。**不裁掉它们、也不放宽闸门**，而是对**输出副本**做脱敏：
#     · 规则表与 publish-oss 共用 `tools/sanitize-rules.mjs`（没有第二份）；
#     · 先 dry-run 打印命中文件/规则/次数（不含敏感值），再 apply；apply 后残留命中 ⇒ 非 0、不产 zip；
#     · 内置包来源按 sha256 钉死，`--skip-prefix` 划出脱敏面，apply 后再 `--check` 一次兜底；
#     · 精确夹具规则（如 AWS 官方文档示例 key）只对列出的文件生效，**不放宽**下面的全局密钥形态扫描；
#     · 第 5 步仍是**独立复扫**（私有词闸门 + 密钥形态扫描，目标 0 命中）——它是判据，不是装饰。

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$OutDir = '',
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [switch]$VerifyBuild,
  # 排障用：失败时也保留暂存目录（默认无论成败都清）。--dry-run 脱敏报表与闸门排查要用它。
  [switch]$KeepStage,
  [string]$Npm = 'npm.cmd',
  [string]$Flutter = 'flutter'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# 输出统一 UTF-8：这支脚本会被出包链/测试以**管道**方式调用（node spawnSync、`| Tee-Object` 等），
# 默认控制台代码页（936）会把中文日志与失败信息解码成乱码——出问题时人看不懂，测试也断言不了。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# 输出目录默认放在**仓库同级**的 dist-release（不写死任何本机绝对路径：
# 这个脚本会进公开副本，写死本机路径会被脱敏闸门的词表拦下——2026-10-30 真的栽过一次）。
if ([string]::IsNullOrWhiteSpace($OutDir)) {
  $OutDir = Join-Path (Split-Path -Parent $Repo) 'dist-release'
}

function Fail([string]$Message) {
  throw $Message
}

if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]*$') { Fail 'Version 不能包含路径分隔符或空白' }

# ── 内置包来源清单/自检脚本：与装配、拆包复验**共用同一支**（唯一真相源在 Profile 的 install 清单）──
# 为什么源码归档也需要它：二进制包里的 packs\ 与内置 skills 是"安装角色"的运行期依赖；
# 源码归档少了它们，这份源码构建出来的包仍然 source-missing。清单与 hash 判据不在这里手抄。
$BuiltinPayloadScript = Join-Path $Repo 'packaging\builtin-payload.mjs'
if (-not (Test-Path -LiteralPath $BuiltinPayloadScript)) { Fail "找不到内置包来源脚本：$BuiltinPayloadScript（源码归档必须带 packaging\）" }
$NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeExe) {
  # 出包机的 node 不一定在 PATH 上（release.ps1 用的是显式路径），按「安装根 = 仓库根上一级」再找一次。
  foreach ($candidate in @(
      (Join-Path (Split-Path -Parent $Repo) 'tools\node\node.exe'),
      (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )) {
    if (Test-Path -LiteralPath $candidate) { $NodeExe = $candidate; break }
  }
}
if (-not $NodeExe) { Fail '找不到 node：源码归档要按 Profile 清单核对内置包来源（PATH 与安装根 tools\node\ 都没有）。' }

# 调一次内置包清单/自检（统一处理退出码与中文输出的控制台编码）。
function Invoke-BuiltinPayload([string[]]$PayloadArgs) {
  $previous = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $lines = @(& $NodeExe $BuiltinPayloadScript @PayloadArgs 2>&1)
    $code = $LASTEXITCODE
  } finally {
    [Console]::OutputEncoding = $previous
  }
  return @{ code = $code; lines = $lines }
}

$manifestRun = Invoke-BuiltinPayload @('--json', '--repo', $Repo)
$manifestJson = @($manifestRun.lines | ForEach-Object { "$_" } | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1)
if ($manifestJson.Count -eq 0) { Fail "内置包来源清单没有输出 JSON（exit=$($manifestRun.code)）：$($manifestRun.lines -join ' / ')" }
$builtinManifest = $manifestJson[0] | ConvertFrom-Json
if ($manifestRun.code -ne 0) { Fail "内置包来源清单不完整（exit=$($manifestRun.code)）：$($builtinManifest.problems -join '；')" }

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
  'sdk',
  # 只归档实际随包分发的公开技能，不递归复制含私有资源的 skills 根。
  'skills/irmia-framework', 'skills/office',
  'README.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md',
  'docs/ARCHITECTURE.md', 'docs/schema.md'
  # 插件系统文档暂不公开（2026-11-02 用户）：源码归档也不带
  # （docs/plugin-*.md、docs/plugin-platform-*.md 都在仓库里，等可以公开时再加回来）
)

# ①（续）内置包来源：packs\ 与 skills\ 下被 Profile 的 `builtin:` 清单引用的目录。
#   与安装包同一份清单（`packaging/builtin-payload.mjs --json`），**不在这里手抄目录名**。
#   runtimeOnly 里的 `packs/subagents/tools`（worker 的 code 工具）也一起带；少了它们，
#   这份源码构建出来的包装角色仍会 source-missing（= AGPL 的"对应源码"不完整）。
$BuiltinIncludePaths = @($builtinManifest.sources | ForEach-Object { $_.dir }) + @($builtinManifest.runtimeOnly)
foreach ($rel in $BuiltinIncludePaths) {
  if ($IncludePaths -notcontains $rel) { $IncludePaths += $rel }
}

# ② 排除规则：**普通源码目录**与**内置包来源目录**用两套。
#   内置包来源是 Profile 清单按 sha256 钉住的运行期资产（例如某个 vendored skill 自带
#   `dist\`、某个设计技能自带 `data\`），取舍必须与安装包一致：只排"包里一定没有、或会被
#   兜底过滤删掉"的那几类；`dist\`/`build\`/`tmp\`/`data\` 这些名字在内置技能里可能是**内容的
#   一部分**，删了 hash 就对不上（下面第 2 步的自检会当场抓住）。
#   普通源码目录（src/tools/packaging/…）仍按原来的"构建产物/临时物"口径排。
$ExcludeDirs = @('.git', 'node_modules', 'dist', 'build', '.dart_tool', '.idea', '.vscode', 'coverage', 'ephemeral', '__pycache__',
  'tmp', '_build', 'dist-release', '.bench-tmp', '_scratch')
$ExcludeFiles = @('*.log', '*.zip', '*.7z', '*.exe', '*.dll', '*.pdb', '*.pyc', '*.pyo', '.env', '.installed.json', '.DS_Store', 'Thumbs.db')
# 内置来源的排除集 = 安装包第 11 步"全包兜底过滤"的同一批名字（保证归档副本与包内副本同形）。
$BuiltinExcludeDirs = @('.git', 'node_modules', '__pycache__', '.venv', 'venv')
$BuiltinExcludeFiles = @('*.log', '*.pyc', '*.pyo', '*.pdb', '*.map', '.env', '.installed.json', '.DS_Store', 'Thumbs.db')

function Test-BuiltinPayloadRelPath([string]$Rel) {
  foreach ($builtin in $BuiltinIncludePaths) {
    if ($Rel -eq $builtin -or $Rel.StartsWith($builtin + '/') -or $Rel.StartsWith($builtin + '\')) { return $true }
  }
  return $false
}

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

Write-Host "=== 1/6 拷贝源码（不跟随 .git / 构建产物）"
foreach ($rel in $IncludePaths) {
  $src = Join-Path $Repo $rel
  if (-not (Test-Path $src)) { Write-Host "  跳过（不存在）：$rel"; continue }
  $dst = Join-Path $Payload $rel
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
  if ((Get-Item $src).PSIsContainer) {
    # 内置来源与普通源码目录用不同排除集（见上面 ② 的注释）：内置来源要跟安装包同形。
    $isBuiltinPayload = $BuiltinIncludePaths -contains $rel
    $dirExcludes = if ($isBuiltinPayload) { $BuiltinExcludeDirs } else { $ExcludeDirs }
    $fileExcludes = if ($isBuiltinPayload) { $BuiltinExcludeFiles } else { $ExcludeFiles }
    $robocopyArgs = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD') + $dirExcludes + @('/XF') + $fileExcludes
    & robocopy @robocopyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "robocopy 失败：$rel（exit=$LASTEXITCODE）" }
  } else {
    Copy-Item -LiteralPath $src -Destination $dst -Force
  }
}

Write-Host "=== 2/6 内置包来源自检（与安装包同一支 packaging\builtin-payload.mjs）"
# 逐个内置来源按 Profile 里钉的 sha256 核对归档内副本。这一步同时挡住两种事故：
#   ① 归档漏了某个 packs\ / skills\ 目录 ⇒ 构建出来的包 source-missing；
#   ② 复制/排除规则改了包内内容（例如误删了技能的数据资产）⇒ source-hash-mismatch。
# 判据与装配/拆包复验完全相同，不在这里另写一套（另写的那套一漂移，源码归档就"看着齐全"）。
$payloadCheck = Invoke-BuiltinPayload @('--check', '--repo', $Repo, '--pkg', $Payload)
if ($payloadCheck.code -ne 0) {
  $payloadCheck.lines | ForEach-Object { Write-Host "  $_" }
  Fail "源码归档缺内置包来源、或 hash 与 Profile 清单不一致（builtin-payload --check exit=$($payloadCheck.code)）：拿这份源码构建仍会 source-missing / source-hash-mismatch。上面逐条列着缺什么。"
}
# 与安装包同一口径：归档里不许出现仓库现场的临时/构建产物与"dist 双路径"副本。
$ForbiddenArchiveDirs = @('.git', 'node_modules', 'tmp', '_build', 'dist-release', '.bench-tmp', '_scratch')
$badDirs = @(Get-ChildItem -LiteralPath $Payload -Recurse -Directory -Force -ErrorAction SilentlyContinue |
  Where-Object { $ForbiddenArchiveDirs -contains $_.Name } |
  Where-Object {
    # 内置来源目录是 Profile 清单按 sha256 钉住的内容：哪怕里面有个目录叫 tmp\，那也是内容本身，
    # 不是"仓库现场的临时物"（它会被 hash 校验兜住，不该在这里误报）。
    $rel = $_.FullName.Substring($Payload.Length).TrimStart('\', '/').Replace('\', '/')
    -not (Test-BuiltinPayloadRelPath $rel)
  })
if ($badDirs.Count -gt 0) {
  $badRel = @($badDirs | ForEach-Object { $_.FullName.Substring($Payload.Length).TrimStart('\', '/') })
  Fail "源码归档里出现不该外发的目录：$($badRel -join '、')（仓库现场的临时/构建产物不该进源码归档）"
}
if (Test-Path -LiteralPath (Join-Path $Payload 'dist\packs')) {
  Fail '源码归档里出现 dist\packs\：内置资源只允许放在应用根 packs\（同一份资源只该有一个根）'
}
Write-Host ("  内置包来源：{0} 个 builtin: 来源 + {1} 个运行时目录，hash 与 Profile 清单一致" -f $builtinManifest.sources.Count, $builtinManifest.runtimeOnly.Count)

Write-Host "=== 3/6 补齐 gui 的构建必需文件（Flutter 工程壳）"
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

Write-Host "=== 4/6 脱敏（只改归档副本：先 dry-run 报表，再按共享规则表 apply；工作树不动）"
# 为什么需要"脱敏后归档"而不是裁掉 test/tools、也不是按需给源码：
#   源码归档要完整（AGPL 的"对应源码"得能构建/安装/运行那个二进制），但内部 test/tools 里
#   确实有私有词（人格名/本机路径/私有工具痕迹）与几个"像密钥"的夹具。做法与公开副本身份
#   一致：**只对输出副本按规则替换**，然后由第 5 步的闸门与密钥扫描独立复扫（目标 0 命中）。
#   规则表与 publish-oss 共用 tools/sanitize-rules.mjs（不在这里抄第二份）。
$Sanitizer = Join-Path $PSScriptRoot 'sanitize-archive.mjs'
if (-not (Test-Path -LiteralPath $Sanitizer)) { Fail "找不到源码归档脱敏脚本：$Sanitizer" }
# 内置包来源按 sha256 钉死（安装角色时 runtime 要逐目录验 hash），**不许**脱敏改动——
# 用 --skip-prefix 把它们从脱敏面里划出去（下面 apply 之后再跑一次 --check 兜底）。
$protectArgs = @()
foreach ($rel in $BuiltinIncludePaths) { $protectArgs += @('--skip-prefix', $rel) }
$dryArgs = @($Sanitizer, '--root', $Payload, '--dry-run') + $protectArgs
$dryLines = @(& $NodeExe @dryArgs 2>&1)
$dryCode = $LASTEXITCODE
foreach ($line in $dryLines) { Write-Host "  $line" }
if ($dryCode -ne 0) { Fail "脱敏 dry-run 失败（exit=$dryCode）：判据没法应用，不出归档。" }
$sanitizeReportTmp = Join-Path $Stage 'sanitize-report.json'
$applyArgs = @($Sanitizer, '--root', $Payload, '--apply', '--report', $sanitizeReportTmp) + $protectArgs
$applyLines = @(& $NodeExe @applyArgs 2>&1)
$applyCode = $LASTEXITCODE
foreach ($line in $applyLines) { Write-Host "  $line" }
if ($applyCode -ne 0) {
  Fail "脱敏后仍有残留命中（exit=$applyCode）：**不产出 zip**（fail-closed）。看上面规则/文件清单（报表不含敏感值），补规则或查清来源。"
}
# 脱敏是否误伤了内置包来源（改了 hash 会 source-hash-mismatch）：再核一遍。
$postSanitize = Invoke-BuiltinPayload @('--check', '--repo', $Repo, '--pkg', $Payload)
if ($postSanitize.code -ne 0) {
  $postSanitize.lines | ForEach-Object { Write-Host "  $_" }
  Fail "脱敏改动了内置包来源（builtin-payload --check exit=$($postSanitize.code)）：归档构建出来的角色包会 hash 不符。"
}
Write-Host '  内置包来源未被脱敏改动（hash 复核通过）'

Write-Host "=== 5/6 脱敏闸门（复用出包闸门的私有词表，别自造宽正则）"
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
Write-Host "  疑似密钥：无命中（精确夹具例外见 sanitize-report 的 aws-doc-example-key；全局形态扫描未放宽）"

Write-Host "=== 6/6 打包"
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

# 脱敏报表跟 zip 放在一起交付：命中文件/规则/次数（**不含具体敏感值**），供发行说明与复核引用。
$sanitizeReport = Join-Path $OutDir ($zipName -replace '\.zip$', '.sanitize-report.json')
Copy-Item -LiteralPath $sanitizeReportTmp -Destination $sanitizeReport -Force
$reportData = Get-Content -LiteralPath $sanitizeReport -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host ("  脱敏报表：{0}（命中 {1} 处 / {2} 个文件；受保护跳过 {3} 个文件）" -f `
  $sanitizeReport, $reportData.totalHits, $reportData.filesChanged, $reportData.protectedSkipped)

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
  if ($KeepStage) {
    Write-Host ("  -KeepStage：暂存目录保留在：{0}" -f $resolvedStage)
  } else {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Get-Variable pendingZip -ErrorAction SilentlyContinue) {
    if (Test-Path -LiteralPath $pendingZip) { Remove-Item -LiteralPath $pendingZip -Force }
  }
}
