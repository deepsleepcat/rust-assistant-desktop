/**
 * 中间「编辑器」区域：
 * - 顶部多标签栏（脏标记、关闭、未保存确认）
 * - 无标签时显示欢迎页（最近项目 + 快捷操作）
 * - 有标签时显示简易代码编辑区（行号 + 文本编辑 + 保存）
 */
import { useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { formatRelativeTime } from '../../utils/conversation'
import { truncateMiddle } from '../../utils/paths'
import { FileTypeIcon, IconClose, IconSparkle } from '../../components/icons'
import { ConfirmBox } from '../../components/Modal'

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
        <div className="welcome-logo">R</div>
        <h1>
          <span className="rainbow-text">铁锈助手</span>
        </h1>
        <p className="subtitle">铁锈战争 · 模组开发工作台</p>
        <div className="welcome-actions">
          <button className="btn-rainbow" onClick={() => void openProject()}>
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
        <div className="welcome-footer">
          第一阶段 · 界面与项目骨架已就绪 — AI 对话与模组工具将在后续阶段接入
        </div>
      </div>
    </div>
  )
}

function EditorPane({ tabId }: { tabId: string }) {
  const tab = useWorkspaceStore((s) => s.openTabs.find((t) => t.id === tabId))
  const updateTabContent = useWorkspaceStore((s) => s.updateTabContent)
  const saveTab = useWorkspaceStore((s) => s.saveTab)
  const setEditorPos = useWorkspaceStore((s) => s.setEditorPos)
  const fontFamily = useWorkspaceStore((s) => s.settings.fontFamily)
  const fontSize = useWorkspaceStore((s) => s.settings.fontSize)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const lineCount = useMemo(() => {
    if (!tab) return 1
    return Math.max(1, tab.content.split('\n').length)
  }, [tab])

  if (!tab) return null

  const monoFont = fontFamily === 'mono' ? 'var(--font-mono)' : fontFamily === 'kaiti' ? 'KaiTi, "楷体", serif' : 'var(--font-mono)'

  const updatePos = () => {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart
    const before = el.value.slice(0, caret)
    const line = before.split('\n').length
    const lastNl = before.lastIndexOf('\n')
    const col = caret - lastNl
    setEditorPos({ line, col })
  }

  return (
    <div className="editor-workspace">
      <div className="editor-pathbar">
        <span style={{ color: 'var(--g-blue)', display: 'grid' }}>
          <IconSparkle size={13} />
        </span>
        <span className="path" title={tab.path}>
          {truncateMiddle(tab.path, 80)}
        </span>
        {tab.dirty && <span style={{ color: 'var(--g-red)', fontSize: 11.5 }}>● 未保存</span>}
        <button className="btn" style={{ padding: '3px 12px', fontSize: 12 }} onClick={() => void saveTab(tab.id)}>
          保存
        </button>
      </div>
      <div className="editor-body">
        <div className="editor-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
        </div>
        <textarea
          ref={textareaRef}
          className="editor-textarea"
          style={{ fontFamily: monoFont, fontSize }}
          value={tab.content}
          spellCheck={false}
          onChange={(e) => updateTabContent(tab.id, e.target.value)}
          onKeyUp={updatePos}
          onClick={updatePos}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
              e.preventDefault()
              void saveTab(tab.id)
            }
          }}
          placeholder="在此输入模组配置…"
        />
      </div>
    </div>
  )
}
