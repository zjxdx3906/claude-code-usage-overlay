@echo off
setlocal
chcp 65001 >nul

REM ===================================================================
REM  把 DeepSeek 真实单价写进 Claude Code 的 managed-settings.json
REM  必须放在 C:\Program Files\ClaudeCode\ ，这是 Claude Code 在
REM  Windows 上唯一认的 managed settings 文件位置（管理员专属）。
REM
REM  用法：右键本文件 -> 以管理员身份运行
REM        install-managed-pricing.cmd remove    ← 卸载
REM ===================================================================

set "TARGET_DIR=C:\Program Files\ClaudeCode"
set "TARGET=%TARGET_DIR%\managed-settings.json"
set "SOURCE=%~dp0managed-settings.json"

REM ---- 提权检查 ----
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   需要管理员权限，正在请求提权...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList '%1'"
  exit /b
)

REM ---- 卸载 ----
if /i "%~1"=="remove" (
  if exist "%TARGET%" (
    del /f /q "%TARGET%"
    echo   已删除 %TARGET%
    echo   Claude Code 的价格覆盖已撤销，重启会话后生效。
  ) else (
    echo   没有找到 %TARGET% ，无需卸载。
  )
  echo.
  pause
  exit /b 0
)

REM ---- 安装 ----
if not exist "%SOURCE%" (
  echo   [错误] 找不到源文件：%SOURCE%
  echo   请确认 install-managed-pricing.cmd 和 managed-settings.json 在同一个目录下。
  echo.
  pause
  exit /b 1
)

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"
if errorlevel 1 (
  echo   [错误] 无法创建 %TARGET_DIR%
  echo.
  pause
  exit /b 1
)

copy /y "%SOURCE%" "%TARGET%" >nul
if errorlevel 1 (
  echo   [错误] 复制失败。
  echo.
  pause
  exit /b 1
)

echo.
echo   已写入：%TARGET%
echo.
echo   内容：
type "%TARGET%"
echo.
echo   下次启动 Claude Code 会话时生效。
echo   撤销请再次以管理员身份运行：install-managed-pricing.cmd remove
echo.
pause
