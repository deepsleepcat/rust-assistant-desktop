/**
 * 左侧固定导航（M33-社区）：工作台 / 社区 两个入口。
 * 固定在左栏顶部、不随「项目列表」内部折叠而消失；
 * 紧凑模式下左抽屉同样包含本导航（点击入口会顺手收起抽屉，让主区域显示切换后的工作区）。
 */
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon, type AppIconName } from '../../components/AppIcon'

interface NavItem {
  id: 'editor' | 'community'
  label: string
  icon: AppIconName
  title: string
}

const NAV_ITEMS: NavItem[] = [
  { id: 'editor', label: '工作台', icon: 'code', title: '编辑器与项目工作区' },
  { id: 'community', label: '社区', icon: 'share', title: '社区板块（当前为本地示例数据）' },
]

export function SurfaceNav() {
  const activeSurface = useWorkspaceStore((s) => s.activeSurface)
  const setActiveSurface = useWorkspaceStore((s) => s.setActiveSurface)
  const setDrawerSide = useWorkspaceStore((s) => s.setDrawerSide)

  const select = (id: 'editor' | 'community') => {
    setActiveSurface(id)
    // 紧凑模式下切换工作区后收起抽屉（切换动作本身已把目标工作区放到主区域）
    setDrawerSide(null)
  }

  return (
    <nav className="surface-nav" aria-label="工作区">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`surface-nav-item${activeSurface === item.id ? ' active' : ''}`}
          aria-current={activeSurface === item.id ? 'page' : undefined}
          title={item.title}
          onClick={() => select(item.id)}
        >
          <AppIcon name={item.icon} size={14} />
          {item.label}
        </button>
      ))}
    </nav>
  )
}
