@echo off
setlocal

pushd "%~dp0"

call npm run stop
set "exit_code=%errorlevel%"

if not "%exit_code%"=="0" (
  echo.
  echo Stop failed. Press any key to close this window.
  pause >nul
)

popd
exit /b %exit_code%
