import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useWorkspaceStore } from '../stores/workspace'
import { SplitHandle } from './SplitHandle'
import { AppIcon } from './AppIcon'
import { WORKBENCH_CONSTRAINTS, WORKBENCH_DEFAULTS, fitWorkbench, layoutMode } from '../utils/layout'
import { useFocusTrap } from '../utils/focusTrap'
import { useEscapeHandler } from '../utils/modalStack'

interface WorkbenchLayoutProps {
  left: ReactNode
  editor: ReactNode
}

/** Project/file rail and editor keep their DOM positions at every window size. */
export function WorkbenchLayout({ left, editor }: WorkbenchLayoutProps) {
  const settings = useWorkspaceStore((state) => state.settings)
  const drawerSide = useWorkspaceStore((state) => state.drawerSide)
  const setDrawerSide = useWorkspaceStore((state) => state.setDrawerSide)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const wrapRef = useRef<HTMLDivElement>(null)
  const projectRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(0)
  const [liveLeft, setLiveLeft] = useState<number | null>(null)

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
  const fitted = useMemo(
    () => fitWorkbench({ left: leftCollapsed ? 0 : settings.leftWidth, right: 0 }, width),
    [leftCollapsed, settings.leftWidth, width],
  )
  const constraints = WORKBENCH_CONSTRAINTS
  const leftMax = Math.max(constraints.minLeft, width - constraints.minEditor - 8)

  const commitLeft = useCallback((value: number) => {
    setLiveLeft(null)
    const state = useWorkspaceStore.getState()
    updateSettings({ leftWidth: value, layout: { ...state.settings.layout, leftCollapsed: false } })
  }, [updateSettings])
  const resetLeft = useCallback(() => commitLeft(WORKBENCH_DEFAULTS.left), [commitLeft])

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
  const style = { '--wb-left': `${liveLeft ?? fitted.left}px` } as CSSProperties

  return (
    <div className="workbench desktop-workbench" ref={wrapRef} style={style}
      data-mode={mode} data-left={leftCollapsed ? 'collapsed' : 'expanded'} data-drawer={drawerOpen ? 'open' : 'closed'}>
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
