' Re-apply the usage overlay patch at logon.
'
' Why this exists: when the Claude Code extension updates, VS Code deletes the
' whole old version directory (2.1.284 -> 2.1.285), taking the patch with it.
' apply.js is normally run by hand; forgetting means the overlay silently
' disappears until someone notices.
'
' Registered as a logon-triggered scheduled task by install-autorepair.cmd.
' Launched through wscript.exe because it is a GUI host with no console window
' -- running it via cmd would flash a black box on every logon.
' Everything (including errors) is appended to autorepair.log next to this file.
'
' NOTE: keep this file ASCII-only. cscript reads .vbs as ANSI, so UTF-8
' comments get mis-decoded on a Chinese Windows install and the script fails
' to compile.
Option Explicit

Dim fso, sh, here, logPath, nodeExe, Q, cmd, f

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
Q = Chr(34)
here = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = here & "\autorepair.log"

' Keep the log from growing forever. One run a day, a few lines each -- this
' cap is pure paranoia, it should never actually trip.
If fso.FileExists(logPath) Then
  If fso.GetFile(logPath).Size > 262144 Then fso.DeleteFile logPath
End If

Set f = fso.OpenTextFile(logPath, 8, True)   ' 8 = ForAppending, True = create if missing
f.WriteLine ""
f.WriteLine "===== " & Now & " ====="
f.Close

If Not fso.FileExists(here & "\apply.js") Then
  Set f = fso.OpenTextFile(logPath, 8, True)
  f.WriteLine "apply.js not found in " & here & " -- skipped"
  f.Close
  WScript.Quit 1
End If

' A scheduled task does not necessarily inherit the logon session's PATH, so
' try the default install location first and only then fall back to PATH.
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

' cmd /c ""<node>" "<apply.js>" >> "<log>" 2>&1"
' The extra outer quote pair is a cmd /c rule: when the command starts with a
' quote, the whole thing must be wrapped in another pair.
cmd = "cmd /c " & Q & Q & nodeExe & Q & " " & Q & here & "\apply.js" & Q _
    & " >> " & Q & logPath & Q & " 2>&1" & Q

sh.Run cmd, 0, True   ' 0 = hidden window, True = wait for it to finish
