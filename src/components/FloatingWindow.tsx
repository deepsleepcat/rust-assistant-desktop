/**
 * 悬浮窗（FloatingWindow）：编辑器内容区上方的可拖动/可缩放小窗。
 * - 拖动：按住标题栏移动；缩放：右下角手柄；位置/大小仅会话内记忆（不持久化）；
 * - 层级：位于编辑器内容之上（z 150+）、模态弹窗之下（.modal-overlay z 200），
 *   多窗并存时点按任意位置置顶（模块级递增计数器，上限 199）；
 * - 用途：炮塔编辑器 / 单位预览等「想和代码并排看」的功能（原为独占内容区或居中模态）。
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { AppIcon } from './AppIcon'

/** 层级基线：150（编辑器内容之上）~ 199（模态 200 之下） */
const Z_BASE = 150
const Z_MAX = 199
let zNext = Z_BASE

/** 视口夹紧：标题栏至少 60px 留在视口内，保证永远拖得回来 */
function clampPos(x: number, y: number, w: number): { x: number; y: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return {
    x: Math.min(Math.max(x, 8 - w + 60), vw - 68),
    y: Math.min(Math.max(y, 8), vh - 60),
  }
}

interface FloatingWindowProps {
  /** 标题栏内容（拖动手柄区） */
  title: ReactNode
  onClose: () => void
  /** 初始尺寸（默认 560×480，右下角可缩放） */
  width?: number
  height?: number
  /** 缩放下限 */
  minWidth?: number
  minHeight?: number
  children: ReactNode
}

export function FloatingWindow({ title, onClose, width = 560, height = 480, minWidth = 360, minHeight = 240, children }: FloatingWindowProps) {
  const winRef = useRef<HTMLDivElement>(null)
  // 首次定位（useState 初始化器，避免 effect 内同步 setState）：
  // 尺寸夹紧到视口内，位置按视口居中偏上（避开状态栏与工具栏）
  const initialLayout = () => {
    const w = Math.min(width, window.innerWidth - 24)
    const h = Math.min(height, window.innerHeight - 24)
    return { w, h }
  }
  const [size, setSize] = useState(initialLayout)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    const { w, h } = initialLayout()
    return clampPos(Math.round((window.innerWidth - w) / 2), Math.round((window.innerHeight - h) / 2.6), w)
  })
  const [z, setZ] = useState(Z_BASE)
  // 收起：只留标题栏，不再挡住下方代码（展开时恢复原位置/大小）
  const [collapsed, setCollapsed] = useState(false)
  const dragState = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null>(null)

  // 视口变化时夹紧，防止窗口被拖出屏幕外
  useEffect(() => {
    if (!pos) return
    const onResize = () => setPos((p) => (p ? clampPos(p.x, p.y, size.w) : p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos, size.w, size.h])

  const bringToFront = () => setZ((prev) => (prev >= zNext - 1 && zNext < Z_MAX ? prev : zNext < Z_MAX ? ++zNext : prev))

  const onPointerDown = (mode: 'move' | 'resize') => (e: ReactPointerEvent) => {
    if (!pos) return
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    bringToFront()
    dragState.current = { mode, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, origW: size.w, origH: size.h }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    const st = dragState.current
    if (!st) return
    if (st.mode === 'move') {
      setPos(clampPos(st.origX + e.clientX - st.startX, st.origY + e.clientY - st.startY, size.w))
    } else {
      setSize({
        w: Math.max(minWidth, Math.min(st.origW + e.clientX - st.startX, window.innerWidth - st.origX - 8)),
        h: Math.max(minHeight, Math.min(st.origH + e.clientY - st.startY, window.innerHeight - st.origY - 8)),
      })
    }
  }

  const endDrag = (e: ReactPointerEvent) => {
    dragState.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  // 标题栏按下 = 开始拖动；但按在按钮上（关闭 ×）时放行——否则 preventDefault
  // 会吞掉按钮的 click，导致无法点 × 关闭
  const onHeadPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    onPointerDown('move')(e)
  }

  const HEAD_H = 34

  return (
    <div
      ref={winRef}
      className="float-win"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, width: size.w, height: collapsed ? HEAD_H : size.h, zIndex: z }}
      onPointerDown={bringToFront}
    >
      <div className="float-win-head" onPointerDown={onHeadPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <button
          type="button"
          className="icon-btn"
          aria-label={collapsed ? '展开悬浮窗' : '收起悬浮窗（只留标题栏）'}
          title={collapsed ? '展开' : '收起'}
          onClick={() => setCollapsed((v) => !v)}
        >
          <span style={{ display: 'inline-flex', transform: collapsed ? 'rotate(-90deg)' : 'rotate(90deg)' }}>
            <AppIcon name="expand" size={13} />
          </span>
        </button>
        <span className="float-win-title">{title}</span>
        <button type="button" className="icon-btn" aria-label="关闭悬浮窗" title="关闭" onClick={onClose}>
          <AppIcon name="close" size={13} />
        </button>
      </div>
      {!collapsed && <div className="float-win-body">{children}</div>}
      {!collapsed && <div className="float-win-resize" onPointerDown={onPointerDown('resize')} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} aria-hidden="true" />}
    </div>
  )
}
