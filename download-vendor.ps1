# download-vendor.ps1 — 把 dino-motion 的 CDN 依赖下载到本地 vendor/（离线/国内可用）
# 用法（在有网的终端、项目目录下）:  powershell -ExecutionPolicy Bypass -File .\download-vendor.ps1
# 主源用国内 npmmirror，失败回退 npmjs；模型/字体直连，失败会给出浏览器手动下载提示。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = $PSScriptRoot
$vendor = Join-Path $root 'vendor'
$tmp = Join-Path $env:TEMP ('dino-vendor-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $vendor, $tmp | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$results = New-Object System.Collections.ArrayList
function Record($name,$ok,$detail){ [void]$results.Add([pscustomobject]@{Name=$name;OK=$ok;Detail=$detail}) }
function Download-FirstOk([string[]]$urls,[string]$out){
  foreach($u in $urls){
    try{ Write-Host ('  尝试: '+$u); Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -TimeoutSec 180
         if((Test-Path $out) -and (Get-Item $out).Length -gt 0){ return $true } }
    catch{ Write-Host ('  失败: '+$_.Exception.Message) }
  }
  return $false
}
function Expand-Tgz([string]$tgz,[string]$dest){
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  & tar -xzf $tgz -C $dest 2>$null | Out-Null
  return (Join-Path $dest 'package')
}

Write-Host "`n[1/4] three@0.160.0 ..."
try{
  $t = Join-Path $tmp 'three.tgz'
  if(Download-FirstOk @('https://registry.npmmirror.com/three/-/three-0.160.0.tgz','https://registry.npmjs.org/three/-/three-0.160.0.tgz') $t){
    $pkg = Expand-Tgz $t (Join-Path $tmp 'three')
    New-Item -ItemType Directory -Force -Path (Join-Path $vendor 'three') | Out-Null
    Copy-Item (Join-Path $pkg 'build\three.module.js') (Join-Path $vendor 'three\three.module.js') -Force
    $d = Join-Path $vendor 'three\jsm'; if(Test-Path $d){ Remove-Item $d -Recurse -Force }
    Copy-Item (Join-Path $pkg 'examples\jsm') $d -Recurse -Force
    Record 'three (core+addons)' $true (((Get-Item (Join-Path $vendor 'three\three.module.js')).Length) -as [string])
  } else { Record 'three (core+addons)' $false '所有源下载失败' }
}catch{ Record 'three (core+addons)' $false $_.Exception.Message }

Write-Host "`n[2/4] @mediapipe/tasks-vision@0.10.14 ..."
try{
  $t = Join-Path $tmp 'tv.tgz'
  if(Download-FirstOk @('https://registry.npmmirror.com/@mediapipe/tasks-vision/-/tasks-vision-0.10.14.tgz','https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-0.10.14.tgz') $t){
    $pkg = Expand-Tgz $t (Join-Path $tmp 'mp')
    New-Item -ItemType Directory -Force -Path (Join-Path $vendor 'mediapipe') | Out-Null
    Copy-Item (Join-Path $pkg 'vision_bundle.mjs') (Join-Path $vendor 'mediapipe\vision_bundle.mjs') -Force
    $d = Join-Path $vendor 'mediapipe\wasm'; if(Test-Path $d){ Remove-Item $d -Recurse -Force }
    Copy-Item (Join-Path $pkg 'wasm') $d -Recurse -Force
    Record 'mediapipe (bundle+wasm)' $true (((Get-Item (Join-Path $vendor 'mediapipe\vision_bundle.mjs')).Length) -as [string])
  } else { Record 'mediapipe (bundle+wasm)' $false '所有源下载失败' }
}catch{ Record 'mediapipe (bundle+wasm)' $false $_.Exception.Message }

Write-Host "`n[3/4] pose 模型 ..."
try{
  New-Item -ItemType Directory -Force -Path (Join-Path $vendor 'models') | Out-Null
  $mo = Join-Path $vendor 'models\pose_landmarker_lite.task'
  if(Download-FirstOk @('https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task') $mo){
    Record 'pose 模型' $true (((Get-Item $mo).Length) -as [string])
  } else { Record 'pose 模型' $false '直连失败：用浏览器打开上方 URL 另存为到 vendor\models\pose_landmarker_lite.task' }
}catch{ Record 'pose 模型' $false $_.Exception.Message }

Write-Host "`n[4/4] 字体 Rajdhani（可选，失败不影响游戏）..."
try{
  $fd = Join-Path $vendor 'fonts'; New-Item -ItemType Directory -Force -Path $fd | Out-Null
  $css=$null
  foreach($u in @('https://fonts.loli.net/css2?family=Rajdhani:wght@500;600;700&display=swap','https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&display=swap')){
    try{ $c=(Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 60).Content; if($c){ $css=$c; Write-Host ('  css 来自: '+$u); break } }catch{ Write-Host ('  css 失败: '+$u) }
  }
  if($css){
    $urlMatches=[regex]::Matches($css,'url\(([^)]+)\)'); $map=@{}
    foreach($m in $urlMatches){ $raw=$m.Groups[1].Value.Trim().Trim('"').Trim("'"); if($raw.StartsWith('//')){$raw='https:'+$raw}
      if($raw -match '^https?://' -and -not $map.ContainsKey($raw)){ $fn=Split-Path $raw -Leaf; $dst=Join-Path $fd $fn
        try{ Invoke-WebRequest -Uri $raw -OutFile $dst -UseBasicParsing -TimeoutSec 60; $map[$raw]=$fn }catch{ Write-Host ('  字体文件失败: '+$raw) } } }
    foreach($k in $map.Keys){ $css=$css.Replace($k,$map[$k]) }
    [System.IO.File]::WriteAllText((Join-Path $fd 'rajdhani.css'), $css, $utf8NoBom)
    Record '字体 Rajdhani' $true ((($map.Count) -as [string])+' 个 woff2')
  } else { Record '字体 Rajdhani' $false 'css 获取失败（不影响游戏，回退系统字体）' }
}catch{ Record '字体 Rajdhani' $false $_.Exception.Message }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`n================ 结果汇总 ================"
foreach($r in $results){ $tag=if($r.OK){'[OK]  '}else{'[FAIL]'}; Write-Host ('{0} {1}  -  {2}' -f $tag,$r.Name,$r.Detail) }
$fail=@($results | Where-Object { -not $_.OK })
Write-Host ''
if($fail.Count -eq 0){ Write-Host '全部本地化成功！现在可断网 / 国内直接打开游戏。' } else { Write-Host ('有 {0} 项失败，见上方 [FAIL] 提示。' -f $fail.Count) }
Write-Host '按任意键退出...'
try{ [void][System.Console]::ReadKey($true) }catch{ Start-Sleep -Seconds 3 }
