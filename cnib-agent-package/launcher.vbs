' CNIB Agent Launcher
' Executa o agente sem mostrar nenhuma janela de terminal
' Chamado pelo protocolo cnib:// ou diretamente

Dim arg, exePath, scriptDir

scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
exePath = scriptDir & "\cnib-agent.exe"
arg = ""

' Pega o argumento (sessionId via protocolo cnib://)
If WScript.Arguments.Count > 0 Then
    arg = WScript.Arguments(0)
End If

If arg = "" Then
    MsgBox "Argumento inválido. Acesse o sistema e clique em 'Login com Certificado'.", 16, "CNIB"
    WScript.Quit
End If

' Executa o .exe sem janela (0 = oculto)
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run """" & exePath & """ """ & arg & """", 0, False
Set shell = Nothing