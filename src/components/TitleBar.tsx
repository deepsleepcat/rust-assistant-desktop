import { useWorkspaceStore } from '../stores/workspace'
import { AppIcon } from './AppIcon'
import { formatShortcut, resolveShortcuts } from '../utils/shortcuts'

export function TitleBar() {
  const setCommandOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const overrides = useWorkspaceStore((s) => s.settings.keyboardShortcuts)
  const shortcuts = resolveShortcuts(overrides)

  return (
    <header className="titlebar">
      <div className="titlebar-inner">
        <button
          className="titlebar-search"
          type="button"
          onClick={() => setCommandOpen(true)}
          aria-label="打开命令面板"
        >
          <AppIcon name="search" size={14} />
          <span>搜索命令、打开项目…</span>
          {shortcuts.commandPalette && <span className="hint"><kbd>{formatShortcut(shortcuts.commandPalette)}</kbd></span>}
        </button>
      </div>
      {window.rustAssistant?.platform === 'win32' && (
        <div className="window-controls" aria-label="窗口控制">
          <button type="button" aria-label="最小化" title="最小化" onClick={() => window.rustAssistant?.windowControl?.('minimize')}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6h8" /></svg>
          </button>
          <button type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => window.rustAssistant?.windowControl?.('maximize')}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2" y="4" width="6" height="6" rx="1" /><path d="M4 2h5a1 1 0 0 1 1 1v5" /></svg>
          </button>
          <button className="window-close" type="button" aria-label="关闭窗口" title="关闭窗口" onClick={() => window.rustAssistant?.windowControl?.('close')}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2.5 2.5 7 7m0-7-7 7" /></svg>
          </button>
        </div>
      )}
    </header>
  )
}
