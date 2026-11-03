@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 goto directory_error

if not exist "runtime\node\node.exe" goto runtime_missing
"%~dp0runtime\node\node.exe" "%~dp0launcher.mjs"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Launcher exited with error code %RESULT%. See the message above.
goto finished

:runtime_missing
echo Bundled Node.js runtime was not found. Extract the complete ZIP first.
set "RESULT=1"
goto finished

:directory_error
echo Could not open the portable directory.
set "RESULT=1"

:finished
echo.
pause
exit /b %RESULT%
