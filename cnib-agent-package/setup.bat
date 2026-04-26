@echo off
setlocal

echo.
echo  ================================================
echo   CNIB - Configuracao do Agente de Certificado
echo  ================================================
echo.

:: Pega o diretorio onde este .bat esta
set AGENT_DIR=%~dp0
set LAUNCHER=%AGENT_DIR%launcher.vbs
set EXE=%AGENT_DIR%cnib-agent.exe

:: Verifica se os arquivos existem
if not exist "%EXE%" (
    echo [ERRO] cnib-agent.exe nao encontrado nesta pasta.
    echo Certifique-se de que todos os arquivos estao na mesma pasta.
    pause
    exit /b 1
)

if not exist "%LAUNCHER%" (
    echo [ERRO] launcher.vbs nao encontrado nesta pasta.
    pause
    exit /b 1
)

echo Registrando protocolo cnib:// no Windows...
echo.

:: Registra o protocolo cnib:// apontando para o launcher.vbs
:: O launcher.vbs executa o .exe sem mostrar janela de terminal
:: Usa HKCU - nao precisa de Administrador

reg add "HKCU\Software\Classes\cnib" /ve /d "URL:CNIB Login Protocol" /f >nul 2>&1
reg add "HKCU\Software\Classes\cnib" /v "URL Protocol" /d "" /f >nul 2>&1
reg add "HKCU\Software\Classes\cnib\shell" /ve /d "" /f >nul 2>&1
reg add "HKCU\Software\Classes\cnib\shell\open" /ve /d "" /f >nul 2>&1
reg add "HKCU\Software\Classes\cnib\shell\open\command" /ve /d "wscript.exe \"%LAUNCHER%\" \"%%1\"" /f >nul 2>&1

if %errorlevel% equ 0 (
    echo  [OK] Protocolo cnib:// registrado com sucesso!
    echo.
    echo  ================================================
    echo   Configuracao concluida!
    echo.
    echo   Agora, ao clicar em "Login com Certificado"
    echo   no sistema CNIB, o agente sera aberto
    echo   automaticamente. Sem terminal, sem comandos.
    echo.
    echo   Esta pasta pode ser mantida em qualquer lugar.
    echo   Nao delete os arquivos cnib-agent.exe e
    echo   launcher.vbs pois sao necessarios para o login.
    echo  ================================================
) else (
    echo  [ERRO] Falha ao registrar protocolo.
    echo  Tente executar como Administrador.
)

echo.
pause
endlocal