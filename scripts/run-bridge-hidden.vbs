' Conn bridge launcher — starts "npm run bridge" with NO visible console window.
' Intended as a Task Scheduler "at logon" action:  wscript.exe <this file>
'
' Self-locating: the repo root is this script's grandparent (repo\scripts\*.vbs),
' so it works wherever Conn is cloned. Goes through cmd -> npm.cmd, which also
' sidesteps the PowerShell script-execution policy that blocks npm.ps1 on some
' locked-down machines.
Option Explicit
Dim fso, sh, repoRoot
Set fso = CreateObject("Scripting.FileSystemObject")
repoRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = repoRoot
' 0 = hidden window; False = don't wait (the bridge runs indefinitely).
sh.Run "cmd /c npm run bridge", 0, False
