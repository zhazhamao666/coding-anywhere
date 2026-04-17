@echo off
if /i not "%~1"=="--launched" (
  start "Coding Anywhere" cmd.exe /k call "%~f0" --launched
  exit /b 0
)

setlocal

pushd "%~dp0"

call npm run build
if errorlevel 1 (
  echo.
  echo Build failed with exit code %errorlevel%.
  popd
  exit /b %errorlevel%
)

call npm run start
set "exit_code=%errorlevel%"

echo.
echo Coding Anywhere stopped with exit code %exit_code%.

popd
exit /b %exit_code%
