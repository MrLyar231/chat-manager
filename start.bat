@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0server"
echo ============================================
echo   Chat Manager - production mode
echo   Open http://localhost:3000
echo ============================================
node index.js
pause
