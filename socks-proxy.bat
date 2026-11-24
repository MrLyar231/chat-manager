@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
echo ============================================================
echo   SOCKS5 proxy for Telegram on phone
echo   PC IP: 192.168.1.10   Port: 1080
echo   Keep Cloudflare WARP connected!
echo ============================================================
node socks-proxy.js
pause
