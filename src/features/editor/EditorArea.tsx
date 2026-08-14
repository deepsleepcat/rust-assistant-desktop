/**
 * 中间「编辑器」区域：
 * - 顶部多标签栏（脏标记、关闭、未保存确认）
 * - 无标签时显示欢迎页（最近项目 + 快捷操作）
 * - 有标签时显示简易代码编辑区（行号 + 文本编辑 + 保存）
 */
import { useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { TurretEditorModal } from '../modTools/TurretEditorModal'
import { formatRelativeTime } from '../../utils/conversation'
import { truncateMiddle } from '../../utils/paths'
import { FileTypeIcon, IconClose } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { LogoR } from '../../components/LogoR'
import { ConfirmBox, PromptModal } from '../../components/Modal'
import { EditorMirror } from './EditorMirror'
import { ImageViewer } from './ImageViewer'
import { AudioViewer } from './AudioViewer'
import { isPreviewableAudio, isPreviewableImage } from '../../utils/paths'
import { formatIni } from './iniFormatter'
import { scanSections } from './outline'

export function EditorArea() {
  const tabs = useWorkspaceStore((s) => s.openTabs)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)
  const setActiveTabId = useWorkspaceStore((s) => s.setActiveTabId)
  // 炮塔编辑器弹窗（M12：可视化调整 [turret_N] 坐标），状态在 store（编辑器按钮跨组件调用）
  const turretEditorOpen = useWorkspaceStore((s) => s.turretEditorOpen)

  return (
    <section className="editor-panel panel" style={{ flex: 1, minWidth: 0 }}>
      {turretEditorOpen && <TurretEditorModal onClose={() => useWorkspaceStore.getState().setTurretEditorOpen(false)} />}
      {tabs.length > 0 && (
        <div
          className="tabbar"
          role="tablist"
          aria-label="打开的文件"
          onKeyDown={(e) => {
            // 方向键在标签间移动（ARIA tabs 模式）：←/→ 切换相邻标签
            const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
            if (dir === 0) return
            const idx = tabs.findIndex((t) => t.id === activeTabId)
            if (idx < 0) return
            e.preventDefault()
            const next = tabs[Math.min(Math.max(idx + dir, 0), tabs.length - 1)]
            if (next) setActiveTabId(next.id)
          }}
        >
          {tabs.map((tab) => (
            <EditorTabChip key={tab.id} tabId={tab.id} active={tab.id === activeTabId} onActivate={() => setActiveTabId(tab.id)} />
          ))}
        </div>
      )}
      {tabs.length === 0 ? (
        <WelcomeView />
      ) : (
        // key=tabId：每个标签独立挂载编辑器实例，撤销/重做历史互不串扰
        // （共享单实例时，跨标签 Ctrl+Z 会撤销「标签切换替换」而把 A 的内容写进 B，损坏数据）
        <EditorPane key={activeTabId ?? tabs[0].id} tabId={activeTabId ?? tabs[0].id} />
      )}
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
      {/* div+role=tab（不是 button 嵌 button）：关闭按钮是独立 button，
          键盘可聚焦、读屏可识别——此前 button 内嵌 span role=button 属非法嵌套 */}
      <div
        className={`tab${active ? ' active' : ''}`}
        role="tab"
        aria-selected={active}
        aria-controls={active ? 'editor-pane' : undefined}
        tabIndex={active ? 0 : -1}
        onClick={onActivate}
        onKeyDown={(e) => {
          // 只在标签本身聚焦时处理 Enter/Space：关闭按钮（子元素）的按键
          // 冒泡到这里不能吞掉（否则键盘无法关闭标签）
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate()
          }
        }}
        title={tab.path}
      >
        <FileTypeIcon name={tab.name} size={13} />
        <span className="tab-name">{tab.name}</span>
        {tab.dirty && <span className="dirty-dot" title="有未保存的修改" />}
        <button className="icon-btn tab-close" onClick={handleClose} aria-label="关闭标签页">
          <IconClose size={12} />
        </button>
      </div>
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
                // 保存成功才关闭：保存被外部修改拦截或失败时保留标签，防止丢未保存修改
                void saveTab(tab.id).then((ok) => {
                  if (ok) closeTab(tab.id)
                })
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
  const importModProject = useWorkspaceStore((s) => s.importModProject)
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
          <button className="btn" onClick={() => void importModProject()}>
            导入模组
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
            <div className="label">最近模组</div>
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
  // 保存为模板：弹窗输入模板名（null 表示关闭）
  const [templateName, setTemplateName] = useState<string | null>(null)
  // 文件被外部修改后「重新加载」的确认（有未保存修改时才需要）
  const [reloadConfirm, setReloadConfirm] = useState(false)
  // 大纲跳转请求：{ line, seq }，seq 递增触发 EditorMirror 定位
  const [jumpRequest, setJumpRequest] = useState<{ line: number; seq: number } | null>(null)
  const fontFamily = useWorkspaceStore((s) => s.settings.fontFamily)
  const fontSize = useWorkspaceStore((s) => s.settings.fontSize)

  // 大纲/格式化结果按内容缓存：光标移动等重渲染不再全量重算（大文件每键 O(全文) 会卡）
  const tabContent = tab?.content ?? ''
  const sections = useMemo(() => scanSections(tabContent), [tabContent])
  const formatted = useMemo(() => formatIni(tabContent), [tabContent])

  if (!tab) return null
  if (isPreviewableImage(tab.path) && project) {
    return <ImageViewer path={tab.path} rootPath={project.rootPath} />
  }
  // M6.5：音频文件走播放器（不再当文本打开显示乱码）
  if (isPreviewableAudio(tab.path) && project) {
    return <AudioViewer rootPath={project.rootPath} path={tab.path} />
  }

  return (
    <div className="editor-workspace" id="editor-pane" role="tabpanel">
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
        {tab.externalChanged && (
          <>
            <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>⚠ 文件已被外部修改</span>
            <button
              className="btn"
              style={{ padding: '2px 10px', fontSize: 11.5 }}
              title="丢弃本地修改，重新读取磁盘上的最新内容"
              onClick={() => {
                // 有未保存修改时先确认，避免误丢编辑
                if (tab.dirty) setReloadConfirm(true)
                else void useWorkspaceStore.getState().reloadTab(tab.id)
              }}
            >
              重新加载
            </button>
          </>
        )}
        {tab.dirty && <span style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>● 未保存</span>}
        <button className="btn" style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => useWorkspaceStore.getState().updateTabContent(tab.id, formatted)} title="Ctrl+Shift+F">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="text" size={12} />格式化</span>
        </button>
        <button className={outlineOpen ? 'btn primary' : 'btn'} style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => setOutlineOpen((open) => !open)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="expand" size={12} />大纲 ({sections.length})</span>
        </button>
        <button className="btn" style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => useWorkspaceStore.getState().setCodeTableOpen(true)} title="浏览代码表：字段说明 / 值类型 / 所属节">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="document" size={12} />代码表</span>
        </button>
        {/\.(ini|template)$/i.test(tab.path) && /^\s*\[(core|核心)\]\s*$/m.test(tab.content) && (
          <button className="btn" style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => setTemplateName(tab.name.replace(/\.(ini|template)$/i, ''))} title="把当前单位文件保存为模板，可在「新建单位」中复用">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="box" size={12} />存为模板</span>
          </button>
        )}
        {/\.ini$/i.test(tab.path) && (/^\s*\[turret_\d+\]\s*(?:#.*)?$/im.test(tab.content) || /^\s*\[炮塔_\d+\]\s*(?:#.*)?$/im.test(tab.content)) && (
          <button className="btn" style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => useWorkspaceStore.getState().setTurretEditorOpen(true)} title="可视化编辑 [turret_N] 炮塔坐标">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="tower" size={12} />炮塔</span>
          </button>
        )}
        <button className="btn" style={{ padding: '2px 10px', fontSize: 11.5 }} onClick={() => void saveTab(tab.id)}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><AppIcon name="save" size={12} />保存</span>
        </button>
      </div>
      {outlineOpen && sections.length > 0 && (
        <div className="editor-outline">
          {sections.map((section) => (
            <button
              key={`${section.line}-${section.name}`}
              className="editor-outline-item"
              onClick={() => {
                // 大纲跳转：更新状态栏位置 + 触发编辑器滚动定位（seq 递增保证重复点击同节也生效）
                setEditorPos({ line: section.line, col: 1 })
                setJumpRequest((prev) => ({ line: section.line, seq: (prev?.seq ?? 0) + 1 }))
              }}
            >
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
          chineseMode={tab.translationEnabled}
          translationMap={tab.translationMap}
          jumpTo={jumpRequest}
        />
      </div>
      {templateName !== null && (
        <PromptModal
          title="保存为模板"
          initialValue={templateName}
          placeholder="模板名称，如 我的坦克模板"
          confirmText="保存"
          onSubmit={(name) => {
            void useWorkspaceStore.getState().saveActiveFileAsTemplate(name)
            setTemplateName(null)
          }}
          onClose={() => setTemplateName(null)}
        />
      )}
      {reloadConfirm && (
        <ConfirmBox
          title="重新加载文件"
          message={`「${tab.name}」将被磁盘上的最新内容替换，未保存的修改会丢失。`}
          danger
          confirmText="重新加载"
          cancelText="取消"
          onCancel={() => setReloadConfirm(false)}
          onConfirm={() => {
            setReloadConfirm(false)
            void useWorkspaceStore.getState().reloadTab(tab.id)
          }}
        />
      )}
    </div>
  )
}
