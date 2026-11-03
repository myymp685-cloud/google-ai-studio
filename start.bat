@echo off
title Dino Motion - Starting...
cd /d "%~dp0"
echo Starting HTTP server on port 8123...
start "" http://127.0.0.1:8123
echo.
echo Server running at http://127.0.0.1:8123
echo Press Ctrl+C to stop the server.
echo.
"C:\Users\Dirge\AppData\Local\Programs\Python\Python312\python.exe" -m http.server 8123
