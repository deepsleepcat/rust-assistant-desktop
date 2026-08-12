/**
 * 右侧「AI 对话」面板：
 * - 一个项目可创建多个对话，各自独立
 * - 第一阶段不接入 AI：输入框禁用、发送按钮置灰，但对话数据已按最终形态存储
 * - 支持：创建 / 切换 / 重命名 / 归档 / 删除
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore, useSortedConversations } from '../../stores/workspace'
import { formatRelativeTime } from '../../utils/conversation'
import { IconArchive } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { PromptModal } from '../../components/Modal'
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
  const sendAiMessage = useWorkspaceStore((s) => s.sendAiMessage)
  const aiStreaming = useWorkspaceStore((s) => s.aiStreamingConversationId === id)
  const aiSettings = useWorkspaceStore((s) => s.settings.ai)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const pendingApproval = useWorkspaceStore((s) => s.pendingApproval)
  const respondApproval = useWorkspaceStore((s) => s.respondApproval)
  const [input, setInput] = useState('')
  const messagesRef = useRef<HTMLDivElement>(null)

  const providerReady = aiSettings.provider === 'deepseek' ? aiSettings.deepseekApiKey.length > 0 : false

  // 新消息自动滚动到底部
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = () => {
    const text = input.trim()
    if (!text || !providerReady || aiStreaming) return
    setInput('')
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
          <>
            {toolEvents.map((t) => (
              <div key={t.id} className={`tool-card${t.type === 'tool_end' && !t.ok ? ' tool-card-error' : ''}`}>
                {t.type === 'tool_start' ? (
                  <>
                    <span className="tool-icon">🔧</span>
                    <span>正在{toolLabel(t.name)}…</span>
                  </>
                ) : (
                  <>
                    <span className="tool-icon">{t.ok ? '✅' : '❌'}</span>
                    <span>{t.summary ?? toolLabel(t.name)}</span>
                  </>
                )}
              </div>
            ))}
            {messages.map((m) => (
              <div key={m.id} className={`msg msg-${m.role}`}>
                <div className="msg-bubble">
                  {m.content}
                  {m.role === 'assistant' && m.content === '' && <span className="msg-streaming">正在思考…</span>}
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {pendingApproval && (
        <div className="modal-overlay">
          <div className="modal-card confirm-card">
            <div className="modal-header">AI 请求修改文件</div>
            <div className="modal-body">
              <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>文件：{pendingApproval.path}</p>
              <pre className="approval-preview">{pendingApproval.contentPreview}</pre>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => void respondApproval(false)}>拒绝</button>
              <button className="btn primary" onClick={() => void respondApproval(true)}>允许写入</button>
            </div>
          </div>
        </div>
      )}

      <div className="conv-input-area">
        <textarea
          className="conv-input"
          value={input}
          disabled={!providerReady || aiStreaming}
          placeholder={providerReady ? '输入你的模组需求…（如：帮我做一个能隐身的侦察单位）' : '请先在设置中配置 AI'}
          aria-label="对话输入框"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="conv-input-row">
          <span className="hint">{aiStreaming ? 'AI 正在回复…' : 'Enter 发送 · Shift+Enter 换行'}</span>
          <button className="btn" disabled={!providerReady || aiStreaming || !input.trim()} onClick={send}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <AppIcon name="add" size={13} />
              {aiStreaming ? '回复中' : '发送'}
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
