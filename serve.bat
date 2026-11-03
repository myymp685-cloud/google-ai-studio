@echo off
cd /d "%~dp0"
title dino-motion http server :8123
"C:\Users\Dirge\AppData\Local\Programs\Python\Python312\python.exe" -m http.server 8123
pause
