import { Activity, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import type { WorkspaceSurface } from '../../stores/types'
import { surfaceDirection, surfaceLabel } from './shellContract'
import { useDesktopPreferences } from './desktopPreferences'

const SURFACES: readonly WorkspaceSurface[] = ['editor', 'dashboard', 'cloudBag', 'settings']

/** 交叉淡化时长（毫秒）：新界面在旧界面之上淡入，全程不露壁纸底 */
const CROSSFADE_MS = 150

/**
 * Activity retains local state and pauses effects (including hidden dialog traps).
 *
 * 切换动画（feat/git-visual-center 重做）：旧的两段式「先淡出→露壁纸→再淡入」
 * 在亮色壁纸上会闪空一帧，观感像卡顿。改为真正的交叉淡化——切换瞬间旧层
 * （is-exiting）保持可见垫在底层，新层（is-active，z-index 更高）从 0 淡入到 1，
 * 结束后旧层才进入 hidden。任何时刻两层覆盖率都是 100%，壁纸不露底。
 */
export function SurfaceDeck({ pages }: { pages: Record<WorkspaceSurface, ReactNode> }) {
  const desired = useWorkspaceStore((state) => state.activeSurface)
  const preferences = useDesktopPreferences()
  const [displayed, setDisplayed] = useState(desired)
  /** 交叉淡化期间仍可见的旧 surface（结束时置回 null → Activity hidden） */
  const [exiting, setExiting] = useState<WorkspaceSurface | null>(null)
  const shown = useRef(desired)
  const stage = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    let disposed = false
    let frame = 0
    const animations: Animation[] = []
    const previous = shown.current
    const direction = surfaceDirection(previous, desired)
    const reduced = preferences.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const lowPerformance = preferences.lowPerformance || document.body.classList.contains('ra-low-performance')
    const focusWasInside = element.contains(document.activeElement)

    const settleFocus = () => {
      frame = window.requestAnimationFrame(() => {
        if (disposed) return
        if (focusWasInside) element.querySelector<HTMLElement>(`[data-workspace-surface="${desired}"]`)?.focus({ preventScroll: true })
      })
    }

    if (previous !== desired) {
      shown.current = desired
      const animate = !reduced && !lowPerformance && direction !== 0 && !!element.animate
      // 同批渲染：新层 is-active + 旧层 is-exiting（无动画路径直接让旧层退场）
      setDisplayed(desired)
      setExiting(animate ? previous : null)
      if (animate) {
        frame = window.requestAnimationFrame(() => {
          if (disposed) return
          const target = element.querySelector<HTMLElement>(`[data-workspace-surface="${desired}"]`)
          const enter = target?.animate([
            { opacity: 0, transform: `translateY(${direction * 14}px)` },
            { opacity: 1, transform: 'translateY(0)' },
          ], { duration: CROSSFADE_MS, easing: 'cubic-bezier(.2,.7,.25,1)' })
          if (enter) {
            animations.push(enter)
            void enter.finished.then(() => {
              if (disposed) return
              setExiting(null)
              settleFocus()
            }, () => undefined)
          } else {
            setExiting(null)
            settleFocus()
          }
        })
      } else {
        settleFocus()
      }
    }
    return () => {
      disposed = true
      window.cancelAnimationFrame(frame)
      for (const animation of animations) animation.cancel()
    }
  }, [desired, preferences.lowPerformance, preferences.reduceMotion])

  return (
    <div className="surface-stage" ref={stage}>
      {SURFACES.map((surface) => {
        const active = surface === displayed
        const leaving = surface === exiting
        const visible = active || leaving
        return (
          <section
            key={surface}
            className={`surface-layer${active ? ' is-active' : ''}${leaving ? ' is-exiting' : ''}`}
            data-workspace-surface={surface}
            aria-label={surfaceLabel(surface)}
            aria-hidden={!visible || undefined}
            inert={!visible || undefined}
            tabIndex={-1}
          >
            {/* 交叉淡化期间旧层保持 Activity visible（效果仍活跃约 150ms，代价可忽略） */}
            <Activity mode={visible ? 'visible' : 'hidden'}>{pages[surface]}</Activity>
          </section>
        )
      })}
    </div>
  )
}
