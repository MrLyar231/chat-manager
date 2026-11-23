@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0server"
start "Chat Server" cmd /k "node index.js"
timeout /t 2 >nul
echo ============================================================
echo   Chat Manager + Cloudflare Tunnel
echo   Skopiruyte https://....trycloudflare.com adres nizhe
echo   i otprayte ego lyudyam - oni smogut pisat iz lyubogo mesta
echo   Esli okno zakryt - tunnel i chat ostanovyatsya
echo ============================================================
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
pause
