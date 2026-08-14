/**
 * 右侧「AI 对话」面板：
 * - 一个项目可创建多个对话，各自独立
 * - 支持：创建 / 切换 / 重命名 / 归档 / 删除
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore, useSortedConversations } from '../../stores/workspace'
import { formatRelativeTime } from '../../utils/conversation'
import { IconArchive } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { Modal, PromptModal } from '../../components/Modal'
import type { ToolEvent } from '../../types/domain'
import type { AiHistoryMeta } from '../../types/ai'

function renderAssistantText(text: string) {
  // 围栏代码块渲染（注意：[\s\S] 是「任意字符」，不能写成 [\\s\\S]——双重转义会匹配字面反斜杠导致围栏永不命中）
  const parts = text.split(/(```[\s\S]*?```)/g)
  return parts.map((part, index) =>
    part.startsWith('```') ? <pre key={index} className="assistant-code">{part.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')}</pre> : <span key={index}>{part}</span>,
  )
}

export function ConversationPanel() {
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const activeConversationId = useWorkspaceStore((s) => s.activeConversationId)
  const createConversation = useWorkspaceStore((s) => s.createConversation)
  const conversations = useSortedConversations(project?.id ?? null)

  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)

  const active = conversations.find((c) => c.id === activeConversationId) ?? null
  const activeList = conversations.filter((c) => !c.archived)
  const archivedList = conversations.filter((c) => c.archived)

  return (
    <section className="panel" style={{ minWidth: 0 }}>
      <div className="panel-header">
        <AppIcon name="tools" size={13} />
        AI 对话
        <span className="grow" />
        <button className="icon-btn" title="新建对话" disabled={!project} onClick={() => createConversation()}>
          <AppIcon name="plus" size={14} />
        </button>
      </div>

      {!project ? (
        <div className="empty-state">
          <AppIcon name="tools" size={28} />
          <div>打开项目后即可创建 AI 对话</div>
        </div>
      ) : conversations.length === 0 ? (
        <div className="empty-state" style={{ padding: '20px 14px' }}>
          <AppIcon name="file" size={28} />
          <div>还没有对话</div>
          <button className="btn" onClick={() => createConversation()}>
            新建对话
          </button>
        </div>
      ) : (
        <div className="conversation-list">
          {activeList.map((c) => (
            <ConversationItem key={c.id} id={c.id} />
          ))}
          {archivedList.length > 0 && <div className="conv-section-label">已归档</div>}
          {archivedList.map((c) => (
            <ConversationItem key={c.id} id={c.id} />
          ))}
        </div>
      )}

      {active ? (
        <ConversationView
          id={active.id}
          title={active.title}
          onRename={() => setRenaming({ id: active.id, title: active.title })}
        />
      ) : null}

      {renaming && (
        <PromptModal
          title="重命名对话"
          initialValue={renaming.title}
          confirmText="重命名"
          onSubmit={(title) => {
            useWorkspaceStore.getState().renameConversation(renaming.id, title)
            setRenaming(null)
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </section>
  )
}

function ConversationItem({ id }: { id: string }) {
  const conv = useWorkspaceStore((s) => s.conversations.find((c) => c.id === id))
  const activeConversationId = useWorkspaceStore((s) => s.activeConversationId)
  const selectConversation = useWorkspaceStore((s) => s.selectConversation)
  const toggleArchive = useWorkspaceStore((s) => s.toggleArchiveConversation)
  const deleteConversation = useWorkspaceStore((s) => s.deleteConversation)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)
  const [renaming, setRenaming] = useState(false)

  if (!conv) return null

  return (
    <>
      <div
        className={`conv-item${conv.id === activeConversationId ? ' active' : ''}${conv.archived ? ' archived' : ''}`}
        onClick={() => selectConversation(conv.id)}
      >
        <AppIcon name="file" size={14} />
        <span className="conv-info">
          <span className="conv-title">{conv.title}</span>
          <span className="conv-time">{formatRelativeTime(conv.updatedAt)}</span>
        </span>
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="重命名" onClick={() => setRenaming(true)}>
            <AppIcon name="rename" size={12} />
          </button>
          <button className="icon-btn" title={conv.archived ? '取消归档' : '归档'} onClick={() => toggleArchive(conv.id)}>
            <IconArchive size={12} />
          </button>
          <button
            className="icon-btn"
            title="删除对话"
            onClick={() =>
              requestConfirm({
                title: '删除对话',
                message: `确定删除「${conv.title}」吗？对话记录将被永久删除。`,
                danger: true,
                confirmText: '删除',
                onConfirm: () => deleteConversation(conv.id),
              })
            }
          >
            <AppIcon name="delete" size={12} />
          </button>
        </span>
      </div>
      {renaming && (
        <PromptModal
          title="重命名对话"
          initialValue={conv.title}
          confirmText="重命名"
          onSubmit={(title) => {
            useWorkspaceStore.getState().renameConversation(conv.id, title)
            setRenaming(false)
          }}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  )
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    listProject: '查看项目结构',
    readFile: '读取文件',
    searchInProject: '搜索项目',
    codeTable: '查询代码表',
    sectionOutline: '查看节大纲',
    writeFile: '写入文件',
  }
  return labels[name] ?? name
}

function ConversationView({ id, title, onRename }: { id: string; title: string; onRename: () => void }) {
  const conversation = useWorkspaceStore((s) => s.conversations.find((c) => c.id === id))
  const messages = useMemo(() => conversation?.messages ?? [], [conversation])
  const toolEvents = useMemo(() => conversation?.toolEvents ?? [], [conversation])
  // 时间线：消息与工具事件按时间穿插渲染（工具卡片不该堆在消息上方）
  const timeline = useMemo(() => {
    const items: Array<
      | { key: string; at: number; kind: 'msg'; msg: (typeof messages)[number] }
      | { key: string; at: number; kind: 'tool'; tool: (typeof toolEvents)[number] }
    > = [
      ...messages.map((m) => ({ key: `m-${m.id}`, at: m.createdAt, kind: 'msg' as const, msg: m })),
      ...toolEvents.map((t) => ({ key: `t-${t.id}`, at: t.createdAt, kind: 'tool' as const, tool: t })),
    ]
    items.sort((a, b) => a.at - b.at)
    return items
  }, [messages, toolEvents])
  const sendAiMessage = useWorkspaceStore((s) => s.sendAiMessage)
  const aiStreaming = useWorkspaceStore((s) => s.aiStreamingConversationId === id)
  const projectRootPath = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId)?.rootPath ?? '')
  // P3：全局流锁（任何对话正在流式回复时都不能发送，与 store 的全局锁一致——
  // 否则切到另一个对话发送会清空输入框却被 store 拒绝，草稿丢失）
  const anyStreaming = useWorkspaceStore((s) => s.aiStreamingConversationId !== null)
  const aiSettings = useWorkspaceStore((s) => s.settings.ai)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  // 低-4：草稿按对话隔离——切换对话时输入框显示该对话上次的草稿，防止误发到别的对话
  const [input, setInput] = useState('')
  const draftsRef = useRef<Map<string, string>>(new Map())
  const previousIdRef = useRef(id)
  const messagesRef = useRef<HTMLDivElement>(null)

  // 社区后端为预留服务（主进程也返回「即将上线」）：选中时输入区明确提示怎么恢复
  const communitySelected = aiSettings.provider === 'community'
  const providerReady = aiSettings.provider === 'deepseek' ? aiSettings.deepseekApiKey.length > 0 : false

  // 新消息自动滚动到底部：仅当用户本来就停在底部附近时才跟随，
  // 否则向上阅读历史时每个流式增量都会把人拽回底部（打断阅读）
  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [messages])

  // 对话切换：把「切换前对话」的输入存进旧 id 的草稿（不能用新 id 存旧输入，否则串稿），
  // 再取回新对话的草稿
  useEffect(() => {
    const prevId = previousIdRef.current
    previousIdRef.current = id
    if (prevId === id) return
    if (input.trim()) draftsRef.current.set(prevId, input)
    setInput(draftsRef.current.get(id) ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在对话 id 变化时切换草稿
  }, [id])

  const send = () => {
    const text = input.trim()
    if (!text || !providerReady || aiStreaming || anyStreaming) return
    setInput('')
    draftsRef.current.delete(id)
    void sendAiMessage(id, text)
  }

  return (
    <div className="conversation-view">
      <div className="conv-view-header">
        <AppIcon name="tools" size={13} />
        <span className="title">{title}</span>
        <button className="icon-btn" title="重命名对话" onClick={onRename}>
          <AppIcon name="rename" size={13} />
        </button>
      </div>

      <div className="conv-messages" ref={messagesRef}>
        {messages.length === 0 ? (
          <div className="conv-empty">
            <div>这里是「{title}」的对话空间</div>
            <div className="stage-hint">
              {providerReady
                ? '输入你的模组需求，AI 会帮你分析、编写和修改铁锈战争代码。'
                : 'AI 尚未配置：请先在 设置 → AI 中填写 DeepSeek API Key，然后回来开始对话。'}
            </div>
            {!providerReady && (
              <button className="btn" style={{ marginTop: 6 }} onClick={() => setSettingsOpen(true)}>
                去配置 AI
              </button>
            )}
          </div>
        ) : (
          timeline.map((item) =>
            item.kind === 'tool' ? (
              <ToolCard key={item.key} tool={item.tool} rootPath={projectRootPath} />
            ) : (
              <div key={item.key} className={`msg msg-${item.msg.role}`}>
                {item.msg.role === 'assistant' && item.msg.reasoning && (
                  <details className="msg-reasoning" open={item.msg.content === ''}>
                    <summary>{item.msg.content === '' ? 'AI 思考中…' : '思考过程'}</summary>
                    <div className="msg-reasoning-body">{item.msg.reasoning}</div>
                  </details>
                )}
                <div className="msg-bubble">
                  {item.msg.role === 'assistant' ? renderAssistantText(item.msg.content) : item.msg.content}
                  {/* 仅流式进行中且内容为空时显示「正在思考…」：done 后为空内容不再挂着占位符 */}
                  {item.msg.role === 'assistant' && item.msg.content === '' && !item.msg.reasoning && aiStreaming && <span className="msg-streaming">正在思考…</span>}
                </div>
              </div>
            ),
          )
        )}
      </div>

      <div className="conv-input-area">
        <textarea
          className="conv-input"
          value={input}
          // 低-5：textarea 不禁用（流式中允许起草下一条；发送守卫已覆盖全部流式场景）
          disabled={!providerReady}
          placeholder={providerReady ? '输入你的模组需求…（如：帮我做一个能隐身的侦察单位）' : communitySelected ? '社区后端即将上线，请先在设置中切换回 DeepSeek' : '请先在设置中配置 AI'}
          aria-label="对话输入框"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // 低-2：IME 组合输入（拼音/五笔候选确认）的 Enter 不触发发送
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="conv-input-row">
          <span className="hint">
            {aiStreaming
              ? 'AI 正在回复…'
              : anyStreaming
                ? 'AI 正在其他对话回复，请稍候'
                : !providerReady
                  ? (communitySelected ? '社区后端即将上线，请在设置中切换回 DeepSeek' : '请先在设置中配置 AI')
                  : 'Enter 发送 · Shift+Enter 换行'}
          </span>
          <button className="btn" disabled={!providerReady || aiStreaming || anyStreaming || !input.trim()} onClick={send}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <AppIcon name="add" size={13} />
              {aiStreaming ? '回复中' : anyStreaming ? '等待中' : '发送'}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

/** 工具卡片：writeFile 成功后提供「撤销此修改 / 修改历史」入口（任务 2），
 * 质检发现问题时下方展示可操作清单（任务 3）。 */
function ToolCard({ tool, rootPath }: { tool: ToolEvent; rootPath: string }) {
  const aiRestoreFileVersion = useWorkspaceStore((s) => s.aiRestoreFileVersion)
  const [historyOpen, setHistoryOpen] = useState(false)
  const done = tool.type === 'tool_end'
  const isWrite = done && tool.name === 'writeFile'
  return (
    <>
      <div className={`tool-card${done && !tool.ok ? ' tool-card-error' : ''}`}>
        {!done ? (
          <>
            <AppIcon name="tools" size={13} className="tool-icon" />
            <span>正在{toolLabel(tool.name)}…</span>
            {typeof tool.args?.path === 'string' && <code className="tool-path">{tool.args.path}</code>}
          </>
        ) : (
          <>
            <AppIcon name={tool.ok ? 'check' : 'cross'} size={13} className="tool-icon" />
            <span>{tool.summary ?? toolLabel(tool.name)}</span>
          </>
        )}
        {isWrite && tool.ok && (
          <span className="tool-card-actions">
            {tool.path && tool.snapshotId && (
              <button
                className="btn"
                style={{ padding: '1px 8px', fontSize: 11 }}
                title="撤销这次写入，把文件恢复到写盘前的版本"
                onClick={() => void aiRestoreFileVersion(tool.path!, tool.snapshotId!)}
              >
                <AppIcon name="undo" size={11} /> 撤销此修改
              </button>
            )}
            {tool.path && tool.snapshotSkipped && (
              <span className="tool-snapshot-skipped" title="文件过大等原因未存档，本次修改不可撤销">
                ⚠ 本次修改不可撤销
              </span>
            )}
            {tool.path && (
              <button
                className="btn"
                style={{ padding: '1px 8px', fontSize: 11 }}
                title="查看该文件的历史版本，可恢复到任意版本"
                onClick={() => setHistoryOpen(true)}
              >
                <AppIcon name="clock" size={11} /> 修改历史
              </button>
            )}
          </span>
        )}
      </div>
      {isWrite && tool.ok && tool.lint && tool.lint.length > 0 && <LintBox tool={tool} />}
      {historyOpen && tool.path && <HistoryModal rootPath={rootPath} relPath={tool.path} onClose={() => setHistoryOpen(false)} />}
    </>
  )
}

/** 质检结果清单：默认收起；展开后每条含 行号 + 原因 + 修复建议 + 「定位」跳转 */
function LintBox({ tool }: { tool: ToolEvent }) {
  const jumpToFileLine = useWorkspaceStore((s) => s.jumpToFileLine)
  const [open, setOpen] = useState(false)
  const items = tool.lint ?? []
  const errors = items.filter((l) => l.severity === 'error').length
  return (
    <div className={`lint-box${errors > 0 ? ' has-error' : ''}`}>
      <button className="lint-toggle" onClick={() => setOpen(!open)} title={open ? '收起质检结果' : '展开质检结果'}>
        <span className="lint-toggle-mark">{open ? '▾' : '▸'}</span>
        <span className="lint-toggle-title">
          质检发现 {items.length} 个问题{errors > 0 ? `（${errors} 个错误）` : ''}
          {tool.path && <code className="tool-path">{tool.path}</code>}
        </span>
      </button>
      {open && (
        <ul className="lint-list">
          {items.map((item, i) => (
            <li key={i} className={`lint-item lint-${item.severity}`}>
              <div className="lint-msg">
                {item.line > 0 && <span className="lint-line">第 {item.line} 行</span>}
                {item.message}
              </div>
              {item.suggestion && <div className="lint-suggestion">建议：{item.suggestion}</div>}
              {tool.path && item.line > 0 && (
                <button
                  className="btn"
                  style={{ padding: '1px 8px', fontSize: 11, alignSelf: 'flex-start' }}
                  title={`打开 ${tool.path} 并跳到第 ${item.line} 行`}
                  onClick={() => jumpToFileLine(tool.path!, item.line)}
                >
                  <AppIcon name="search" size={11} /> 定位
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 修改历史弹窗（任务 2）：列出该文件的历史版本（时间/大小），可恢复到任意版本 */
function HistoryModal({ rootPath, relPath, onClose }: { rootPath: string; relPath: string; onClose: () => void }) {
  const aiRestoreFileVersion = useWorkspaceStore((s) => s.aiRestoreFileVersion)
  const [entries, setEntries] = useState<AiHistoryMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const { getBridge } = await import('../../services/bridge')
        const list = await getBridge().ai.historyList(rootPath, relPath)
        if (alive) setEntries(list)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      alive = false
    }
  }, [rootPath, relPath])
  return (
    <Modal title={`修改历史 · ${relPath}`} onClose={onClose}>
      {error ? (
        <p style={{ color: 'var(--danger)', fontSize: 13 }}>加载失败：{error}</p>
      ) : entries === null ? (
        <p style={{ color: 'var(--text-2)', fontSize: 13 }}>加载中…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
          暂无历史版本。AI 每次写文件前会自动保存前一版本（每文件最多 20 份，超出上限的旧版本会被清理），供你随时撤销。
        </p>
      ) : (
        <ul className="history-list">
          {entries.map((e) => (
            <li key={e.id} className="history-item">
              <span className="history-time">{new Date(e.at).toLocaleString()}</span>
              <span className="history-size">{formatSize(e.size)}</span>
              <span className="grow" />
              <button
                className="btn"
                style={{ padding: '2px 10px', fontSize: 12 }}
                onClick={() => {
                  void aiRestoreFileVersion(relPath, e.id)
                  onClose()
                }}
              >
                恢复到此时
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
