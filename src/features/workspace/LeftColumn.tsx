/**
 * M29 左栏内部上下分栏：固定导航（工作台/社区）+ 项目列表（上）↕ 文件树（下）。
 * 比例按容器高度换算为像素（SplitHandle 以 px 工作），持久化存比例；
 * 高度测量以内层分栏容器为准（导航行不参与比例计算）。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { SplitHandle } from '../../components/SplitHandle'
import { INNER_RATIO_MAX, INNER_RATIO_MIN, pxToRatio, ratioToPx } from '../../utils/layout'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { ProjectPanel } from '../project/ProjectPanel'
import { SurfaceNav } from './SurfaceNav'

const DEFAULT_A_RATIO = 0.3

export function LeftColumn() {
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

  const collapsed = layout.leftACollapsed
  const ratio = liveRatio ?? layout.leftARatio
  // 折叠时直接归零（ratioToPx 内部会 clampRatio 到 0.15，不能走那条路）
  const px = collapsed ? 0 : ratioToPx(ratio, h)
  const minPx = ratioToPx(INNER_RATIO_MIN, h)
  const maxPx = Math.max(minPx, ratioToPx(INNER_RATIO_MAX, h))

  const commit = (v: number) => {
    setLiveRatio(null)
    const s = useWorkspaceStore.getState()
    s.updateSettings({
      layout: { ...s.settings.layout, leftARatio: pxToRatio(v, h), leftACollapsed: false },
    })
  }

  const style = h > 0 ? ({ '--row-a': `${px}px` } as CSSProperties) : undefined

  return (
    <div className="wb-left-col">
      <SurfaceNav />
      <div
        ref={wrapRef}
        className="wb-left-inner"
        data-a={liveRatio === null && collapsed ? 'collapsed' : 'expanded'}
        style={style}
      >
        <WorkspaceSidebar />
        {h > 0 && (
          <SplitHandle
            orientation="horizontal"
            value={px}
            min={minPx}
            max={maxPx}
            label="调整项目列表高度"
            onDrag={(v) => setLiveRatio(pxToRatio(v, h))}
            onDragEnd={commit}
            onReset={() => {
              const s = useWorkspaceStore.getState()
              s.updateSettings({ layout: { ...s.settings.layout, leftARatio: DEFAULT_A_RATIO, leftACollapsed: false } })
            }}
          />
        )}
        <ProjectPanel />
      </div>
    </div>
  )
}
