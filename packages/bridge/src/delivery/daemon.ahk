; belay delivery daemon (AutoHotkey v2)
; Spawned once by the bridge; commands arrive as pipe-delimited lines on stdin:
;   focus|<winQuery>
;   text|<winQuery>|<literal text>            (text may contain '|' — join tail)
;   key|<winQuery>|<ahk Send syntax, e.g. +{Tab}>
;   conwrite|<pid>|<%XX-encoded bytes>        (console input-buffer injection)
;   findtitle|<substring>                     -> hwnd|<n> (visible windows)
;   checkpid|<pid>                            -> alive|0/1
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

; Bound = we address a specific window handle (a deck-launched console), which
; takes the focus-free ControlSend path. App-level queries (ahk_exe …) don't.
isBound(winQuery) {
  return InStr(winQuery, "ahk_id ") = 1
}

; Bring a window to the foreground (for focus / double-tap surfacing).
; Returns "ok", or "noactivate" when the window EXISTS but Windows' foreground
; lock refuses activation. Escalates through the standard workarounds.
activateHwnd(hwnd) {
  if (WinActive(hwnd))
    return "ok"
  WinActivate(hwnd)
  if (WinWaitActive(hwnd, , 1))
    return settle()
  ; A brief Alt tap grants foreground rights — the classic workaround.
  Send "{Alt down}{Alt up}"
  WinActivate(hwnd)
  if (WinWaitActive(hwnd, , 1))
    return settle()
  ; Last resort: minimize+restore usually defeats a stubborn foreground lock.
  try {
    WinMinimize(hwnd)
    WinRestore(hwnd)
    WinActivate(hwnd)
    if (WinWaitActive(hwnd, , 1))
      return settle()
  }
  return "noactivate"
}

settle() {
  Sleep 120
  return "ok"
}

; Send a key chord reliably. Event mode honors SetKeyDelay (Input mode does
; not), giving modifier combos a real hold so terminals register them.
sendChord(chord) {
  SendEvent chord
}

; Decode %XX escapes (the conwrite payload encoding — keeps control bytes
; like ESC and CR safe inside the newline-delimited protocol).
pctDecode(s) {
  out := ""
  i := 1
  while (i <= StrLen(s)) {
    c := SubStr(s, i, 1)
    if (c = "%" && i + 2 <= StrLen(s)) {
      out .= Chr("0x" . SubStr(s, i + 1, 2))
      i += 3
    } else {
      out .= c
      i += 1
    }
  }
  return out
}

; Inject text straight into a process's console INPUT BUFFER via
; AttachConsole + WriteConsoleInput — no window, no focus, works identically
; for classic conhost and Windows Terminal (ConPTY) hosted sessions. Apps in
; VT input mode (Claude Code's TUI) consume the chars as a byte stream, so
; special keys are just their VT sequences (ESC, CR, ESC[Z, …).
; Returns "ok" or an error reason. This daemon is a GUI process (no console
; of its own), so attach/detach cycling is safe and reentrant.
conInject(pid, text) {
  DllCall("kernel32\FreeConsole")
  if (!DllCall("kernel32\AttachConsole", "uint", pid)) {
    return "gone"  ; process dead or has no console
  }
  ; GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ|WRITE, OPEN_EXISTING
  h := DllCall("kernel32\CreateFile", "str", "CONIN$", "uint", 0xC0000000,
    "uint", 3, "ptr", 0, "uint", 3, "uint", 0, "ptr", 0, "ptr")
  if (h = -1) {
    DllCall("kernel32\FreeConsole")
    return "conin failed"
  }
  ; INPUT_RECORD is 20 bytes: WORD EventType(+2 pad) then KEY_EVENT_RECORD
  ; {BOOL bKeyDown, WORD wRepeatCount, WORD wVirtualKeyCode, WORD
  ;  wVirtualScanCode, WCHAR UnicodeChar, DWORD dwControlKeyState}.
  n := StrLen(text)
  buf := Buffer(n * 2 * 20, 0)
  offset := 0
  loop parse text {
    code := Ord(A_LoopField)
    loop 2 {  ; key-down record then key-up
      NumPut("ushort", 1, buf, offset)               ; EventType = KEY_EVENT
      NumPut("int", A_Index = 1 ? 1 : 0, buf, offset + 4)  ; bKeyDown
      NumPut("ushort", 1, buf, offset + 8)           ; wRepeatCount
      NumPut("ushort", 0, buf, offset + 10)          ; wVirtualKeyCode
      NumPut("ushort", 0, buf, offset + 12)          ; wVirtualScanCode
      NumPut("ushort", code, buf, offset + 14)       ; UnicodeChar
      NumPut("uint", 0, buf, offset + 16)            ; dwControlKeyState
      offset += 20
    }
  }
  written := 0
  okWrite := DllCall("kernel32\WriteConsoleInput", "ptr", h, "ptr", buf,
    "uint", n * 2, "uint*", &written)
  DllCall("kernel32\CloseHandle", "ptr", h)
  DllCall("kernel32\FreeConsole")
  return okWrite && written = n * 2 ? "ok" : "write failed"
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
        ; Resolve a process id to its VISIBLE top-level window (0 if none yet).
        ; Never enable DetectHiddenWindows here: console processes own hidden
        ; plumbing windows (PseudoConsoleWindow under ConPTY, MSCTFIME UI)
        ; that match first and are undeliverable — binding one sends every
        ; keystroke into the void while reporting ok.
        found := WinExist("ahk_pid " . parts[2])
        respond("hwnd|" . (found ? found : 0))
      case "checkwin":
        ; Liveness probe for a bound window handle (minimized counts as
        ; alive; destroyed does not). Drives the dead-session skull.
        respond("alive|" . (WinExist("ahk_id " . parts[2]) ? 1 : 0))
      case "checkpid":
        ; Process liveness — the truer signal for WT-hosted consoles, whose
        ; window belongs to WindowsTerminal.exe, not the session.
        respond("alive|" . (ProcessExist(Integer(parts[2])) ? 1 : 0))
      case "findtitle":
        ; Visible window whose title contains the substring — used once at
        ; spawn to grab a WT window by its launch title token.
        found := WinExist(parts[2])
        respond("hwnd|" . (found ? found : 0))
      case "conwrite":
        ; Focus-free console input-buffer injection (see conInject).
        payload := SubStr(line, StrLen(parts[1]) + StrLen(parts[2]) + 3)
        result := conInject(Integer(parts[2]), pctDecode(payload))
        respond(result = "ok" ? "ok" : "err|" . result)
      case "text":
        hwnd := resolveWin(parts[2])
        if (!hwnd) {
          respond("err|gone")
          continue
        }
        ; Re-join remainder in case the text itself contains '|'
        text := SubStr(line, StrLen(parts[1]) + StrLen(parts[2]) + 3)
        if (isBound(parts[2])) {
          ; Bound console window: ControlSend delivers straight to the console
          ; input buffer — no focus needed or stolen (proven reliable).
          ControlSendText(text, , parts[2])
          respond("ok")
        } else if (activateHwnd(hwnd) = "ok") {
          SendText(text)
          respond("ok")
        } else {
          respond("err|noactivate")
        }
      case "key":
        hwnd := resolveWin(parts[2])
        if (!hwnd) {
          respond("err|gone")
          continue
        }
        if (isBound(parts[2])) {
          ControlSend(parts[3], , parts[2])
          respond("ok")
        } else if (activateHwnd(hwnd) = "ok") {
          sendChord(parts[3])
          respond("ok")
        } else {
          respond("err|noactivate")
        }
      case "seq":
        ; parts[3..] are chords; send each with a gap so a menu opened by an
        ; earlier chord is ready for the next (e.g. Ctrl+Shift+M then "4").
        hwnd := resolveWin(parts[2])
        if (!hwnd) {
          respond("err|gone")
          continue
        }
        bound := isBound(parts[2])
        focused := bound ? false : (activateHwnd(hwnd) = "ok")
        if (!bound && !focused) {
          respond("err|noactivate")
          continue
        }
        i := 3
        while (i <= parts.Length) {
          if (bound)
            ControlSend(parts[i], , parts[2])
          else
            sendChord(parts[i])
          if (i < parts.Length)
            Sleep 200
          i++
        }
        respond("ok")
      default:
        respond("err|unknown command: " . cmd)
    }
  } catch as e {
    respond("err|" . e.Message)
  }
}
