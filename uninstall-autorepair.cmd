@echo off
setlocal

rem Remove the logon launcher that install-autorepair.cmd dropped into the
rem Startup folder. Only that one file -- the overlay patch itself is left
rem alone (use "node apply.js --revert" for that).
rem
rem NOTE: keep this file ASCII-only, same reason as install-autorepair.cmd --
rem cmd.exe parses batch files with the console codepage, and UTF-8 Chinese
rem text gets mis-decoded badly enough to split lines into bogus commands.

set "STUB=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claude-code-usage-overlay-autorepair.vbs"

echo.
echo   Claude Code usage overlay - uninstall logon auto-repair
echo.

if not exist "%STUB%" (
  echo   Not installed ^(no launcher in the Startup folder^).
  echo.
  pause
  exit /b 0
)

del "%STUB%"

if exist "%STUB%" (
  echo   Delete failed -- the file may be locked. Remove it by hand:
  echo     %STUB%
) else (
  echo   Uninstalled. The patch will no longer be re-applied automatically.
  echo   The overlay itself is untouched -- to remove that, run:
  echo     node apply.js --revert
)

echo.
pause
