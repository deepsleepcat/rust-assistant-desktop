import type { BridgeApi } from './bridge'

declare global {
  interface Window {
    /** Electron 预加载脚本暴露的安全桥；浏览器预览模式下不存在 */
    rustAssistant?: BridgeApi
  }
}

export {}
