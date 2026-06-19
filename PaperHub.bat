@echo off
setlocal EnableExtensions

set "NODE_OPTIONS="
set "APP_EXE=%~dp0dist-desktop\win-unpacked\PaperHub.exe"
set "HEALTH_URL=http://127.0.0.1:3000/health"

if not exist "%APP_EXE%" set "APP_EXE=%~dp0win-unpacked\PaperHub.exe"

echo [PaperHub] Local launch test
echo [PaperHub] EXE: "%APP_EXE%"

if not exist "%APP_EXE%" (
  echo [PaperHub] ERROR: Local executable was not found.
  echo [PaperHub] Run pnpm desktop:build first.
  pause
  exit /b 1
)

start "" "%APP_EXE%"
if errorlevel 1 (
  echo [PaperHub] ERROR: Failed to launch PaperHub.exe.
  pause
  exit /b 1
)

echo [PaperHub] Waiting for the local API...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(60); do { try { $response=Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 } } catch {}; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $deadline); exit 1"

if errorlevel 1 (
  echo [PaperHub] FAILED: Health check did not pass within 60 seconds.
  echo [PaperHub] URL: %HEALTH_URL%
  pause
  exit /b 1
)

echo [PaperHub] PASS: Desktop window and local API are ready.
echo [PaperHub] Health: %HEALTH_URL%
timeout /t 3 /nobreak >nul
exit /b 0
