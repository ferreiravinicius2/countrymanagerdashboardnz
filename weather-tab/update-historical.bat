@echo off
REM =====================================================================
REM Weather Tracker - Update Historical Database
REM
REM Double-click this file to regenerate the local historical database
REM (last year + 5-year climatology) used by the dashboard.
REM
REM After it finishes, refresh the dashboard in your browser to pick up
REM the new data.
REM =====================================================================

setlocal
pushd "%~dp0\.."

echo ===============================================================
echo  Weather Tracker - Historical Database Update
echo ===============================================================
echo.
echo  Project folder: %CD%
echo.

REM Check Node.js is available
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on your PATH.
  echo.
  echo  Please install Node.js LTS from https://nodejs.org/
  echo  then run this file again.
  echo.
  pause
  popd
  endlocal
  exit /b 1
)

echo  Node.js detected. Starting generation...
echo.
echo  This can take several minutes depending on how many countries
echo  need refreshing. You can leave this window open and come back
echo  to it when it is done.
echo.
echo ---------------------------------------------------------------

REM Forward any CLI arguments the user may pass (e.g. --countries=br, --force)
node docs\scripts\generate-historical.mjs %*
set EXITCODE=%ERRORLEVEL%

echo ---------------------------------------------------------------
echo.

if %EXITCODE% NEQ 0 (
  echo [FAILED] The generator exited with code %EXITCODE%.
  echo.
  echo  If this is an Open-Meteo daily limit error, please try again
  echo  tomorrow. Otherwise, check your internet connection and run
  echo  this file again.
) else (
  echo [SUCCESS] Historical database updated.
  echo.
  echo  Refresh your dashboard in the browser to load the new data.
)

echo.
pause
popd
endlocal
exit /b %EXITCODE%
