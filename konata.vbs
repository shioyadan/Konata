Set ws = CreateObject("Wscript.Shell") 
If Wscript.Arguments.Count() > 0 then 
    ws.run "cmd /c npx electron . " & Wscript.Arguments.Item(0), vbhide
Else
    ws.run "cmd /c npx electron . ", vbhide
End If
