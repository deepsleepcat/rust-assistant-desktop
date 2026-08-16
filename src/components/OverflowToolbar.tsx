/**
 * M29 溢出工具栏（OverflowToolbar）：
 * - 容器宽度足够时全部按钮平铺；不够时把放不下的动作收进「更多」菜单；
 * - 用隐藏测量行一次性算出每个动作宽度（渲染真实按钮，宽度准确），避免逐次 DOM 回流；
 * - 窄容器永远不会溢出/挤压（编辑器顶栏、图片工具栏等拥挤区使用）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AppIcon } from './AppIcon'

export interface ToolbarAction {
  key: string
  label: string
  icon?: ReactNode
  title?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  /** 常驻可见（如保存），不允许被收进菜单 */
  alwaysVisible?: boolean
}

interface OverflowToolbarProps {
  actions: ToolbarAction[]
  /** 「更多」菜单按钮文案 */
  overflowLabel?: string
}

export function OverflowToolbar({ actions, overflowLabel = '更多' }: OverflowToolbarProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [overflowed, setOverflowed] = useState<Set<string>>(new Set())
  const actionsRef = useRef(actions)

  const renderItem = (a: ToolbarAction) => (
    <button
      key={a.key}
      data-key={a.key}
      className={a.active ? 'btn primary' : 'btn'}
      style={{ padding: '2px 10px', fontSize: 11.5, flex: 'none' }}
      title={a.title ?? a.label}
      disabled={a.disabled}
      onClick={a.onClick}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {a.icon}
        {a.label}
      </span>
    </button>
  )

  // 单一重算入口：读 actionsRef（最新）与测量行宽度，把放不下的动作收进溢出集合
  const recompute = useCallback(() => {
    const wrap = wrapRef.current
    const measure = measureRef.current
    if (!wrap || !measure) return
    const avail = wrap.clientWidth
    const widthByKey = new Map<string, number>()
    for (const el of Array.from(measure.children) as HTMLElement[]) {
      const k = el.dataset.key ?? ''
      if (k) widthByKey.set(k, el.offsetWidth)
    }
    const ordered = [
      ...actionsRef.current.filter((a) => a.alwaysVisible).map((a) => a.key),
      ...actionsRef.current.filter((a) => !a.alwaysVisible).map((a) => a.key),
    ]
    const menuW = 64 // 「更多」按钮实测宽度（icon + 两字 + padding），预留不足会横向溢出
    let acc = 0
    const next = new Set<string>()
    for (const key of ordered) {
      const w = widthByKey.get(key) ?? 0
      if (acc === 0 || acc + w <= avail - menuW) {
        acc += w
      } else {
        next.add(key)
      }
    }
    setOverflowed(next)
  }, [])

  // actions 变化：先同步 ref 再重算（render 期间禁止写 ref；passive effect 太晚会漏掉首次重算）
  useLayoutEffect(() => {
    actionsRef.current = actions
    recompute()
  }, [actions, recompute])

  // ResizeObserver 只挂载一次；回调读取最新 actions（经 ref）
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(recompute)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [recompute])

  const visible = actions.filter((a) => !overflowed.has(a.key))
  const hidden = actions.filter((a) => overflowed.has(a.key))

  return (
    <div className="toolbar" ref={wrapRef} style={{ position: 'relative' }}>
      {/* 测量行：渲染真实按钮量宽度（visibility:hidden 不可聚焦、不占布局） */}
      <div
        ref={measureRef}
        aria-hidden="true"
        style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', display: 'flex', gap: 6, pointerEvents: 'none' }}
      >
        {actions.map(renderItem)}
      </div>
      {visible.map(renderItem)}
      {hidden.length > 0 && <OverflowMenuButton label={overflowLabel} hidden={hidden} />}
    </div>
  )
}

function OverflowMenuButton({ label, hidden }: { label: string; hidden: ToolbarAction[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative', flex: 'none' }}>
      <button
        className={open ? 'btn primary' : 'btn'}
        style={{ padding: '2px 10px', fontSize: 11.5 }}
        onClick={() => setOpen((v) => !v)}
        title={label}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <AppIcon name="menu" size={12} />
          {label}
        </span>
      </button>
      {open && (
        <>
          <div className="mod-tools-mask" onClick={() => setOpen(false)} />
          <div className="toolbar-overflow-menu">
            {hidden.map((a) => (
              <button
                key={a.key}
                disabled={a.disabled}
                title={a.title ?? a.label}
                onClick={() => {
                  setOpen(false)
                  a.onClick()
                }}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
