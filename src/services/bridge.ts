/**
 * 桥服务：返回可用的 BridgeApi。
 * - Electron 环境：使用预加载脚本注入的 window.rustAssistant；
 * - 浏览器预览/测试环境：自动降级为 Mock 桥（内存文件系统）。
 */
import type { BridgeApi } from '../types/bridge'
import { createMockBridge } from './mockBridge'

export const isElectron = typeof window !== 'undefined' && !!window.rustAssistant

let mock: BridgeApi | null = null

export function getBridge(): BridgeApi {
  if (typeof window !== 'undefined' && window.rustAssistant) return window.rustAssistant
  if (!mock) mock = createMockBridge()
  return mock
}
