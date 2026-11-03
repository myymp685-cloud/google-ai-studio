@echo off
chcp 65001 >nul
title 体感小恐龙 - 公网隧道
cd /d "D:\google ai studio\dino-motion"

echo [1/2] 检查本地服务 (127.0.0.1:8123) ...
netstat -ano | findstr "127.0.0.1:8123" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo       未运行, 正在启动本地服务...
    start "dino-server" /min python -m http.server 8123 --bind 127.0.0.1
    timeout /t 2 /nobreak >nul
) else (
    echo       本地服务已在运行, 跳过。
)

echo.
echo [2/2] 启动 cpolar 隧道... 公网地址看下方 Forwarding 行, 或打开 http://127.0.0.1:4042
echo       (关闭本窗口 = 断开隧道; 最小化的 dino-server 窗口是本地服务)
echo.
"C:\Program Files\cpolar\cpolar.exe" http 8123
