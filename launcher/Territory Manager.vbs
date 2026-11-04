' Opens Territory Manager: starts its hidden helper (makes the Google My Maps maps) and the app window.
' The helper quits by itself if it is already running.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\.."
sh.Run "cmd /c npx tsx scripts\helper.ts", 0, False
sh.Run """C:\Program Files\Google\Chrome\Application\chrome.exe"" --profile-directory=""Profile 2"" --app=https://photographicode.github.io/territory-manager/", 1, False
