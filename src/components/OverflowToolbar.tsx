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
  /** 分组名：相邻不同分组的动作之间用留白隔开（不加竖线） */
  group?: string
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
      style={{ padding: '2px 10px', fontSize: 12, flex: 'none' }}
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

  // 按顺序渲染动作列表，相邻不同分组的动作之间插入留白（测量行与可见行同构，宽度一致）
  const renderGrouped = (list: ToolbarAction[]) => {
    const out: ReactNode[] = []
    let prevGroup: string | undefined
    for (const a of list) {
      if (out.length > 0 && a.group && a.group !== prevGroup) {
        out.push(<span key={`gap-${a.key}`} className="toolbar-group-gap" aria-hidden="true" />)
      }
      out.push(renderItem(a))
      prevGroup = a.group
    }
    return out
  }

  // 只在溢出集合内容真正变化时才更新，避免 actions 每次重建（如每次按键）引发无谓重渲染
  const setOverflowedIfChanged = useCallback((next: Set<string>) => {
    setOverflowed((prev) => {
      if (prev.size === next.size) {
        let same = true
        for (const k of next) {
          if (!prev.has(k)) {
            same = false
            break
          }
        }
        if (same) return prev
      }
      return next
    })
  }, [])

  // 单一重算入口：读 actionsRef（最新）与测量行布局，把放不下的动作收进溢出集合。
  // 前缀测量法：取测量行上每个按钮的 offsetLeft+offsetWidth 作为「前缀末端位置」，
  // 天然包含按钮间 4px gap 与组间 8px 留白（旧版逐项累加 offsetWidth 漏算了这些缝隙，
  // 导致行实际溢出、行尾按钮被裁切）；再按渲染顺序取最大前缀，溢出成员永远是
  // 行尾连续按钮，与视觉顺序一致（旧版装不下时 acc 不增，后面的窄按钮仍会留在
  // 行上，菜单成员看起来随机跳动）。
  const recompute = useCallback(() => {
    const wrap = wrapRef.current
    const measure = measureRef.current
    if (!wrap || !measure) return
    const avail = wrap.clientWidth
    const children = Array.from(measure.children) as HTMLElement[]
    const endByKey = new Map<string, number>()
    const elByKey = new Map<string, HTMLElement>()
    for (const el of children) {
      const k = el.dataset.key ?? ''
      if (!k) continue
      endByKey.set(k, el.offsetLeft + el.offsetWidth)
      elByKey.set(k, el)
    }
    // 整行（含常驻按钮）本来就能放下时无需菜单，不必为不存在的「更多」按钮预留宽度
    const last = children[children.length - 1] as HTMLElement | undefined
    if (!last || last.offsetLeft + last.offsetWidth <= avail) {
      setOverflowedIfChanged(new Set<string>())
      return
    }
    // 常驻按钮（保存，渲染在行尾）占宽：自身宽度 + 与前一按钮之间的间距（含组间留白）。
    // 它所在分组唯一，无论它前面可见的是哪个按钮，组间留白结构都一致，预留始终准确。
    let reserved = 0
    for (const a of actionsRef.current) {
      if (!a.alwaysVisible) continue
      const el = elByKey.get(a.key)
      if (!el) continue
      reserved += el.offsetWidth
      const idx = children.indexOf(el)
      if (idx > 0) {
        const prev = children[idx - 1] as HTMLElement
        reserved += el.offsetLeft - (prev.offsetLeft + prev.offsetWidth)
      }
    }
    const menuW = 64 // 「更多」按钮实测宽度（icon + 两字 + padding），预留不足会横向溢出
    const budget = avail - menuW - reserved - 4 // 4：可见行最后一个按钮与「更多」按钮之间的 flex gap
    const next = new Set<string>()
    for (const a of actionsRef.current) {
      if (a.alwaysVisible) continue // 常驻按钮永不收进菜单
      // 前缀末端位置沿渲染顺序单调递增：一旦超预算，其后全部进菜单（保证溢出集合是行尾连续后缀）
      if ((endByKey.get(a.key) ?? 0) > budget) next.add(a.key)
    }
    setOverflowedIfChanged(next)
  }, [setOverflowedIfChanged])

  // actions 变化：先同步 ref 再重算（render 期间禁止写 ref；passive effect 太晚会漏掉首次重算）
  useLayoutEffect(() => {
    actionsRef.current = actions
    recompute()
  }, [actions, recompute])

  // ResizeObserver 只挂载一次；回调读取最新 actions（经 ref）。
  // 同时观察父容器：若布局变化导致自身宽度不再跟随容器（如丢失 flex:1），
  // 容器变宽时仍有事件触发重算，避免「吞进菜单后无声锁死」。
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(recompute)
    ro.observe(wrap)
    if (wrap.parentElement) ro.observe(wrap.parentElement)
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
        style={{ position: 'absolute', left: 0, top: 0, visibility: 'hidden', display: 'flex', gap: 4, pointerEvents: 'none' }}
      >
        {renderGrouped(actions)}
      </div>
      {renderGrouped(visible)}
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
        style={{ padding: '2px 10px', fontSize: 12 }}
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
