/**
 * 底部状态栏：项目路径、语言、编码、行列号、保存状态、版本号。
 */
import { useWorkspaceStore } from '../stores/workspace'
import { truncateMiddle } from '../utils/paths'

export function StatusBar() {
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const openTabs = useWorkspaceStore((s) => s.openTabs)
  const activeTab = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === s.activeTabId) ?? null)
  const editorPos = useWorkspaceStore((s) => s.editorPos)
  const version = useWorkspaceStore((s) => s.version)

  const dirtyCount = openTabs.filter((t) => t.dirty).length

  return (
    <footer className="statusbar">
      <span className="sb-item sb-left" title={project?.rootPath}>
        {project ? truncateMiddle(project.rootPath, 70) : '未打开项目'}
      </span>
      <span className="sb-item">
        <span className="sb-pill">Rust 配置</span>
      </span>
      <span className="sb-item">{activeTab ? (activeTab.hasBom ? 'UTF-8 BOM' : 'UTF-8') : '—'}</span>
      <span className="sb-item">
        行 {editorPos.line}，列 {editorPos.col}
      </span>
      {dirtyCount > 0 && (
        <span className="sb-item" style={{ color: 'var(--g-red)' }}>
          未保存 {dirtyCount}
        </span>
      )}
      <span className="sb-item">v{version || '0.1.0'}</span>
    </footer>
  )
}
