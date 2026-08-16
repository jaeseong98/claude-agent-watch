# 바탕화면(과 원하면 시작 프로그램)에 바로가기를 만든다.
#
#   powershell -ExecutionPolicy Bypass -File install-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -Startup -OnTop
#   powershell -ExecutionPolicy Bypass -File install-shortcut.ps1 -Remove

param(
  [switch]$Startup,
  [switch]$OnTop,
  [int]$Width = 460,
  [ValidateSet('right', 'left')][string]$Side = 'right',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$name = '에이전트 관측.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) $name
$startupDir = [Environment]::GetFolderPath('Startup')
$startupLnk = Join-Path $startupDir $name

if ($Remove) {
  foreach ($p in @($desktop, $startupLnk)) {
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host "지움: $p" }
  }
  exit 0
}

# powershell.exe를 직접 부른다. widget.cmd를 거치면 콘솔 창이 한 번 번쩍인다.
$argLine = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\widget.ps1`" -Width $Width -Side $Side"
if ($OnTop) { $argLine += ' -OnTop' }

# 아이콘. 크롬 아이콘을 쓰면 평범한 크롬 창과 헷갈리므로 시스템 아이콘에서
# 모니터 모양을 가져온다.
$icon = "$env:SystemRoot\System32\imageres.dll,109"

function New-Shortcut($path) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = $argLine
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = $icon
  $lnk.Description = 'Claude Code 세션 관측 위젯'
  $lnk.WindowStyle = 7   # 최소화로 시작. 콘솔이 뜰 일이 없다.
  $lnk.Save()
  Write-Host "만듦: $path"
}

New-Shortcut $desktop
if ($Startup) { New-Shortcut $startupLnk }

Write-Host ''
Write-Host '바탕화면의 "에이전트 관측"을 누르면 뜬다.'
Write-Host '이미 떠 있으면 그 창을 앞으로 꺼낸다.'
