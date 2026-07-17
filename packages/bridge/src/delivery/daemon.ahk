; claude-deck delivery daemon (AutoHotkey v2)
; Spawned once by the bridge; commands arrive as pipe-delimited lines on stdin:
;   focus|<winQuery>
;   text|<winQuery>|<literal text>            (text may contain '|' — join tail)
;   key|<winQuery>|<ahk Send syntax, e.g. +{Tab}>
;   ping|
; One response line per command on stdout: "ok" or "err|<reason>".
; winQuery uses AHK WinTitle syntax (substring match mode), e.g.
;   "revops-platform" or "ahk_exe Claude.exe".
#Requires AutoHotkey v2.0
#SingleInstance Off
SetTitleMatchMode 2
SendMode "Input"
; Terminal emulators frequently drop instantaneously-synthesized modifier
; combos (e.g. Shift+Tab). A real press duration + inter-key delay makes them
; register. Applies to Event-mode sends (see sendChord).
SetKeyDelay 40, 40

stdin := FileOpen("*", "r", "UTF-8")
stdout := FileOpen("*", "w", "UTF-8")

respond(msg) {
  global stdout
  stdout.WriteLine(msg)
  stdout.Read(0) ; flush
}

; Resolve a query to a window handle (0 = no such window).
resolveWin(winQuery) {
  if (winQuery = "")
    return 0
  return WinExist(winQuery)
}

; Bring a window to the foreground. Returns "ok", or "noactivate" when the
; window EXISTS but Windows' foreground lock refuses the activation.
activateHwnd(hwnd) {
  WinActivate(hwnd)
  if (!WinWaitActive(hwnd, , 2)) {
    ; A brief Alt tap grants foreground rights — the classic workaround.
    Send "{Alt down}{Alt up}"
    WinActivate(hwnd)
    if (!WinWaitActive(hwnd, , 2))
      return "noactivate"
  }
  Sleep 120 ; let focus settle before typing
  return "ok"
}

; Send a key chord reliably. Event mode honors SetKeyDelay (Input mode does
; not), giving modifier combos a real hold so terminals register them.
sendChord(chord) {
  SendEvent chord
}

loop {
  line := stdin.ReadLine()
  if (line = "" && stdin.AtEOF)
    break
  line := RTrim(line, "`r`n")
  if (line = "")
    continue
  parts := StrSplit(line, "|")
  cmd := parts[1]
  try {
    switch cmd {
      case "ping":
        respond("ok")
      case "focus":
        hwnd := resolveWin(parts[2])
        if (!hwnd)
          respond("err|gone")
        else
          respond(activateHwnd(hwnd) = "ok" ? "ok" : "err|noactivate")
      case "findpid":
        ; Resolve a process id to its top-level window handle (0 if none yet).
        ; Used by the console launcher to bind a spawned terminal to a session.
        DetectHiddenWindows true
        found := WinExist("ahk_pid " . parts[2])
        DetectHiddenWindows false
        respond("hwnd|" . (found ? found : 0))
      case "checkwin":
        ; Liveness probe for a bound window handle (minimized counts as
        ; alive; destroyed does not). Drives the dead-session skull.
        respond("alive|" . (WinExist("ahk_id " . parts[2]) ? 1 : 0))
      case "text":
        hwnd := resolveWin(parts[2])
        if (!hwnd) {
          respond("err|gone")
          continue
        }
        ; Re-join remainder in case the text itself contains '|'
        text := SubStr(line, StrLen(parts[1]) + StrLen(parts[2]) + 3)
        if (activateHwnd(hwnd) = "ok") {
          SendText(text)
          respond("ok")
        } else {
          ; Foreground lock refused focus — deliver directly to the window
          ; instead. ControlSend doesn't need (or steal) focus.
          ControlSendText(text, , "ahk_id " . hwnd)
          respond("ok|bg")
        }
      case "key":
        hwnd := resolveWin(parts[2])
        if (!hwnd) {
          respond("err|gone")
          continue
        }
        if (activateHwnd(hwnd) = "ok") {
          sendChord(parts[3])
          respond("ok")
        } else {
          ControlSend(parts[3], , "ahk_id " . hwnd)
          respond("ok|bg")
        }
      case "seq":
        ; parts[3..] are chords; send each with a gap so a menu opened by an
        ; earlier chord is ready for the next (e.g. Ctrl+Shift+M then "4").
        hwnd := resolveWin(parts[2])
        if (!hwnd) {
          respond("err|gone")
          continue
        }
        bg := activateHwnd(hwnd) != "ok"
        i := 3
        while (i <= parts.Length) {
          if (bg)
            ControlSend(parts[i], , "ahk_id " . hwnd)
          else
            sendChord(parts[i])
          if (i < parts.Length)
            Sleep 200
          i++
        }
        respond(bg ? "ok|bg" : "ok")
      default:
        respond("err|unknown command: " . cmd)
    }
  } catch as e {
    respond("err|" . e.Message)
  }
}
