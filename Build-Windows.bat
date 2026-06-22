@echo off
setlocal EnableExtensions

echo.
echo ============================================================
echo   PaperHub - Windows Build
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. Install Node.js 20 or later first.
    pause
    exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] pnpm was not found. Run: corepack enable
    pause
    exit /b 1
)

echo [INFO] Installing dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
)

echo.
echo [INFO] Building Windows installer and portable executable...
call pnpm desktop:build
if errorlevel 1 (
    echo [ERROR] Windows build failed.
    pause
    exit /b 1
)

echo.
echo ============================================================
echo   [PASS] Build complete.
echo.
echo   Installer:
echo     dist-desktop\PaperHub-0.1.2-setup-x64.exe
echo.
echo   Portable:
echo     dist-desktop\PaperHub-0.1.2-portable-x64.exe
echo ============================================================
echo.
pause
