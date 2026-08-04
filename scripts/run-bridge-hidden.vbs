' Conn bridge SUPERVISOR — keeps "npm run bridge" alive, with no visible console.
' Intended as a Task Scheduler "at logon" action:  wscript.exe <this file>
'
' Why a loop rather than a one-shot launch:
'   The deck's Reboot key restarts the bridge by simply EXITING it, and this
'   loop brings it straight back. A crash is handled identically, so the bridge
'   also self-heals — die at 3am, back in two seconds.
'
'   The previous design had the BRIDGE spawn its own detached restarter just
'   before exiting. That restarter had to outlive its dying parent, and
'   repeatedly didn't: a plain detached spawn, then WMI Win32_Process.Create,
'   both failed on a live machine and left the deck dead with no way back except
'   a manual Start-ScheduledTask. Supervising from OUTSIDE removes that whole
'   class of failure — nothing has to survive the exit, because the thing doing
'   the restarting was never inside the process that exits.
'
' This changes how the task behaves: the script now runs for as long as the
' bridge should live, so the task sits in "Running" (it used to complete within
' seconds and orphan the node tree). Stop-ScheduledTask therefore WORKS now.
' To stop the bridge by hand, stop the TASK — killing only node just makes this
' loop start it again.
'
' Self-locating: the repo root is this script's grandparent (repo\scripts\*.vbs),
' so it works wherever Conn is cloned. Goes through cmd -> npm.cmd, which also
' sidesteps the PowerShell script-execution policy that blocks npm.ps1 on some
' locked-down machines.
Option Explicit

' A bridge that exits sooner than this never really came up (bad config, port
' already taken, syntax error). Enough of those in a row and we stop, rather
' than spin forever relaunching something that cannot start.
Const RAPID_EXIT_SECONDS = 15
Const MAX_RAPID_EXITS = 5
Const RESTART_DELAY_MS = 2000   ' let the port and file handles clear

Dim fso, sh, repoRoot, startedAt, ranSeconds, rapidExits
Set fso = CreateObject("Scripting.FileSystemObject")
repoRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = repoRoot

rapidExits = 0
Do
  startedAt = Now
  ' 0 = hidden window. True = WAIT for it to exit — that wait IS the supervision.
  ' CONN_SUPERVISED tells the bridge its Reboot key can just exit and trust us.
  ' It is quoted so cmd doesn't fold the trailing space into the value.
  sh.Run "cmd /c set ""CONN_SUPERVISED=1"" && npm run bridge", 0, True
  ranSeconds = DateDiff("s", startedAt, Now)
  If ranSeconds < RAPID_EXIT_SECONDS Then
    rapidExits = rapidExits + 1
  Else
    rapidExits = 0   ' it ran properly, so this was a reboot or a late crash
  End If
  If rapidExits >= MAX_RAPID_EXITS Then Exit Do
  WScript.Sleep RESTART_DELAY_MS
Loop
