/**
 * 中间「编辑器」区域：
 * - 顶部多标签栏（脏标记、关闭、未保存确认）
 * - 无标签时显示欢迎页（最近项目 + 快捷操作）
 * - 有标签时显示简易代码编辑区（行号 + 文本编辑 + 保存）
 */
import { useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { formatRelativeTime } from '../../utils/conversation'
import { truncateMiddle } from '../../utils/paths'
import { FileTypeIcon, IconClose } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { LogoR } from '../../components/LogoR'
import { ConfirmBox } from '../../components/Modal'
import { EditorMirror } from './EditorMirror'
import { ImageViewer } from './ImageViewer'
import { isPreviewableImage } from '../../utils/paths'
import { formatIni } from './iniFormatter'
import { scanSections } from './outline'

export function EditorArea() {
  const tabs = useWorkspaceStore((s) => s.openTabs)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)
  const setActiveTabId = useWorkspaceStore((s) => s.setActiveTabId)

  return (
    <section className="editor-panel panel" style={{ flex: 1, minWidth: 0 }}>
      {tabs.length > 0 && (
        <div className="tabbar" role="tablist">
          {tabs.map((tab) => (
            <EditorTabChip key={tab.id} tabId={tab.id} active={tab.id === activeTabId} onActivate={() => setActiveTabId(tab.id)} />
          ))}
        </div>
      )}
      {tabs.length === 0 ? <WelcomeView /> : <EditorPane tabId={activeTabId ?? tabs[0].id} />}
    </section>
  )
}

function EditorTabChip({ tabId, active, onActivate }: { tabId: string; active: boolean; onActivate: () => void }) {
  const tab = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === tabId))
  const closeTab = useWorkspaceStore((s) => s.closeTab)
  const saveTab = useWorkspaceStore((s) => s.saveTab)
  const [pendingClose, setPendingClose] = useState(false)

  if (!tab) return null

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (tab.dirty) {
      setPendingClose(true)
      return
    }
    closeTab(tab.id)
  }

  return (
    <>
      <button
        className={`tab${active ? ' active' : ''}`}
        role="tab"
        aria-selected={active}
        onClick={onActivate}
        title={tab.path}
      >
        <FileTypeIcon name={tab.name} size={13} />
        <span className="tab-name">{tab.name}</span>
        {tab.dirty && <span className="dirty-dot" title="有未保存的修改" />}
        <span className="icon-btn tab-close" onClick={handleClose} role="button" aria-label="关闭标签页">
          <IconClose size={12} />
        </span>
      </button>
      {pendingClose && (
        <ConfirmBox
          title="有未保存的修改"
          message={`「${tab.name}」的修改尚未保存。`}
          danger
          confirmText="直接关闭"
          cancelText="取消"
          onCancel={() => setPendingClose(false)}
          onConfirm={() => {
            setPendingClose(false)
            closeTab(tab.id)
          }}
          extra={
            <button
              className="btn primary"
              onClick={() => {
                setPendingClose(false)
                void saveTab(tab.id).then(() => closeTab(tab.id))
              }}
            >
              保存并关闭
            </button>
          }
        />
      )}
    </>
  )
}

function WelcomeView() {
  const projects = useWorkspaceStore((s) => s.projects)
  const selectProject = useWorkspaceStore((s) => s.selectProject)
  const openProject = useWorkspaceStore((s) => s.openProject)
  const createConversation = useWorkspaceStore((s) => s.createConversation)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)

  return (
    <div className="welcome">
      <div className="stagger" style={{ display: 'contents' }}>
        <div className="welcome-logo"><LogoR size="welcome" /></div>
        <h1>
          <span>铁锈助手</span>
        </h1>
        <p className="subtitle">铁锈战争 · 模组开发工作台</p>
        <div className="welcome-actions">
          <button className="btn" onClick={() => void openProject()}>
            打开项目
          </button>
          <button className="btn" onClick={() => createConversation()}>
            新建对话
          </button>
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            外观设置
          </button>
        </div>
        {projects.length > 0 && (
          <div className="welcome-recent">
            <div className="label">最近项目</div>
            {projects.slice(0, 4).map((p) => (
              <div key={p.id} className="recent-card" onClick={() => void selectProject(p.id)}>
                <FileTypeIcon name={p.name} size={16} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="rc-name">{p.name}</div>
                  <div className="rc-path">{truncateMiddle(p.rootPath, 48)}</div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{formatRelativeTime(p.lastOpenedAt)}</span>
              </div>
            ))}
          </div>
        )}
        <div className="welcome-footer">打开一个模组项目，开始 AI 辅助开发</div>
      </div>
    </div>
  )
}

function EditorPane({ tabId }: { tabId: string }) {
  const tab = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === tabId))
  const updateTabContent = useWorkspaceStore((s) => s.updateTabContent)
  const saveTab = useWorkspaceStore((s) => s.saveTab)
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const toggleTranslation = useWorkspaceStore((s) => s.toggleTranslation)
  const setEditorPos = useWorkspaceStore((s) => s.setEditorPos)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const fontFamily = useWorkspaceStore((s) => s.settings.fontFamily)
  const fontSize = useWorkspaceStore((s) => s.settings.fontSize)

  if (!tab) return null
  if (isPreviewableImage(tab.path) && project) {
    return <ImageViewer path={tab.path} rootPath={project.rootPath} />
  }

  const sections = scanSections(tab.content)
  const formatted = formatIni(tab.content)

  return (
    <div className="editor-workspace">
      <div className="editor-pathbar">
        <span style={{ color: 'var(--text-secondary)', display: 'grid' }}>
          <AppIcon name="file" size={13} />
        </span>
        <span className="path" title={tab.path}>
          {truncateMiddle(tab.path, 80)}
        </span>
        <button
          className={tab.translationEnabled ? 'btn primary' : 'btn'}
          style={{ padding: '2px 10px', fontSize: 11.5 }}
          onClick={() => toggleTranslation(tab.id)}
          title="切换中文显示层：显示中文，保存时自动转回英文"
        >
          {tab.translationEnabled ? '中文模式' : '英文模式'}
        </button>
        {tab.externalChanged && <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>⚠ 文件已被外部修改</span>}
        {tab.dirty && <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>● 未保存</span>}
        <button className="btn" style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => useWorkspaceStore.getState().updateTabContent(tab.id, formatted)} title="Ctrl+Shift+F">
          格式化
        </button>
        <button className={outlineOpen ? 'btn primary' : 'btn'} style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => setOutlineOpen((open) => !open)}>
          大纲 ({sections.length})
        </button>
        <button className="btn" style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => void saveTab(tab.id)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="save" size={12} />保存</span>
        </button>
      </div>
      {outlineOpen && sections.length > 0 && (
        <div className="editor-outline">
          {sections.map((section) => (
            <button key={`${section.line}-${section.name}`} className="editor-outline-item" onClick={() => setEditorPos({ line: section.line, col: 1 })}>
              <span>[{section.name}]</span><small>第 {section.line} 行</small>
            </button>
          ))}
        </div>
      )}
      <div className="editor-body">
        <EditorMirror
          value={tab.content}
          onChange={(content) => updateTabContent(tab.id, content)}
          onCursor={(line, col) => setEditorPos({ line, col })}
          onSave={() => void saveTab(tab.id)}
          fontFamily={fontFamily}
          fontSize={fontSize}
        />
      </div>
    </div>
  )
}
