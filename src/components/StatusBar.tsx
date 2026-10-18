import { useWorkspaceStore } from '../stores/workspace'
import { truncateMiddle } from '../utils/paths'
import { surfaceLabel } from './desktop/shellContract'

export function StatusBar() {
  const project = useWorkspaceStore((s) => s.projects.find((item) => item.id === s.activeProjectId) ?? null)
  const openTabs = useWorkspaceStore((s) => s.openTabs)
  const activeTab = useWorkspaceStore((s) => s.openTabs.find((tab) => tab.id === s.activeTabId) ?? null)
  const editorPos = useWorkspaceStore((s) => s.editorPos)
  const version = useWorkspaceStore((s) => s.version)
  const activeSurface = useWorkspaceStore((s) => s.activeSurface)
  const authStatus = useWorkspaceStore((s) => s.communityAuth.status)
  const dirtyCount = openTabs.filter((tab) => tab.dirty).length

  return (
    <footer className="statusbar" aria-label="应用状态">
      <span className="sb-item sb-surface">{surfaceLabel(activeSurface)}</span>
      <span className="sb-item sb-left" title={project?.rootPath}>
        {activeSurface === 'editor' ? (project ? truncateMiddle(project.rootPath, 70) : '未打开项目') : '铁锈工坊'}
      </span>
      {activeSurface === 'editor' && <>
        <span className="sb-item"><span className="sb-pill">Rust 配置</span></span>
        <span className="sb-item">{activeTab ? (activeTab.hasBom ? 'UTF-8 BOM' : 'UTF-8') : '—'}</span>
        <span className="sb-item">行 {editorPos.line}，列 {editorPos.col}</span>
        {dirtyCount > 0 && <span className="sb-item sb-dirty">未保存 {dirtyCount}</span>}
      </>}
      <span className="sb-item sb-connection" title={authStatus === 'signed_in' ? '社区账号已连接' : '社区账号未连接'}>
        <span className={`sb-dot ${authStatus === 'signed_in' ? 'online' : ''}`} aria-hidden="true" />
        {authStatus === 'signed_in' ? '已连接' : '离线可用'}
      </span>
      <span className="sb-item sb-version">v{version || '0.1.0'}</span>
    </footer>
  )
}
