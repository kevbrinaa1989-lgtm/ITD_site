@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
node storage-cli.mjs bind
set "itd_exit=%errorlevel%"
echo.
pause
exit /b %itd_exit%
