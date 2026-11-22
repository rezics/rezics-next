!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  Var /GLOBAL IsPowerShellAvailable

  # A compatibility stub can report success without executing the probe.
  nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "if ((Get-Command Get-CimInstance -ErrorAction SilentlyContinue) -and ((Get-ExecutionPolicy -Scope Process) -ne 'Restricted')) { [Console]::Write('rezics-cim-ready') } else { exit 1 }"`
  Pop $0
  Pop $1
  ${if} $0 == 0
  ${andIf} $1 == "rezics-cim-ready"
    StrCpy $IsPowerShellAvailable 0
    !insertmacro _CHECK_APP_RUNNING
  ${else}
    # Without CIM paths, ask the user to close the matching processes before replacing files.
    ${Do}
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $0
      ${nsProcess::FindProcess} "rezics-launcher-host.exe" $1
      ${nsProcess::Unload}
      ${if} $0 != 0
      ${andIf} $1 != 0
        ${ExitDo}
      ${endIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY +2
      Quit
    ${Loop}
  ${endIf}
!macroend
