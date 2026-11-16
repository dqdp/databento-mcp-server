@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-ChatGPT.ps1"
set "install_result=%errorlevel%"
pause
exit /b %install_result%
