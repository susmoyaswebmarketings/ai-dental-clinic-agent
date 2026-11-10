@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
start "" http://localhost:3000
node server.js
pause
