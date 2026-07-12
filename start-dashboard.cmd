@echo off
setlocal
title Agent Factory - Dashboard

REM ===== Reglages (modifiable) =====
set "WORKDIR=C:\Users\gaeli\Documents\usine"
set "PORT=8765"
REM =================================

REM Dossier du projet agent-factory (ou vit la commande `factory`), sans slash final.
for %%I in ("%~dp0.") do set "AGENT_FACTORY=%%~fI"

where uv >nul 2>nul
if errorlevel 1 (
  echo uv introuvable. Installe uv puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0dashboard" 2>nul
if not exist "package.json" (
  echo Dossier dashboard introuvable. Garde ce fichier a la racine du projet agent-factory.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js introuvable. Installe Node.js puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

if not exist "dist\server.js" (
  echo Premier lancement : construction du dashboard...
  call npm run build
  if errorlevel 1 (
    echo.
    echo Echec du build. Verifie que les dependances sont installees ^(npm install^).
    echo.
    pause
    exit /b 1
  )
)

echo.
echo Dashboard : http://127.0.0.1:%PORT%
echo Workspace : %WORKDIR%
echo Ferme cette fenetre pour arreter le serveur.
echo.

REM Ouvre le navigateur apres ~2s, le temps que le serveur ecoute.
start "" /min cmd /c "ping -n 3 127.0.0.1 >nul & explorer http://127.0.0.1:%PORT%"

node dist\server.js --workdir "%WORKDIR%" --port %PORT% --factory "uv run --project %AGENT_FACTORY% factory"

echo.
echo Le serveur s'est arrete.
pause
