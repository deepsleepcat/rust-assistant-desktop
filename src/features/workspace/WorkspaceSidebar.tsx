/**
 * 左侧「项目」面板：最近项目列表 + 打开/移除项目。
 */
import { useWorkspaceStore } from '../../stores/workspace'
import { formatRelativeTime } from '../../utils/conversation'
import { IconClose, IconFolder, IconPlus, IconProject } from '../../components/icons'

export function WorkspaceSidebar() {
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const openProject = useWorkspaceStore((s) => s.openProject)
  const selectProject = useWorkspaceStore((s) => s.selectProject)
  const removeProject = useWorkspaceStore((s) => s.removeProject)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)

  return (
    <section className="panel" style={{ minHeight: 0 }}>
      <div className="panel-header">
        <IconProject size={13} />
        项目
        <span className="grow" />
        <button className="icon-btn" title="打开项目（文件夹）" onClick={() => void openProject()}>
          <IconPlus size={14} />
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="empty-state" style={{ padding: '18px 14px' }}>
          <span className="emoji">📁</span>
          <div>还没有项目</div>
          <button className="btn-rainbow" onClick={() => void openProject()}>
            打开项目
          </button>
        </div>
      ) : (
        <div className="projects-list">
          {projects.map((p) => (
            <div
              key={p.id}
              className={`project-item${p.id === activeProjectId ? ' active' : ''}`}
              onClick={() => void selectProject(p.id)}
              title={p.rootPath}
            >
              <span className="proj-icon">
                <IconFolder size={15} />
              </span>
              <span className="proj-name">{p.name}</span>
              <span className="proj-time">{formatRelativeTime(p.lastOpenedAt)}</span>
              <span
                className="row-actions"
                onClick={(e) => {
                  e.stopPropagation()
                  requestConfirm({
                    title: '移除项目记录',
                    message: '只移除列表记录，不会删除项目文件。确认移除？',
                    danger: true,
                    confirmText: '移除',
                    onConfirm: () => removeProject(p.id),
                  })
                }}
              >
                <button className="icon-btn" title="从列表移除">
                  <IconClose size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
