@echo off
rem Double-click to start AV Courier from this folder (no terminal needed).
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo First start: installing what AV Courier needs. This takes a minute...
  call npm install --no-audit --no-fund || (echo Install failed. Is Node.js installed? & pause & exit /b 1)
)
rem npm may skip Electron's own download step; fetch it directly if so.
if not exist "node_modules\electron\dist\electron.exe" (
  call node "node_modules\electron\install.js" || (echo Could not download Electron. Check the internet connection. & pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" .
