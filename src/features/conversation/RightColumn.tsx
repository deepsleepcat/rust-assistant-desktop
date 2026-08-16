/**
 * M29 右栏（AI 对话区）容器：对话列表（上）↕ 消息区（下）可拖动分栏。
 * 比例按容器高度换算为像素（SplitHandle 以 px 工作），持久化存比例；
 * 折叠 = --row-a 归零（列表段隐藏），从分隔条拖出即可重新展开。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useWorkspaceStore, useSortedConversations } from '../../stores/workspace'
import { SplitHandle } from '../../components/SplitHandle'
import { INNER_RATIO_MAX, INNER_RATIO_MIN, pxToRatio, ratioToPx } from '../../utils/layout'
import { AppIcon } from '../../components/AppIcon'
import { PromptModal } from '../../components/Modal'
import { ConversationListSection, ConversationView } from './ConversationPanel'

const DEFAULT_A_RATIO = 0.38

export function RightColumn() {
  const layout = useWorkspaceStore((s) => s.settings.layout)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  const [liveRatio, setLiveRatio] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setH(el.clientHeight))
    ro.observe(el)
    setH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  const collapsed = layout.rightACollapsed
  const ratio = liveRatio ?? layout.rightARatio
  // 折叠时直接归零（ratioToPx 内部会 clampRatio 到 0.15，不能走那条路）
  const px = collapsed ? 0 : ratioToPx(ratio, h)
  const minPx = ratioToPx(INNER_RATIO_MIN, h)
  const maxPx = Math.max(minPx, ratioToPx(INNER_RATIO_MAX, h))

  const commit = (v: number) => {
    setLiveRatio(null)
    const s = useWorkspaceStore.getState()
    s.updateSettings({
      layout: { ...s.settings.layout, rightARatio: pxToRatio(v, h), rightACollapsed: false },
    })
  }

  const style = h > 0 ? ({ '--row-a': `${px}px` } as CSSProperties) : undefined

  return (
    <div
      ref={wrapRef}
      className="wb-right-inner"
      data-a={liveRatio === null && collapsed ? 'collapsed' : 'expanded'}
      style={style}
    >
      <ConversationListSection />
      {h > 0 && (
        <SplitHandle
          orientation="horizontal"
          value={px}
          min={minPx}
          max={maxPx}
          label="调整对话列表高度"
          onDrag={(v) => setLiveRatio(pxToRatio(v, h))}
          onDragEnd={commit}
          onReset={() => {
            const s = useWorkspaceStore.getState()
            s.updateSettings({ layout: { ...s.settings.layout, rightARatio: DEFAULT_A_RATIO, rightACollapsed: false } })
          }}
        />
      )}
      <ConversationViewSection />
    </div>
  )
}

/** 消息视图段：有活动对话渲染 ConversationView（含重命名弹窗），否则给轻量空状态提示 */
function ConversationViewSection() {
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const activeConversationId = useWorkspaceStore((s) => s.activeConversationId)
  const conversations = useSortedConversations(project?.id ?? null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)

  const active = conversations.find((c) => c.id === activeConversationId) ?? null

  return (
    <>
      {active ? (
        <ConversationView
          id={active.id}
          title={active.title}
          onRename={() => setRenaming({ id: active.id, title: active.title })}
        />
      ) : (
        <div className="conv-empty">
          <AppIcon name="tools" size={28} />
          <div>{project ? '选择左侧对话开始' : '打开项目后即可创建 AI 对话'}</div>
        </div>
      )}
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
    </>
  )
}
