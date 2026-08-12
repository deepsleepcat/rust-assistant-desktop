/**
 * 右侧「AI 对话」面板：
 * - 一个项目可创建多个对话，各自独立
 * - 第一阶段不接入 AI：输入框禁用、发送按钮置灰，但对话数据已按最终形态存储
 * - 支持：创建 / 切换 / 重命名 / 归档 / 删除
 */
import { useState } from 'react'
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

function ConversationView({ id, title, onRename }: { id: string; title: string; onRename: () => void }) {
  const messages = useWorkspaceStore((s) => s.conversations.find((c) => c.id === id)?.messages ?? [])

  return (
    <div className="conversation-view">
      <div className="conv-view-header">
        <AppIcon name="tools" size={13} />
        <span className="title">{title}</span>
        <button className="icon-btn" title="重命名对话" onClick={onRename}>
          <AppIcon name="rename" size={13} />
        </button>
      </div>

      <div className="conv-messages">
        {messages.length === 0 ? (
          <div className="conv-empty">
            <span className="emoji">✨</span>
            <div>这里是「{title}」的对话空间</div>
            <div className="stage-hint">
              第一阶段暂未接入 AI。对话会保存在本地，
              下一阶段接入铁锈战争专用 Agent 后，
              你可以让它在整个项目里查找、分析和修改代码。
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`msg msg-${m.role}`}>
              <div className="msg-bubble">{m.content}</div>
            </div>
          ))
        )}
      </div>

      <div className="conv-input-area">
        <textarea
          className="conv-input"
          disabled
          placeholder="AI 功能将在下一阶段接入…"
          aria-label="对话输入框（暂不可用）"
        />
        <div className="conv-input-row">
          <span className="hint">按 Enter 发送 · Shift+Enter 换行</span>
          <button className="btn" disabled title="下一阶段接入 AI 后开放">
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <AppIcon name="add" size={13} />
              发送
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}
