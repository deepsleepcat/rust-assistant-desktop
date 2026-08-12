/**
 * 顶部标题栏：Logo、项目名、命令搜索（Codex 风格）、设置头像。
 * 在 Electron 中作为可拖拽区域（窗口控制按钮由系统渲染在右侧）。
 */
import { useWorkspaceStore } from '../stores/workspace'
import { IconSearch } from './icons'
import { truncateMiddle } from '../utils/paths'

export function TitleBar() {
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const setCommandOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)

  return (
    <header className="titlebar">
      <div className="titlebar-inner">
        <div className="titlebar-logo">R</div>
        <span className="titlebar-name">铁锈助手</span>
        {activeProject && (
          <>
            <span className="titlebar-sep">/</span>
            <span className="titlebar-project" title={activeProject.rootPath}>
              {truncateMiddle(activeProject.rootPath, 42)}
            </span>
          </>
        )}
        <div className="titlebar-search" onClick={() => setCommandOpen(true)} role="search" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setCommandOpen(true)}>
          <IconSearch size={14} />
          <span>搜索命令、打开项目…</span>
          <span className="hint">
            <kbd>Ctrl</kbd> <kbd>K</kbd>
          </span>
        </div>
        <div className="titlebar-spacer" />
        <button className="avatar-btn glow-hover" title="打开设置" onClick={() => setSettingsOpen(true)}>
          猫
        </button>
      </div>
    </header>
  )
}
