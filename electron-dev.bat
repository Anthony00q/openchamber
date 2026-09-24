@echo off
rem Inicia OpenChamber Desktop en modo desarrollo (HMR + Electron).
rem Equivale a: bun run electron:dev
rem Uso: doble clic, o "electron-dev.bat" desde cmd en cualquier carpeta.
setlocal
cd /d "%~dp0"

where bun >nul 2>nul
if errorlevel 1 (
  echo.
  echo [electron-dev] ERROR: no se encontro bun en el PATH.
  echo [electron-dev] Instala Bun 1.4.x desde https://bun.sh y vuelve a intentarlo.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo.
  echo [electron-dev] ERROR: no se encontro package.json junto al .bat.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo [electron-dev] node_modules no existe. Instalando dependencias con bun install...
  echo.
  call bun install
  if errorlevel 1 (
    echo.
    echo [electron-dev] ERROR: bun install fallo. Revisa los mensajes de arriba.
    echo.
    pause
    exit /b 1
  )
)

echo [electron-dev] Arrancando OpenChamber Desktop (HMR + Electron)...
echo [electron-dev] Cierra la ventana de Electron o pulsa Ctrl+C para detener.
echo.
call bun run electron:dev
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo [electron-dev] Termino con codigo %EXITCODE%.
) else (
  echo [electron-dev] Finalizado.
)
echo.
pause
endlocal & exit /b %EXITCODE%
