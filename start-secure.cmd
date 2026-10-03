@echo off
setlocal
set "BITEHUB_PORT=8000"
set "BITEHUB_CERT=%~dp0.local-certs\server.crt"
set "BITEHUB_KEY=%~dp0.local-certs\server.key"
if not exist "%BITEHUB_CERT%" (
  echo Missing local TLS certificate. See README.md section "Phone GPS over local HTTPS".
  pause
  exit /b 1
)
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" "%~dp0server.py" --host 0.0.0.0 --port %BITEHUB_PORT% --https-cert "%BITEHUB_CERT%" --https-key "%BITEHUB_KEY%"
  exit /b %ERRORLEVEL%
)
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py "%~dp0server.py" --host 0.0.0.0 --port %BITEHUB_PORT% --https-cert "%BITEHUB_CERT%" --https-key "%BITEHUB_KEY%"
  exit /b %ERRORLEVEL%
)
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%~dp0server.py" --host 0.0.0.0 --port %BITEHUB_PORT% --https-cert "%BITEHUB_CERT%" --https-key "%BITEHUB_KEY%"
  exit /b %ERRORLEVEL%
)
echo Python 3 was not found. Use the bundled Codex Python runtime or install Python.
pause
exit /b 1
