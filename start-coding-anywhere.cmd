@echo off
setlocal

pushd "%~dp0"

call npm run build
if errorlevel 1 (
  echo.
  echo Build failed. Press any key to close this window.
  pause >nul
  popd
  exit /b 1
)

call npm run start
set "exit_code=%errorlevel%"

popd
exit /b %exit_code%
