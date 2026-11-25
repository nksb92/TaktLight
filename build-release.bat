@echo off
setlocal
cd /d "%~dp0"

echo ==================================================
echo  TaktLight - Release Build (EXE + NSIS Installer)
echo ==================================================

if not exist "node_modules" (
    echo Installing npm dependencies...
    call npm install || goto :error
)

echo Syncing release version (YYYY.M.D)...
call node scripts/sync-version.mjs %* || goto :error

call npm run tauri -- build || goto :error

echo Generating SHA256SUMS.txt...
powershell -NoProfile -Command "$out = 'target\release\bundle\nsis\SHA256SUMS.txt'; $files = @(Get-ChildItem 'target\release\bundle\nsis\TaktLight_*_x64-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1; Get-Item 'target\release\taktlight-app.exe'); $lines = foreach ($f in $files) { $h = (Get-FileHash -Algorithm SHA256 -Path $f.FullName).Hash.ToLower(); \"$h  $($f.Name)\" }; Set-Content -Path $out -Value $lines -Encoding ascii" || goto :error

echo.
echo ==================================================
echo  Release build complete!
echo  Standalone EXE : target\release\taktlight-app.exe
echo  NSIS Installer : target\release\bundle\nsis\
echo  Checksums      : target\release\bundle\nsis\SHA256SUMS.txt
echo ==================================================
exit /b 0

:error
echo.
echo Release build failed with exit code %ERRORLEVEL%.
exit /b %ERRORLEVEL%
