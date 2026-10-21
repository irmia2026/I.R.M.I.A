param(
  # 抓取落点：默认 <仓库根>\qqbot-cache（相对本脚本推导，不写死机器路径）
  [string]$Out = ''
)
$ProgressPreference='SilentlyContinue'
if ($Out -eq '') {
  $repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  $Out = Join-Path $repo 'qqbot-cache'
}
$out = $Out
New-Item -ItemType Directory -Force -Path $out | Out-Null
$sm = [regex]::Matches((Invoke-WebRequest -Uri 'https://bot.q.qq.com/wiki/sitemap.xml' -UseBasicParsing -TimeoutSec 60).Content,'<loc>(.*?)</loc>') | ForEach-Object { $_.Groups[1].Value }
$targets = $sm | Where-Object { $_ -match '/wiki/' } | Sort-Object -Unique
$i = 0
foreach ($u in $targets) {
  $i++
  $name = ($u -replace 'https://bot.q.qq.com/wiki/','') -replace '[\\/:*?"<>|]','_'
  if ($name -eq '') { $name = 'index' }
  if (-not $name.EndsWith('.html')) { $name = $name + '.html' }
  $path = Join-Path $out $name
  if (Test-Path $path) { continue }
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 45
    $c = $r.Content
    $j = $c.IndexOf('theme-default-content')
    if ($j -ge 0) { $c = $c.Substring($j) }
    [IO.File]::WriteAllText($path, $c, [Text.Encoding]::UTF8)
    Write-Output "[$i/$($targets.Count)] OK $u"
  } catch {
    Write-Output "[$i/$($targets.Count)] FAIL $u :: $($_.Exception.Message)"
  }
}
Write-Output "DONE total=$($targets.Count)"
