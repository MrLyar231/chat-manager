@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
start "Chat Server" cmd /k "cd /d "%~dp0server" && npm run dev"
start "Chat Client" cmd /k "cd /d "%~dp0client" && npm run dev"
echo Server: http://localhost:3000
echo Client: http://localhost:5173
