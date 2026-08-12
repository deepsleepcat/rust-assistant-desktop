/**
 * 应用根组件：组装三栏布局、主题、快捷键与全局弹层。
 */
import { useEffect } from 'react'
import { useWorkspaceStore } from './stores/workspace'
import { isElectron } from './services/bridge'
import { Backdrop } from './components/Backdrop'
import { TitleBar } from './components/TitleBar'
import { StatusBar } from './components/StatusBar'
import { ConfirmDialog } from './components/Modal'
import { WorkspaceSidebar } from './features/workspace/WorkspaceSidebar'
import { ProjectPanel } from './features/project/ProjectPanel'
import { EditorArea } from './features/editor/EditorArea'
import { ConversationPanel } from './features/conversation/ConversationPanel'
import { SettingsModal } from './features/settings/SettingsModal'
import { CommandPalette } from './features/workspace/CommandPalette'
import type { ThemeMode } from './types/domain'

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return mode
}

export function App() {
  const ready = useWorkspaceStore((s) => s.ready)
  const settings = useWorkspaceStore((s) => s.settings)
  const settingsOpen = useWorkspaceStore((s) => s.settingsOpen)
  const toast = useWorkspaceStore((s) => s.toast)
  const dismissToast = useWorkspaceStore((s) => s.dismissToast)

  const theme = resolveTheme(settings.theme)

  // 初始化：读取本地设置与工作区
  useEffect(() => {
    void useWorkspaceStore.getState().init()
  }, [])

  // 跟随系统主题变化
  useEffect(() => {
    if (settings.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => useWorkspaceStore.getState().updateSettings({ theme: 'system' })
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings.theme])

  // 设置 html 主题属性 + Electron 标记（用于避开系统窗口按钮）
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.body.classList.toggle('electron', isElectron)
  }, [theme])

  // 全局快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const s = useWorkspaceStore.getState()
        s.setCommandOpen(!s.commandOpen)
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        useWorkspaceStore.getState().setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(dismissToast, 2600)
    return () => clearTimeout(t)
  }, [toast, dismissToast])

  if (!ready) {
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--bg-app)',
          color: 'var(--text-2)',
          fontSize: 14,
        }}
      >
        正在启动…
      </div>
    )
  }

  return (
    <div className="app">
      <div className="rainbow-bar" />
      <Backdrop />
      <TitleBar />

      <div className="app-body" style={{ gridTemplateColumns: `${settings.leftWidth}px 1fr ${settings.rightWidth}px` }}>
        <aside className="sidebar" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--panel-gap)', minWidth: 0 }}>
          <WorkspaceSidebar />
          <ProjectPanel />
        </aside>

        <EditorArea />

        <ConversationPanel />
      </div>

      <StatusBar />

      {settingsOpen && <SettingsModal />}
      <CommandPalette />
      <ConfirmDialog />

      {toast && <div className="toast">{toast}</div>}

      {!isElectron && (
        <div
          style={{
            position: 'fixed',
            bottom: 34,
            right: 14,
            zIndex: 500,
            fontSize: 11,
            color: 'var(--text-3)',
            pointerEvents: 'none',
          }}
        >
          浏览器预览模式（未连接桌面端）
        </div>
      )}
    </div>
  )
}
