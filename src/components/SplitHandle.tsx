/**
 * M29 可拖动分隔条（SplitHandle）：
 * - Pointer Events + setPointerCapture：拖动跟手且跨窗口边缘不丢事件；
 * - 键盘：方向键小步 / Shift+方向键大步 / Home-End / 双击恢复默认；
 * - ARIA separator：读屏可读当前值与可调范围；
 * - 拖动期间只回调 onDrag（上层更新局部状态），松开回调 onDragEnd（上层持久化）。
 */
import { useCallback, useRef, useState } from 'react'
import { clampWidth } from '../utils/layout'

export interface SplitHandleProps {
  orientation: 'vertical' | 'horizontal'
  /** 当前值（px）：vertical = 左侧/前一个区域宽度；horizontal = 上方区域高度 */
  value: number
  min: number
  max: number
  /** 拖动中实时回调（用于局部 CSS 变量，不持久化） */
  onDrag: (v: number) => void
  /** 拖动结束/键盘调整后提交（用于持久化） */
  onDragEnd: (v: number) => void
  /** 双击恢复默认值 */
  onReset?: () => void
  label: string
}

export function SplitHandle({ orientation, value, min, max, onDrag, onDragEnd, onReset, label }: SplitHandleProps) {
  const [dragging, setDragging] = useState(false)
  // M29：拖动中的实时值（读屏 aria-valuenow 跟手；不持久化）
  const [liveValue, setLiveValue] = useState<number | null>(null)
  const dragRef = useRef<{ start: number; startValue: number; last: number } | null>(null)

  const moveTo = useCallback(
    (v: number) => {
      const next = clampWidth(v, min, max)
      if (dragRef.current) dragRef.current.last = next
      setLiveValue(next)
      onDrag(next)
    },
    [min, max, onDrag],
  )
  return (
    <div
      className={`splitter${dragging ? ' dragging' : ''}`}
      data-orientation={orientation}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      // 实时值优先；折叠（value=0 < min）时按 min 报，避免 valuenow 越界
      aria-valuenow={liveValue ?? Math.max(min, value)}
      tabIndex={0}
      onPointerDown={(e) => {
        // 只响应主键拖动
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        dragRef.current = {
          start: orientation === 'vertical' ? e.clientX : e.clientY,
          startValue: value,
          last: value,
        }
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!dragRef.current) return
        const d = (orientation === 'vertical' ? e.clientX : e.clientY) - dragRef.current.start
        moveTo(dragRef.current.startValue + d)
      }}
      onPointerUp={(e) => {
        if (!dragRef.current) return
        e.currentTarget.releasePointerCapture(e.pointerId)
        // 先取最后值再清空 ref；折叠态原地点击（无移动）last 可能为 0，夹到 min 避免把 0 持久化
        const last = clampWidth(dragRef.current.last, min, max)
        dragRef.current = null
        setDragging(false)
        setLiveValue(null)
        onDragEnd(last)
      }}
      onPointerCancel={() => {
        if (!dragRef.current) return
        dragRef.current = null
        setDragging(false)
        setLiveValue(null)
      }}
      onDoubleClick={() => onReset?.()}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10
        const dirKey =
          orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
        let next: number | null = null
        if (e.key === dirKey[0]) next = value - step
        else if (e.key === dirKey[1]) next = value + step
        else if (e.key === 'Home') next = min
        else if (e.key === 'End') next = max
        if (next === null) return
        e.preventDefault()
        const v = clampWidth(next, min, max)
        // 键盘调整即时提交，value prop 会同步更新（无需 liveValue）
        onDrag(v)
        onDragEnd(v)
      }}
    />
  )
}
