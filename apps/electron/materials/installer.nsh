!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro RunGyllPathUpdate ACTION
  File /oname=$PLUGINSDIR\gyshell-cli-path.ps1 "${BUILD_RESOURCES_DIR}\gyshell-cli-path.ps1"
  StrCpy $R0 "User"
  ${if} $installMode == "all"
    StrCpy $R0 "Machine"
  ${endIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gyshell-cli-path.ps1" -Action "${ACTION}" -Scope "$R0" -Entry "$INSTDIR\resources\cli\bin"'
  Pop $R1
  Pop $R2
  DetailPrint "$R2"
  ${if} $R1 == 0
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${endIf}
!macroend

!macro customInstall
  !insertmacro RunGyllPathUpdate "Add"
  ${if} $R1 != 0
    DetailPrint "GyShell was installed, but the installer could not add gyll to PATH. Exit code: $R1"
    ${ifNot} ${Silent}
      MessageBox MB_ICONEXCLAMATION "GyShell was installed, but the installer could not add gyll to PATH.$\r$\n$\r$\n$R2"
    ${endIf}
  ${endIf}
!macroend

!macro customUnInstall
  !insertmacro RunGyllPathUpdate "Remove"
  ${if} $R1 != 0
    DetailPrint "Unable to remove the GyShell CLI PATH entry; continuing uninstall. Exit code: $R1"
  ${endIf}
!macroend
