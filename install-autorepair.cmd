@echo off
setlocal

rem Drop a one-line launcher into the Startup folder so the overlay patch gets
rem re-applied at every logon.
rem
rem Why not a scheduled task: schtasks /sc onlogon requires elevation (a plain
rem /sc once does not -- it is specifically the onlogon trigger that does).
rem The Startup folder has the same "runs at logon" semantics, needs no
rem elevation, and uninstalling it is deleting one file.
rem
rem Items in the Startup folder are executed by extension association, and .vbs
rem goes to wscript.exe -- a GUI host, so no console window flashes.
rem
rem NOTE: keep this file ASCII-only. cmd.exe parses batch files using the
rem console codepage, and on a Chinese Windows install UTF-8 Chinese text gets
rem mis-decoded badly enough to split lines into bogus commands. (chcp 65001
rem does not help -- parsing happens with the codepage active at read time.)

set "HERE=%~dp0"
set "STUB=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claude-code-usage-overlay-autorepair.vbs"

echo.
echo   Claude Code usage overlay - install logon auto-repair
echo.

if not exist "%HERE%autorepair.vbs" (
  echo   autorepair.vbs not found.
  echo   This script must sit in the same folder as autorepair.vbs.
  echo.
  pause
  exit /b 1
)

rem The generated one-liner: run wscript with the real autorepair.vbs, hidden
rem window (0), do not wait (False).
rem Keep this OUTSIDE any if-block -- the parentheses in the text would break
rem cmd's if(...) parsing.
> "%STUB%" echo CreateObject("WScript.Shell").Run "wscript.exe //B //Nologo ""%HERE%autorepair.vbs""", 0, False

if not exist "%STUB%" (
  echo   Failed to write: %STUB%
  echo.
  pause
  exit /b 1
)

echo   Installed. The patch gets re-applied at every logon.
echo.
echo   Launcher (Startup folder):
echo     %STUB%
echo.
echo   Output and errors are logged to:
echo     %HERE%autorepair.log
echo.
echo   To try it right now instead of waiting for the next logon:
echo     cscript //B "%HERE%autorepair.vbs"
echo.
echo   To undo: double-click uninstall-autorepair.cmd
echo.
pause
