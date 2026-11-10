@echo off
rem DaFeiYu desktop pet launcher
set ELECTRON_RUN_AS_NODE=
start "" "%~dp0electron\node_modules\electron\dist\electron.exe" "%~dp0electron"
