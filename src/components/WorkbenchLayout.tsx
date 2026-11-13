import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { SplitHandle } from './SplitHandle'
import { AppIcon } from './AppIcon'
import { WORKBENCH_CONSTRAINTS, WORKBENCH_DEFAULTS, clampWidth, fitWorkbench, layoutMode } from '../utils/layout'
import { useFocusTrap } from '../utils/focusTrap'
import { useEscapeHandler } from '../utils/modalStack'

interface WorkbenchLayoutProps {
  left: ReactNode
  editor: ReactNode
  /** 编辑器右侧面板（feat/git-visual-center：Git 面板）；不传或紧凑模式时不占位 */
  right?: ReactNode
}

/** Project/file rail and editor keep their DOM positions at every window size. */
export function WorkbenchLayout({ left, editor, right }: WorkbenchLayoutProps) {
  const settings = useWorkspaceStore((state) => state.settings)
  const drawerSide = useWorkspaceStore((state) => state.drawerSide)
  const setDrawerSide = useWorkspaceStore((state) => state.setDrawerSide)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const wrapRef = useRef<HTMLDivElement>(null)
  const projectRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  const [liveLeft, setLiveLeft] = useState<number | null>(null)
  const [liveRight, setLiveRight] = useState<number | null>(null)

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const resizeObserver = new ResizeObserver(() => {
      if (element.clientWidth > 0) setWidth(element.clientWidth)
    })
    resizeObserver.observe(element)
    if (element.clientWidth > 0) setWidth(element.clientWidth)
    return () => resizeObserver.disconnect()
  }, [])

  const mode = layoutMode(width)
  const compact = mode === 'compact'
  const leftCollapsed = settings.layout.leftCollapsed
  const drawerOpen = compact && drawerSide === 'left'
  // feat/git-visual-center：右侧面板仅在有内容且非紧凑模式时占位（紧凑模式走抽屉语义，暂不支持右栏）
  const rightVisible = Boolean(right) && !compact
  const fitted = useMemo(
    () => fitWorkbench(
      { left: leftCollapsed ? 0 : settings.leftWidth, right: rightVisible ? (settings.rightWidth || WORKBENCH_DEFAULTS.right) : 0 },
      width,
    ),
    [leftCollapsed, settings.leftWidth, rightVisible, settings.rightWidth, width],
  )
  const constraints = WORKBENCH_CONSTRAINTS
  const leftMax = Math.max(constraints.minLeft, width - constraints.minEditor - 8)

  const commitLeft = useCallback((value: number) => {
    setLiveLeft(null)
    const state = useWorkspaceStore.getState()
    updateSettings({ leftWidth: value, layout: { ...state.settings.layout, leftCollapsed: false } })
  }, [updateSettings])
  const resetLeft = useCallback(() => commitLeft(WORKBENCH_DEFAULTS.left), [commitLeft])

  // feat/git-visual-center：右栏分隔条以「编辑器宽度」为 SplitHandle 值（值语义=左侧区域宽度），
  // 拖左 = 编辑器变窄 = 右栏变宽。提交时按容器总宽反推右栏宽并持久化到 settings.rightWidth。
  const splitterCount = rightVisible ? (leftCollapsed ? 1 : 2) : (leftCollapsed ? 0 : 1)
  const leftPx = liveLeft ?? fitted.left
  const rightPx = liveRight ?? fitted.right
  const editorWidthValue = Math.max(0, width - leftPx - 8 * splitterCount - rightPx)
  const commitRight = useCallback((editorWidth: number) => {
    setLiveRight(null)
    const state = useWorkspaceStore.getState()
    const total = wrapRef.current?.clientWidth ?? 0
    if (total <= 0) return
    const leftNow = state.settings.layout.leftCollapsed ? 0 : state.settings.leftWidth
    const handles = 8 * (state.settings.layout.leftCollapsed ? 1 : 2)
    const right = clampWidth(total - leftNow - handles - editorWidth, WORKBENCH_CONSTRAINTS.minRight, WORKBENCH_CONSTRAINTS.maxRight)
    updateSettings({ rightWidth: right, layout: { ...state.settings.layout, rightCollapsed: false } })
  }, [updateSettings])

  useEffect(() => {
    if (!compact && drawerSide || drawerSide === 'right') setDrawerSide(null)
  }, [compact, drawerSide, setDrawerSide])
  useEffect(() => {
    document.body.classList.toggle('ra-compact', compact)
    return () => document.body.classList.remove('ra-compact')
  }, [compact])
  useEffect(() => () => {
    // Hiding the editor via Activity must also release its transient drawer.
    if (useWorkspaceStore.getState().drawerSide) useWorkspaceStore.getState().setDrawerSide(null)
  }, [])

  useEscapeHandler(() => setDrawerSide(null), drawerOpen)
  useFocusTrap(projectRef, drawerOpen)
  const projectHidden = compact ? !drawerOpen : leftCollapsed
  const style = { '--wb-left': `${leftPx}px`, '--wb-right': `${rightPx}px` } as CSSProperties

  return (
    <div className="workbench desktop-workbench" ref={wrapRef} style={style}
      data-mode={mode} data-left={leftCollapsed ? 'collapsed' : 'expanded'} data-right={rightVisible ? 'expanded' : 'collapsed'}
      data-drawer={drawerOpen ? 'open' : 'closed'}>
      {drawerOpen && <div className="wb-project-backdrop" onClick={() => setDrawerSide(null)} aria-hidden="true" />}
      <aside ref={projectRef} className="wb-left sidebar" aria-label="项目与文件"
        role={drawerOpen ? 'dialog' : undefined} aria-modal={drawerOpen || undefined}
        aria-hidden={projectHidden} inert={projectHidden}>
        <div className="wb-project-drawer-head">
          <span>项目与文件 <small lang="en">Projects & files</small></span>
          <button type="button" className="icon-btn" aria-label="关闭项目与文件" title="关闭项目与文件 / Close projects and files" onClick={() => setDrawerSide(null)}><AppIcon name="close" size={16} /></button>
        </div>
        {left}
      </aside>
      <SplitHandle orientation="vertical" value={fitted.left} min={constraints.minLeft} max={leftMax}
        label="调整项目区宽度 / Resize projects" onDrag={setLiveLeft} onDragEnd={commitLeft} onReset={resetLeft} />
      <section className="wb-editor" inert={drawerOpen}>
        {editor}
      </section>
      {rightVisible && (
        <SplitHandle orientation="vertical" value={editorWidthValue} min={constraints.minEditor}
          max={Math.max(constraints.minEditor, width - leftPx - 8 * splitterCount - constraints.minRight)}
          label="调整 Git 面板宽度 / Resize Git panel" onDrag={(v) => setLiveRight(clampWidth(width - leftPx - 8 * splitterCount - v, constraints.minRight, constraints.maxRight))}
          onDragEnd={commitRight} />
      )}
      {rightVisible && (
        <section className="wb-right">
          {right}
        </section>
      )}
      {(compact && !drawerOpen || !compact && leftCollapsed) && (
        <button type="button" className="wb-project-toggle" title="打开项目与文件 / Open projects and files" aria-label="打开项目与文件"
          aria-expanded={drawerOpen} onClick={() => {
            if (compact) setDrawerSide('left')
            else {
              const state = useWorkspaceStore.getState()
              updateSettings({ layout: { ...state.settings.layout, leftCollapsed: false } })
            }
          }}><AppIcon name="menu" size={16} /><span>项目</span></button>
      )}
    </div>
  )
}
