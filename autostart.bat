@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0server"
start "Chat Server" /min cmd /k "node index.js"
timeout /t 2 >nul
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000 > "%~dp0tunnel.log" 2>&1
