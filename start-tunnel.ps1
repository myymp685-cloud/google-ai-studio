# start-tunnel.ps1 (v2 代理感知版) — 把本机 8123 的体感小恐龙通过 cloudflared 快速隧道暴露到公网(HTTPS)
# 用法:  powershell -ExecutionPolicy Bypass -File "D:\google ai studio\dino-motion\start-tunnel.ps1"
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = $PSScriptRoot
$port = 8123
$cfExe = Join-Path $root 'cloudflared.exe'

# --- [0] 探测本地代理端口(浏览器常用代理), 让下载与隧道都走它 ---
$proxyPort = $null
foreach ($p in 7890,7891,10809,10808,1080,8080,8118,2080,7892,7893) {
  if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { $proxyPort = $p; break }
}
$proxyUrl = $null
if ($proxyPort) {
  $proxyUrl = "http://127.0.0.1:$proxyPort"
  Write-Host "[0] 检测到本地代理 :$proxyPort -> $proxyUrl (下载与隧道都将走代理)" -ForegroundColor Cyan
  [Net.WebRequest]::DefaultWebProxy = New-Object Net.WebProxy($proxyUrl, $true)
  $env:HTTPS_PROXY = $proxyUrl
  $env:HTTP_PROXY  = $proxyUrl
  $env:https_proxy = $proxyUrl
  $env:http_proxy  = $proxyUrl
} else {
  Write-Host "[0] 未检测到常见本地代理端口, 尝试直连。" -ForegroundColor DarkGray
}

# --- [1] 确保本地静态服务在跑 ---
if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host "[1/3] 启动本地服务 http://127.0.0.1:$port ..." -ForegroundColor Cyan
  Start-Process python -ArgumentList '-m','http.server',$port,'--bind','127.0.0.1' -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Seconds 2
} else {
  Write-Host "[1/3] 本地服务已在 $port 端口运行, 跳过。" -ForegroundColor Green
}

# --- [2] 确保 cloudflared.exe (没有就下载, GitHub + 镜像回退) ---
if (-not (Test-Path $cfExe)) {
  $dl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
  $urls = @($dl,
            ("https://mirror.ghproxy.com/" + $dl),
            ("https://gh-proxy.com/" + $dl))
  $ok = $false
  foreach ($u in $urls) {
    Write-Host "[2/3] 尝试下载: $u" -ForegroundColor Cyan
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $cfExe -TimeoutSec 180
      if ((Test-Path $cfExe) -and (Get-Item $cfExe).Length -gt 1000000) { $ok = $true; Write-Host "      下载成功。" -ForegroundColor Green; break }
    } catch { Write-Host ("      失败: " + $_.Exception.Message) -ForegroundColor Yellow }
  }
  if (-not $ok) {
    Write-Host ''
    Write-Host '!! 自动下载失败 (PowerShell 无法连 GitHub, 且未检测到可用代理)。' -ForegroundColor Red
    Write-Host '   请用【浏览器】打开下面地址, 下载 cloudflared-windows-amd64.exe,' -ForegroundColor Red
    Write-Host '   改名为 cloudflared.exe 放进本目录, 再重新运行本脚本即可:' -ForegroundColor Red
    Write-Host '   https://github.com/cloudflare/cloudflared/releases/latest' -ForegroundColor Yellow
    exit 1
  }
} else {
  Write-Host "[2/3] 已存在 cloudflared.exe, 跳过下载。" -ForegroundColor Green
}

# --- [3] 建立快速隧道并抓取公网 URL ---
Write-Host "[3/3] 建立 cloudflared 快速隧道 (首次约需几秒)..." -ForegroundColor Cyan
$log  = Join-Path $env:TEMP 'cf-out.log'
$logE = Join-Path $env:TEMP 'cf-err.log'
Remove-Item $log,$logE -ErrorAction SilentlyContinue
$cf = Start-Process -FilePath $cfExe -ArgumentList @('tunnel','--url',"http://127.0.0.1:$port") -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError $logE

$publicUrl = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $txt = (@(Get-Content $log -ErrorAction SilentlyContinue) + @(Get-Content $logE -ErrorAction SilentlyContinue)) -join "`n"
  if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $publicUrl = $matches[0]; break }
}

if ($publicUrl) {
  Write-Host ''
  Write-Host '======================================================' -ForegroundColor Green
  Write-Host '  公网地址 (发给朋友/手机, 用各自摄像头玩):' -ForegroundColor Green
  Write-Host "  $publicUrl" -ForegroundColor Yellow
  Write-Host '  HTTPS 已就绪, 摄像头可直接用; 关闭本窗口即断开。' -ForegroundColor Green
  Write-Host '======================================================' -ForegroundColor Green
} else {
  Write-Host '!! 60 秒内未抓到公网地址, 下面是 cloudflared 原始日志:' -ForegroundColor Red
  Get-Content $log,$logE -ErrorAction SilentlyContinue
}

Write-Host '隧道运行中... 按 Ctrl+C 或关闭窗口结束。' -ForegroundColor DarkGray
try { Wait-Process -Id $cf.Id } finally { Stop-Process -Id $cf.Id -ErrorAction SilentlyContinue }