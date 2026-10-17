import { useEffect } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { matchGlobalShortcut } from './shortcuts'

export function useAppShortcuts(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = useWorkspaceStore.getState()
      if (!state.ready) return
      const action = matchGlobalShortcut(event, state.settings.keyboardShortcuts)
      if (!action) return
      event.preventDefault()
      if (action === 'commandPalette') state.setCommandOpen(!state.commandOpen)
      if (action === 'settings') state.setSettingsOpen(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
