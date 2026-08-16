/**
 * M29 弹窗焦点管理：
 * - useFocusTrap：弹窗打开时把焦点移入（优先 [autofocus]），Tab 在弹窗内循环，
 *   关闭后恢复到打开前焦点元素；
 * - getFocusableElements：查找容器内可聚焦元素（含 tabIndex=-1 的显式焦点元素）。
 */
import { useEffect, type RefObject } from 'react'

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(',')
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  active: boolean,
  restoreOnInactive = true,
) {
  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return
    const previouslyFocused = document.activeElement as HTMLElement | null

    // 初始焦点：优先 [autofocus]，否则容器内第一个可聚焦元素，最后回退容器本身
    const auto = container.querySelector<HTMLElement>('[autofocus]')
    const first = auto ?? getFocusableElements(container)[0] ?? container
    // 延后到下一帧：让入场动画/React 完成渲染后再聚焦
    const raf = requestAnimationFrame(() => first.focus())

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const els = getFocusableElements(container)
      if (els.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const firstEl = els[0]
      const lastEl = els[els.length - 1]
      const activeEl = document.activeElement as HTMLElement | null
      if (e.shiftKey && (activeEl === firstEl || !container.contains(activeEl))) {
        e.preventDefault()
        lastEl.focus()
      } else if (!e.shiftKey && (activeEl === lastEl || !container.contains(activeEl))) {
        e.preventDefault()
        firstEl.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', onKeyDown, true)
      // 关闭后恢复焦点：焦点元素必须还在文档里（弹窗卸载后不在）
      if (restoreOnInactive && previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [active, containerRef, restoreOnInactive])
}
