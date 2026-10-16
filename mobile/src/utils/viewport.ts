/**
 * 软键盘 / 可视视口适配。
 *
 * Android WebView 在部分机型（尤其是我们的 Tauri 宿主）不会随软键盘收缩
 * 布局视口，`100dvh` 于是就等于「整屏高度」，键盘弹起后编辑器下半部分
 * （连同工具栏、保存按钮）会被挡住。
 *
 * 这里把 visualViewport 的实时高度写进 CSS 变量 `--app-viewport-height`，
 * 布局用 `var(--app-viewport-height, 100dvh)`：能正常 resize 的宿主行为不变，
 * 不能 resize 的宿主得到可用高度。卸载时清理变量与监听。
 */
import { useEffect } from 'react'

export const VIEWPORT_HEIGHT_VAR = '--app-viewport-height'

export function useViewportHeight(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return

    const apply = () => {
      if (vv.height > 0) {
        document.documentElement.style.setProperty(VIEWPORT_HEIGHT_VAR, `${Math.round(vv.height)}px`)
      }
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
      document.documentElement.style.removeProperty(VIEWPORT_HEIGHT_VAR)
    }
  }, [])
}
