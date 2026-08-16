# 바탕화면 옆에 세워 두는 위젯 창.
#
# 서버를 띄우고, 크롬을 앱 모드(주소창·탭 없음)로 열어 화면 오른쪽 끝에 붙인다.
# 새로 설치할 것이 없다. Electron이나 Tauri로 감싸면 창은 더 예뻐지지만
# node_modules와 빌드 단계가 생기고, 그러면 "받아서 node 한 줄"이라는 이 도구의
# 성격이 사라진다.
#
#   powershell -ExecutionPolicy Bypass -File widget.ps1
#   powershell -ExecutionPolicy Bypass -File widget.ps1 -Width 520 -OnTop
#
# -OnTop을 주면 다른 창 위에 항상 뜬다. 안 주면 평범한 창이다.
#
# 참고: 이건 '창'이지 바탕화면에 박히는 위젯이 아니다. 벽지 위·다른 창 아래에
# 진짜로 얹으려면 Rainmeter 같은 도구가 필요하다. README에 적어 두었다.

param(
  [int]$Port = 4317,
  [int]$Width = 460,
  [switch]$OnTop,
  [ValidateSet('right', 'left')][string]$Side = 'right'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
"@

# 위젯 창을 찾는다.
#
# 제목으로 찾으면 안 된다. 브라우저 탭에서 이 페이지를 열어 두면 그 창 제목도
# 'claude-agent-watch - Chrome'이 되어, 웹에서 위젯으로 전환할 때 그 탭을
# 위젯으로 착각하고 아무것도 안 열린다.
#
# 명령줄로 찾는다. 위젯 창만 --app= 과 전용 프로필을 함께 갖는다.
function Find-WidgetWindow {
  $profileMark = 'claude-agent-watchrowser-profile'
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profileMark*" -and $_.CommandLine -like '*--app=*' }
  foreach ($p in $procs) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) { return $proc }
  }
  return $null
}

# 버튼을 다시 눌렀을 때 창이 하나 더 생기면 안 된다. 있으면 앞으로 꺼낸다.
$existing = Find-WidgetWindow
if ($existing) {
  [Win]::ShowWindow($existing.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
  [Win]::SetForegroundWindow($existing.MainWindowHandle) | Out-Null
  Write-Host "이미 열려 있는 창을 앞으로 꺼냈다."
  exit 0
}

# ── 서버 ──────────────────────────────────────────────────
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "서버가 이미 $Port 에서 돌고 있다."
} else {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw "node를 찾지 못했다. Node 18 이상이 필요하다." }
  $env:PORT = "$Port"
  Start-Process -FilePath $node -ArgumentList 'server/index.mjs' `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput "$root\out.log" -RedirectStandardError "$root\err.log"

  $ok = $false
  foreach ($i in 1..40) {
    try { Invoke-WebRequest "http://127.0.0.1:$Port/api/sessions" -UseBasicParsing -TimeoutSec 3 | Out-Null; $ok = $true; break }
    catch { Start-Sleep -Milliseconds 400 }
  }
  if (-not $ok) { Get-Content "$root\err.log" -Tail 20; throw "서버가 안 떴다." }
  Write-Host "서버 기동: http://127.0.0.1:$Port"
}

# ── 창 위치 ───────────────────────────────────────────────
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.Screen]::AllScreens | Where-Object { $_.Primary } | Select-Object -First 1
if (-not $screen) { $screen = [System.Windows.Forms.Screen]::AllScreens[0] }
$area = $screen.WorkingArea

$x = if ($Side -eq 'right') { $area.X + $area.Width - $Width } else { $area.X }
$y = $area.Y
$h = $area.Height

# ── 크롬 ──────────────────────────────────────────────────
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Host "크롬이나 엣지를 못 찾았다. 브라우저에서 직접 열어라: http://127.0.0.1:$Port"
  exit 0
}

# 프로필을 따로 둔다. 평소 쓰는 크롬 창들과 섞이면 위젯 창만 골라 닫기가
# 번거롭고, 확장 프로그램이 알림 권한을 건드릴 수도 있다.
$profile = Join-Path $env:LOCALAPPDATA 'claude-agent-watch\browser-profile'
New-Item -ItemType Directory -Force -Path $profile | Out-Null

$args = @(
  "--app=http://127.0.0.1:$Port/?widget=1",
  "--user-data-dir=$profile",
  "--window-position=$x,$y",
  "--window-size=$Width,$h",
  '--no-first-run',
  '--no-default-browser-check'
)
$proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
Write-Host "위젯 창 열림 ($Side, 폭 $Width)"

# ── 항상 위 ───────────────────────────────────────────────
if ($OnTop) {
  # 창이 만들어질 때까지 잠깐 기다린다. 바로 잡으면 핸들이 아직 없다.
  $hwnd = [IntPtr]::Zero
  foreach ($i in 1..30) {
    Start-Sleep -Milliseconds 300
    $w = Find-WidgetWindow
    if ($w) { $hwnd = $w.MainWindowHandle; break }
  }
  if ($hwnd -ne [IntPtr]::Zero) {
    # HWND_TOPMOST = -1, SWP_NOMOVE|SWP_NOSIZE = 0x0003
    [Win]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0003) | Out-Null
    Write-Host "항상 위로 고정됨"
  } else {
    Write-Host "창 핸들을 못 찾아 항상 위 설정을 건너뛴다."
  }
}
