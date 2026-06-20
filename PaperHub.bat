@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: ============================================================
:: PaperHub Quick Launch Script
:: Launches the packaged Electron app and waits for the API.
:: ============================================================

:: --- Environment ---
set "NODE_OPTIONS="
set "EMBEDDING_PROVIDER=ollama"
set "OLLAMA_BASE_URL=http://127.0.0.1:11434"
set "OLLAMA_EMBEDDING_MODEL=qwen3-embedding:0.6b"
set "EMBEDDING_TIMEOUT_MS=30000"
set "EMBEDDING_BATCH_SIZE=8"
set "EMBEDDING_KEEP_ALIVE=5m"
set "EMBEDDING_TRUNCATE=true"
set "EMBEDDING_MAX_INPUT_CHARS=24000"

:: --- Paths ---
set "API_PORT=3000"
set "HEALTH_URL=http://127.0.0.1:%API_PORT%/health"

:: --- Header ---
echo.
echo ============================================================
echo   PaperHub - Quick Launch
echo ============================================================

:: Priority: newest portable single exe > win-unpacked
set "APP_EXE="
if "!APP_EXE!"=="" (
    for /f "delims=" %%f in ('dir /b /a-d /o-d "%~dp0dist-desktop\PaperHub-*-portable-x64.exe" 2^>nul') do (
        if "!APP_EXE!"=="" set "APP_EXE=%~dp0dist-desktop\%%f"
    )
)
if "!APP_EXE!"=="" (
    for /f "delims=" %%f in ('dir /b /a-d /o-d "%~dp0PaperHub-*-portable-x64.exe" 2^>nul') do (
        if "!APP_EXE!"=="" set "APP_EXE=%~dp0%%f"
    )
)
if "!APP_EXE!"=="" if exist "%~dp0dist-desktop\win-unpacked\PaperHub.exe" (
    set "APP_EXE=%~dp0dist-desktop\win-unpacked\PaperHub.exe"
)
if "!APP_EXE!"=="" if exist "%~dp0win-unpacked\PaperHub.exe" (
    set "APP_EXE=%~dp0win-unpacked\PaperHub.exe"
)

echo   EXE : !APP_EXE!
echo   API : %HEALTH_URL%
echo ============================================================
echo.

:: --- Validate ---
if "!APP_EXE!"=="" (
    echo [ERROR] PaperHub.exe was not found in any of these locations:
    echo   - dist-desktop\PaperHub-*-portable-x64.exe
    echo   - dist-desktop\win-unpacked\PaperHub.exe
    echo   - win-unpacked\PaperHub.exe
    echo.
    echo   Please run: node scripts/build-desktop.mjs
    echo.
    pause
    exit /b 1
)

:: --- Kill any existing PaperHub / port-3000 process ---
echo [INFO] Checking for existing PaperHub processes...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$pids = (Get-NetTCPConnection -LocalPort %API_PORT% -State Listen -ErrorAction SilentlyContinue).OwningProcess;" ^
    "if ($pids) {" ^
    "  foreach ($p in $pids) {" ^
    "    try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host \"[INFO] Killed process $p occupying port %API_PORT%\" } catch {}" ^
    "  };" ^
    "  Start-Sleep -Seconds 1" ^
    "} else { Write-Host '[INFO] Port %API_PORT% is free.' }"

:: Also kill stale PaperHub.exe processes (but not this script's parent)
taskkill /IM PaperHub.exe /F >nul 2>&1
if not errorlevel 1 (
    echo [INFO] Stopped previous PaperHub instance.
    timeout /t 2 /nobreak >nul
)

:: --- Launch ---
echo [INFO] Starting PaperHub...
start "" "!APP_EXE!"
if errorlevel 1 (
    echo [ERROR] Failed to launch PaperHub.exe.
    pause
    exit /b 1
)

:: --- Health Check ---
echo [INFO] Waiting for the local API ^(max 90s^)...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$deadline=(Get-Date).AddSeconds(90);" ^
    "do {" ^
    "  try {" ^
    "    $response=Invoke-WebRequest -UseBasicParsing -Uri '%HEALTH_URL%' -TimeoutSec 2;" ^
    "    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { exit 0 }" ^
    "  } catch {};" ^
    "  Start-Sleep -Milliseconds 500" ^
    "} while ((Get-Date) -lt $deadline);" ^
    "exit 1"

if errorlevel 1 (
    echo.
    echo [FAIL] Health check did not pass within 90 seconds.
    echo        URL: %HEALTH_URL%
    echo.
    echo   Possible causes:
    echo     1. Ollama is not running  ^(start Ollama first^)
    echo     2. Port %API_PORT% is blocked by firewall
    echo     3. Check log: %%USERPROFILE%%\PaperHub\logs\app.log
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   [PASS] PaperHub is ready!
echo   Health : %HEALTH_URL%
echo ============================================================
echo.
timeout /t 3 /nobreak >nul
exit /b 0
