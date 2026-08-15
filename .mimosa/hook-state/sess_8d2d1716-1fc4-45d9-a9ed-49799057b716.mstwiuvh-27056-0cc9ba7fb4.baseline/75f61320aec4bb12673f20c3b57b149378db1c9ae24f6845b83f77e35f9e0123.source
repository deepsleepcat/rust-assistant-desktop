/**
 * 左侧「项目」面板：最近项目列表 + 打开/移除项目。
 */
import { useWorkspaceStore } from '../../stores/workspace'
import { formatRelativeTime } from '../../utils/conversation'
import { AppIcon } from '../../components/AppIcon'

export function WorkspaceSidebar() {
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const importModProject = useWorkspaceStore((s) => s.importModProject)
  const selectProject = useWorkspaceStore((s) => s.selectProject)
  const removeProject = useWorkspaceStore((s) => s.removeProject)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)

  return (
    <section className="panel" style={{ minHeight: 0 }}>
      <div className="panel-header">
        <AppIcon name="folder" size={13} />
        项目
        <span className="grow" />
        <button className="icon-btn" title="导入模组（文件夹或 rwmod/zip）" onClick={() => void importModProject()}>
          <AppIcon name="plus" size={14} />
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="empty-state" style={{ padding: '18px 14px' }}>
          <AppIcon name="folder" size={28} />
          <div>还没有项目</div>
          <button className="btn" onClick={() => void importModProject()}>
            导入模组
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
                <AppIcon name="folder" size={15} />
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
                  <AppIcon name="close" size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
