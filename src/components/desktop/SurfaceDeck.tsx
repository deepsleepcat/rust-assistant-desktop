import { Activity, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import type { WorkspaceSurface } from '../../stores/types'
import { surfaceDirection, surfaceLabel } from './shellContract'
import { useDesktopPreferences } from './desktopPreferences'

const SURFACES: readonly WorkspaceSurface[] = ['editor', 'dashboard', 'community', 'cloudBag', 'settings']

/** Activity retains local state and pauses effects (including hidden dialog traps). */
export function SurfaceDeck({ pages }: { pages: Record<WorkspaceSurface, ReactNode> }) {
  const desired = useWorkspaceStore((state) => state.activeSurface)
  const preferences = useDesktopPreferences()
  const [displayed, setDisplayed] = useState(desired)
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

    const commit = () => {
      if (disposed) return
      shown.current = desired
      setDisplayed(desired)
      frame = window.requestAnimationFrame(() => {
        if (disposed) return
        if (focusWasInside) element.querySelector<HTMLElement>(`[data-workspace-surface="${desired}"]`)?.focus({ preventScroll: true })
        if (!reduced && !lowPerformance && direction !== 0 && element.animate) {
          animations.push(element.animate([
            { opacity: 0, transform: `translateY(${direction * 14}px)` },
            { opacity: 1, transform: 'translateY(0)' },
          ], { duration: 120, easing: 'cubic-bezier(.2,.7,.25,1)' }))
        }
        exit?.cancel()
      })
    }

    let exit: Animation | undefined
    if (previous !== desired) {
      if (reduced || lowPerformance || direction === 0 || !element.animate) {
        frame = window.requestAnimationFrame(commit)
      } else {
        exit = element.animate([
          { opacity: 1, transform: 'translateY(0)' },
          { opacity: 0, transform: `translateY(${-direction * 14}px)` },
        ], { duration: 100, easing: 'ease-in', fill: 'forwards' })
        animations.push(exit)
        void exit.finished.then(commit, () => undefined)
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
      {SURFACES.map((surface) => (
        <section key={surface} className={`surface-layer${surface === displayed ? ' is-active' : ''}`}
          data-workspace-surface={surface} aria-label={surfaceLabel(surface)}
          aria-hidden={surface !== displayed || surface !== desired} inert={surface !== displayed || surface !== desired} tabIndex={-1}>
          <Activity mode={surface === displayed ? 'visible' : 'hidden'}>{pages[surface]}</Activity>
        </section>
      ))}
    </div>
  )
}
