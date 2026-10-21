param(
  [Parameter(Mandatory=$true)][string[]]$Urls,
  [int]$MaxLen = 24000
)
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
foreach ($u in $Urls) {
  try {
    $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 45
    $c = $r.Content
    $i = $c.IndexOf('theme-default-content')
    if ($i -lt 0) { "===== $u`n[NO CONTENT MARKER]`n"; continue }
    $body = $c.Substring($i)
    # cut at the page footer / edit link / last-updated
    $end = $body.IndexOf('page-edit')
    if ($end -gt 0) { $body = $body.Substring(0, $end) }
    $end2 = $body.IndexOf('page-nav')
    if ($end2 -gt 0) { $body = $body.Substring(0, $end2) }
    $t = $body
    $t = $t -replace '(?s)<script.*?</script>',''
    $t = $t -replace '(?s)<style.*?</style>',''
    $t = $t -replace '<h1[^>]*>',"`n# "
    $t = $t -replace '<h2[^>]*>',"`n## "
    $t = $t -replace '<h3[^>]*>',"`n### "
    $t = $t -replace '<h4[^>]*>',"`n#### "
    $t = $t -replace '</h[1-6]>',"`n"
    $t = $t -replace '</t[dh]>',' | '
    $t = $t -replace '</tr>',"`n"
    $t = $t -replace '<br\s*/?>',"`n"
    $t = $t -replace '</p>',"`n"
    $t = $t -replace '</li>',"`n"
    $t = $t -replace '<li[^>]*>','- '
    $t = $t -replace '<pre[^>]*>',("`n" + '```')
    $t = $t -replace '</pre>',("`n" + '```')
    $t = $t -replace '</div>',"`n"
    $t = $t -replace '<[^>]+>',''
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    $t = $t -replace '[ \t]+', ' '
    $t = $t -replace '(\r?\n\s*){3,}', "`n`n"
    if ($t.Length -gt $MaxLen) { $t = $t.Substring(0,$MaxLen) + "`n[[TRUNCATED]]" }
    "===== $u`n$($t.Trim())`n"
  } catch {
    "===== $u`n[FETCH ERROR] $($_.Exception.Message)`n"
  }
}
