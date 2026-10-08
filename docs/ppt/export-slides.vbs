' 用 PowerPoint COM 逐页导出 PNG（VBScript 走 IDispatch 晚绑定，
' 绕开 PowerShell 遇到的 TYPE_E_CANTLOADLIBRARY 类型库加载失败）
Option Explicit
Dim src, out, fso, ppt, pres
src = "C:\Users\axron\Desktop\kuozhan\docs\ppt\deck.pptx"
out = "C:\Users\axron\Desktop\kuozhan\docs\ppt\preview"

Set fso = CreateObject("Scripting.FileSystemObject")
If fso.FolderExists(out) Then fso.DeleteFolder out, True
fso.CreateFolder out

Set ppt = CreateObject("PowerPoint.Application")
Set pres = ppt.Presentations.Open(src, True, False, False)
pres.Export out, "PNG", 1600, 900
pres.Close
ppt.Quit

WScript.Echo "exported"
