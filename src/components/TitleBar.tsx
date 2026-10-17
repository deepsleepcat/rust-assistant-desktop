import { useWorkspaceStore } from '../stores/workspace'
import { AppIcon } from './AppIcon'
import { LogoR } from './LogoR'
import { truncateMiddle } from '../utils/paths'
import { surfaceLabel } from './desktop/shellContract'
import { formatShortcut, resolveShortcuts } from '../utils/shortcuts'

export function TitleBar() {
  const activeProject = useWorkspaceStore((s) => s.projects.find((project) => project.id === s.activeProjectId) ?? null)
  const activeSurface = useWorkspaceStore((s) => s.activeSurface)
  const setCommandOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const openSettings = useWorkspaceStore((s) => s.openSettings)
  const overrides = useWorkspaceStore((s) => s.settings.keyboardShortcuts)
  const shortcuts = resolveShortcuts(overrides)

  return (
    <header className="titlebar">
      <div className="titlebar-inner">
        <div className="titlebar-brand" aria-label="铁锈工坊">
          <LogoR size="header" />
          <span className="titlebar-name">铁锈工坊</span>
        </div>
        <span className="titlebar-sep" aria-hidden="true">/</span>
        <span className="titlebar-surface" aria-live="polite">{surfaceLabel(activeSurface)}</span>
        {activeProject && activeSurface === 'editor' && (
          <>
            <span className="titlebar-sep" aria-hidden="true">/</span>
            <span className="titlebar-project" title={activeProject.rootPath}>{truncateMiddle(activeProject.rootPath, 42)}</span>
          </>
        )}
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
        <div className="titlebar-spacer" />
        <button className="titlebar-settings" type="button" title={shortcuts.settings ? `打开设置（${formatShortcut(shortcuts.settings)}）` : '打开设置'} onClick={() => openSettings('appearance')}>
          <AppIcon name="settings" size={14} />
          <span>设置</span>
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
