/**
 * 右侧面板（编辑器右栏）：用编辑器同款的标签条承载多个面板。
 *
 * 目前两个页签：Git（有活动项目时出现）与代码表；点标签切换、点 × 关闭该面板，
 * 两个都关掉时右栏自动收起。页签样式复用 `.tabbar` / `.tab`，与文件标签一致。
 * 活动页签存 store（rightPanelTab），本组件只做派生渲染，不在 effect 里 setState。
 */
import { AppIcon } from '../../components/AppIcon'
import { GitPanel } from '../git/GitPanel'
import { CodeTablePanel } from '../editor/CodeTablePanel'

type RightTab = 'git' | 'codeTable'

interface Props {
  /** Git 页签是否存在（有活动项目且 Git 面板开启） */
  gitOpen: boolean
  /** 代码表页签是否存在 */
  codeTableOpen: boolean
  /** store 里记录的活动页签 */
  activeTab: RightTab | null
  projectId: string | null
  onActivateTab: (tab: RightTab) => void
  onCloseGit: () => void
  onCloseCodeTable: () => void
}

const TAB_META: Record<RightTab, { label: string; icon: 'code' | 'document' }> = {
  git: { label: 'Git', icon: 'code' },
  codeTable: { label: '代码表', icon: 'document' },
}

export function RightDock({ gitOpen, codeTableOpen, activeTab, projectId, onActivateTab, onCloseGit, onCloseCodeTable }: Props) {
  const tabs: RightTab[] = []
  if (gitOpen) tabs.push('git')
  if (codeTableOpen) tabs.push('codeTable')
  if (tabs.length === 0) return null
  // 活动页签不可用（被关闭/项目切换）时回退到第一个可用页签
  const current: RightTab = activeTab && tabs.includes(activeTab) ? activeTab : tabs[0]

  const close = (tab: RightTab) => {
    if (tab === 'git') onCloseGit()
    else onCloseCodeTable()
  }

  return (
    <section className="right-dock" aria-label="右侧面板">
      <div className="tabbar right-dock-tabs" role="tablist" aria-label="右侧面板标签">
        {tabs.map((tab) => (
          <div
            key={tab}
            className={`tab${current === tab ? ' active' : ''}`}
            role="tab"
            aria-selected={current === tab}
            tabIndex={current === tab ? 0 : -1}
            title={TAB_META[tab].label}
            onClick={() => onActivateTab(tab)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onActivateTab(tab)
              }
            }}
          >
            <AppIcon name={TAB_META[tab].icon} size={13} />
            <span className="tab-name">{TAB_META[tab].label}</span>
            <button
              type="button"
              className="icon-btn tab-close"
              aria-label={`关闭${TAB_META[tab].label}`}
              title={`关闭${TAB_META[tab].label}`}
              onClick={(e) => {
                e.stopPropagation()
                close(tab)
              }}
            >
              <AppIcon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="right-dock-body">
        {current === 'git' && gitOpen && <GitPanel key={projectId ?? 'none'} />}
        {current === 'codeTable' && codeTableOpen && <CodeTablePanel onClose={onCloseCodeTable} />}
      </div>
    </section>
  )
}
