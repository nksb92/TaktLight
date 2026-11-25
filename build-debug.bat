@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo  TaktLight - Debug Build (Standalone Debug EXE)
echo ==================================================

if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm install || goto :error
)

call npm run tauri -- build --debug --no-bundle || goto :error

echo.
echo ==================================================
echo  Debug build complete!
echo  Debug EXE (embedded UI + console + DevTools):
echo    target\debug\taktlight-app.exe
echo ==================================================
exit /b 0

:error
echo.
echo Debug build failed with exit code %ERRORLEVEL%.
exit /b %ERRORLEVEL%
