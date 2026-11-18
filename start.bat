@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem StruBrowser launcher for Windows, counterpart of start.sh and start.command.
rem   start.bat            dev mode: API 8787 plus Web 5173, opens the browser
rem   start.bat prod       prod mode: build, then serve everything on port 8787
rem   set STRU_NO_OPEN=1   do not open the browser
rem   set PORT=9000        custom API port, set WEB_PORT=9001 for a custom Web port
rem API and Web each run in their own console window, titled StruBrowser API and
rem StruBrowser Web. Read the logs there and close a window to stop that service.
rem Running this script again stops the old windows first, so the code is always fresh.
rem Public tunnel mode needs bash and cloudflared and is not supported here.
rem Keep this file ASCII only with CRLF line endings. After chcp 65001 cmd.exe
rem mis-reads multibyte characters in a batch file and runs pieces of comments.

set "RC=0"
set "MODE=%~1"
if not defined MODE set "MODE=dev"
if /i "%MODE%"=="restart" set "MODE=dev"
if /i "%MODE%"=="--restart" set "MODE=dev"
if /i "%MODE%"=="--prod" set "MODE=prod"
if /i "%MODE%"=="tunnel" goto :no_tunnel
if /i "%MODE%"=="--tunnel" goto :no_tunnel
if /i not "%MODE%"=="dev" if /i not "%MODE%"=="prod" (
  set "ERR=Unknown argument. Usage: start.bat or start.bat prod"
  goto :fail
)

rem ---------- environment checks ----------
if not exist package.json (
  set "ERR=Run this script from the StruBrowser project root"
  goto :fail
)
where node >nul 2>&1 || (
  set "ERR=Node.js not found. Install Node 22.5 or newer"
  goto :fail
)
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)" || (
  set "ERR=Node is too old. Need 22.5 or newer for the built-in node:sqlite"
  goto :fail
)
where npm >nul 2>&1 || (
  set "ERR=npm not found"
  goto :fail
)
where curl >nul 2>&1 || (
  set "ERR=curl.exe not found. It ships with Windows 10 1803 and newer"
  goto :fail
)

if not exist node_modules (
  echo [start] First run, installing dependencies: npm install ...
  call npm install || (
    set "ERR=npm install failed"
    goto :fail
  )
)
if not exist server\convert\.venv\Scripts\python.exe (
  echo [start] Optional STEP converter not installed. For STEP face colors run: npm run setup:step
)

rem ---------- ports and mode dispatch ----------
if not defined PORT set "PORT=8787"
set "API_PORT=%PORT%"
if /i "%MODE%"=="prod" goto :prod

rem ---------- dev mode ----------
call :stop_server
call :stop_web
call :port_busy %API_PORT% 0.0.0.0 && (
  set "ERR=Port %API_PORT% is used by another program. Try: set PORT=9000 and run again"
  goto :fail
)
echo [start] Starting API on port %API_PORT% ...
start "StruBrowser API" cmd /k "chcp 65001 >nul & node --experimental-sqlite server/index.js"
call :wait_http http://127.0.0.1:%API_PORT%/api/health 40 || (
  set "ERR=API failed to start. See the window titled StruBrowser API"
  goto :fail
)

if not defined WEB_PORT call :find_web_port
if not defined WEB_PORT (
  set "ERR=No free Web port found. Try: set WEB_PORT=9001 and run again"
  goto :fail
)
echo [start] Starting Web on port %WEB_PORT% ...
set "STRU_API_URL=http://127.0.0.1:%API_PORT%"
start "StruBrowser Web" cmd /k "chcp 65001 >nul & node node_modules\vite\bin\vite.js --port %WEB_PORT% --strictPort --host 127.0.0.1"
call :wait_http http://127.0.0.1:%WEB_PORT%/ 40 || (
  set "ERR=Web failed to start. See the window titled StruBrowser Web"
  goto :fail
)

call :open_browser http://127.0.0.1:%WEB_PORT%/
echo.
echo   StruBrowser is running
echo   Web : http://127.0.0.1:%WEB_PORT%/
echo   API : http://127.0.0.1:%API_PORT%/api/health
echo   Logs: the StruBrowser API and StruBrowser Web windows
echo   Tip : register an account on first use. Close the two windows to stop.
echo.
goto :end

rem ---------- prod mode ----------
:prod
call :stop_server
call :port_busy %API_PORT% 0.0.0.0 && (
  set "ERR=Port %API_PORT% is used by another program. Try: set PORT=9000 and run again"
  goto :fail
)
echo [start] Building the frontend ...
call npm run build || (
  set "ERR=Frontend build failed"
  goto :fail
)
echo [start] Starting the server on a single port ...
set "NODE_ENV=production"
start "StruBrowser API" cmd /k "chcp 65001 >nul & node --experimental-sqlite server/index.js"
call :wait_http http://127.0.0.1:%API_PORT%/api/health 40 || (
  set "ERR=Server failed to start. See the window titled StruBrowser API"
  goto :fail
)
call :open_browser http://127.0.0.1:%API_PORT%/
echo.
echo   StruBrowser is running in prod mode
echo   Web/API: http://127.0.0.1:%API_PORT%/
echo   LAN    : see the http://LAN-IP:%API_PORT% line in the server window; allow it in the firewall
echo   Logs   : the StruBrowser API window. Close it to stop.
echo   Public : docs/DEPLOY.md
echo.
goto :end

:no_tunnel
set "ERR=start.bat does not support the public tunnel because scripts/tunnel.sh needs bash and cloudflared. Run start.bat for local use"
goto :fail

:fail
echo.
echo [start] %ERR%
pause
set "RC=1"

:end
exit /b %RC%

rem ---------- subroutines ----------

rem Returns 0 if the port is in use, 1 if free. Args: port, listen address
:port_busy
node -e "const s=require('net').createServer();s.once('error',()=>process.exit(0));s.once('listening',()=>s.close(()=>process.exit(1)));s.listen(Number(process.argv[1]),process.argv[2])" %1 %2
exit /b %errorlevel%

rem Polls a URL about once a second. Returns 0 on success, 1 on timeout. Args: url, max tries
:wait_http
set /a "TRIES=%~2"
:wait_http_loop
curl -sf --noproxy "*" --max-time 2 "%~1" >nul 2>&1 && exit /b 0
set /a "TRIES-=1"
if %TRIES% leq 0 exit /b 1
ping -n 2 127.0.0.1 >nul
goto :wait_http_loop

rem Opens the URL in the default browser unless STRU_NO_OPEN=1
:open_browser
if "%STRU_NO_OPEN%"=="1" exit /b 0
start "" "%~1"
exit /b 0

rem Returns 0 if the API port is served by this project: /api/health contains strubrowser-server
:api_ours
curl -sf --noproxy "*" --max-time 2 "http://127.0.0.1:%API_PORT%/api/health" 2>nul | findstr /c:"strubrowser-server" >nul
exit /b %errorlevel%

rem Kills the process listening on a port. A listening line has foreign address :0. Args: port
:kill_port
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%~1 .* .*:0 "') do taskkill /pid %%p /t /f >nul 2>&1
exit /b 0

rem Stops the old API: close the window this script opened, then fall back to killing
rem the port owner, but only after confirming it is this project's server.
:stop_server
taskkill /fi "imagename eq cmd.exe" /fi "windowtitle eq StruBrowser API*" /t /f >nul 2>&1
call :api_ours || exit /b 0
echo [start] Stopping the old server on port %API_PORT% ...
call :kill_port %API_PORT%
set /a "TRIES=20"
:stop_server_wait
call :api_ours || exit /b 0
set /a "TRIES-=1"
if %TRIES% leq 0 exit /b 1
ping -n 2 127.0.0.1 >nul
goto :stop_server_wait

rem Stops the old Web: only the window this script opened, never a npm run dev the user started
:stop_web
taskkill /fi "imagename eq cmd.exe" /fi "windowtitle eq StruBrowser Web*" /t /f >nul 2>&1
exit /b 0

rem Finds the first bindable port from 5173 and sets WEB_PORT. The port comes back as node's exit code
:find_web_port
node -e "let p=5173;(function t(){const s=require('net').createServer();s.once('error',()=>{p+=1;t()});s.once('listening',()=>s.close(()=>process.exit(p)));s.listen(p,'127.0.0.1')})()"
set "WEB_PORT=%errorlevel%"
if %WEB_PORT% lss 1024 set "WEB_PORT="
exit /b 0
