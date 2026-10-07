; Hooks of the NSIS installer built with the agent layer (tauri.agent.conf.json). The agent
; server, begitra-mcp.exe, runs for as long as an agent's session keeps it, and Windows neither
; replaces nor deletes a running executable: the installer and the uninstaller stop it first.
; The agent's client starts it again on its next call.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM begitra-mcp.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM begitra-mcp.exe'
  Pop $0
!macroend
