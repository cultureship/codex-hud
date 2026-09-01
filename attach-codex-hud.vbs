Option Explicit

Dim shell, fso, baseDir, launcher, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(baseDir, "codex-hud.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcher & """ -AttachOnly"

shell.Run command, 0, False
