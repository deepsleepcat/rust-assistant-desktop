/**
 * M29 工作区三栏布局：
 * - 主三栏（左项目区 / 编辑器 / 右 AI 区）两条垂直分隔条可拖动、可键盘调整、双击恢复默认；
 * - 左/右栏整体可折叠（折叠 = --wb-* 变量归零，槽位保留，从折叠边拖分隔条可重新展开）；
 * - 窗口变窄自动进入 medium（压缩三栏）/ compact（左/右栏变抽屉，浮动开关打开）；
 *   紧凑模式不覆盖用户保存的宽度与折叠偏好；
 * - 拖动期间只更新局部 CSS 变量（不持久化），松开才写 settings。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { SplitHandle } from './SplitHandle'
import { WORKBENCH_CONSTRAINTS, WORKBENCH_DEFAULTS, fitWorkbench, layoutMode } from '../utils/layout'
import { useFocusTrap } from '../utils/focusTrap'

interface WorkbenchLayoutProps {
  left: ReactNode
  editor: ReactNode
  right: ReactNode
}

export function WorkbenchLayout({ left, editor, right }: WorkbenchLayoutProps) {
  const settings = useWorkspaceStore((s) => s.settings)
  const drawerSide = useWorkspaceStore((s) => s.drawerSide)
  const setDrawerSide = useWorkspaceStore((s) => s.setDrawerSide)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)

  const wrapRef = useRef<HTMLDivElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [liveLeft, setLiveLeft] = useState<number | null>(null)
  const [liveRight, setLiveRight] = useState<number | null>(null)

  // 容器宽度监听
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const mode = layoutMode(width)
  const leftCollapsed = settings.layout.leftCollapsed
  const rightCollapsed = settings.layout.rightCollapsed

  // 把保存的宽度适配到当前容器（折叠传入 0 → fitWorkbench 保持 0）
  const fitted = useMemo(
    () =>
      fitWorkbench(
        { left: leftCollapsed ? 0 : settings.leftWidth, right: rightCollapsed ? 0 : settings.rightWidth },
        width,
      ),
    [width, settings.leftWidth, settings.rightWidth, leftCollapsed, rightCollapsed],
  )

  const c = WORKBENCH_CONSTRAINTS
  // 拖动边界：保证编辑器至少 minEditor（用另一侧当前值计算；扣除分隔条命中区——
  // 双侧展开扣 16，单侧折叠只扣一条 8）
  const splitterTotal = leftCollapsed || rightCollapsed ? 8 : 16
  const leftMax = Math.max(c.minLeft, width - c.minEditor - splitterTotal - (rightCollapsed ? 0 : fitted.right))
  const rightMax = Math.max(c.minRight, width - c.minEditor - splitterTotal - (leftCollapsed ? 0 : fitted.left))

  const commitLeft = useCallback(
    (v: number) => {
      setLiveLeft(null)
      const s = useWorkspaceStore.getState()
      const collapsed = s.settings.layout.leftCollapsed
      updateSettings(
        collapsed ? { leftWidth: v, layout: { ...s.settings.layout, leftCollapsed: false } } : { leftWidth: v },
      )
    },
    [updateSettings],
  )
  const commitRight = useCallback(
    (v: number) => {
      setLiveRight(null)
      const s = useWorkspaceStore.getState()
      const collapsed = s.settings.layout.rightCollapsed
      updateSettings(
        collapsed ? { rightWidth: v, layout: { ...s.settings.layout, rightCollapsed: false } } : { rightWidth: v },
      )
    },
    [updateSettings],
  )
  const resetLeft = useCallback(() => commitLeft(WORKBENCH_DEFAULTS.left), [commitLeft])
  const resetRight = useCallback(() => commitRight(WORKBENCH_DEFAULTS.right), [commitRight])

  // 离开 compact 时清掉抽屉
  useEffect(() => {
    if (mode !== 'compact' && drawerSide) setDrawerSide(null)
  }, [mode, drawerSide, setDrawerSide])

  // 标题栏/状态栏窄屏收缩钩子（CSS 选择器挂在 body.ra-compact）
  useEffect(() => {
    document.body.classList.toggle('ra-compact', mode === 'compact')
    return () => {
      document.body.classList.toggle('ra-compact', false)
    }
  }, [mode])

  // 抽屉 Escape 关闭
  useEffect(() => {
    if (!drawerSide) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerSide(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerSide, setDrawerSide])
  useFocusTrap(drawerRef, drawerSide !== null)

  const style = {
    '--wb-left': `${liveLeft ?? fitted.left}px`,
    '--wb-right': `${liveRight ?? fitted.right}px`,
  } as CSSProperties

  const attrs = {
    'data-mode': mode,
    'data-left': leftCollapsed ? 'collapsed' : 'expanded',
    'data-right': rightCollapsed ? 'collapsed' : 'expanded',
  }

  const leftNode = (
    <aside className="wb-left sidebar" aria-hidden={mode !== 'compact' && leftCollapsed}>
      {left}
    </aside>
  )
  const rightNode = (
    <aside className="wb-right" aria-hidden={mode !== 'compact' && rightCollapsed}>
      {right}
    </aside>
  )

  return (
    <>
      <div className="workbench" ref={wrapRef} style={style} {...attrs}>
        {mode === 'compact' ? (
          editor
        ) : (
          <>
            {leftNode}
            <SplitHandle
              orientation="vertical"
              value={fitted.left}
              min={c.minLeft}
              max={leftMax}
              label="调整项目区宽度"
              onDrag={(v) => setLiveLeft(v)}
              onDragEnd={commitLeft}
              onReset={resetLeft}
            />
            <section className="wb-editor">{editor}</section>
            <SplitHandle
              orientation="vertical"
              value={fitted.right}
              min={c.minRight}
              max={rightMax}
              label="调整 AI 对话区宽度"
              onDrag={(v) => setLiveRight(v)}
              onDragEnd={commitRight}
              onReset={resetRight}
            />
            {rightNode}
          </>
        )}
      </div>

      {/* 紧凑模式：左/右栏抽屉（同一时间只开一个；不覆盖持久化偏好）。
          遮罩/backdrop 只在抽屉打开时拦截点击；无抽屉时 overlay 本身透传（chips 可点） */}
      {mode === 'compact' && (
        <div className="wb-drawer-overlay" style={drawerSide ? undefined : { pointerEvents: 'none' }}>
          {drawerSide && <div className="wb-drawer-backdrop" onClick={() => setDrawerSide(null)} />}
          {drawerSide && (
            <div
              ref={drawerRef}
              className="wb-drawer"
              data-side={drawerSide === 'right' ? 'right' : 'left'}
              role="dialog"
              aria-modal="true"
              aria-label={drawerSide === 'right' ? 'AI 对话区' : '项目区'}
            >
              {drawerSide === 'right' ? right : left}
            </div>
          )}
          {/* 浮动开关：同侧抽屉打开时隐藏（避免叠压抽屉头部） */}
          {drawerSide !== 'left' && (
            <button className="wb-chip" style={{ position: 'absolute', left: 8, top: 8 }} title="打开项目区" aria-label="打开项目区" onClick={() => setDrawerSide('left')}>
              项目
            </button>
          )}
          {drawerSide !== 'right' && (
            <button className="wb-chip" style={{ position: 'absolute', right: 8, top: 8 }} title="打开 AI 对话区" aria-label="打开 AI 对话区" onClick={() => setDrawerSide('right')}>
              AI 对话
            </button>
          )}
        </div>
      )}
    </>
  )
}
