/**
 * runAgentChat 错误传导回归：
 * chatOnce 因 API 错误（401）/网络失败 reject 时，runAgentChat 必须继续上抛，
 * 让 AiScreen 的 catch 显示错误信息；只有用户主动中止才按「已中止」语义返回。
 * 回归背景：曾把所有 reject 都吞成「（已中止）」，401/断网在界面上表现为空白回复，
 * 用户无法区分「已停止」和「请求失败」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../src/services/bridge', () => ({ getBridge: () => ({}) }))

import { runAgentChat } from '../src/features/ai/aiClient'
import { DEFAULT_SETTINGS } from '../src/utils/settings'

// key 值无关紧要（invoke 已 mock），用默认设置避免测试里出现凭据样字面量
const SETTINGS = { ...DEFAULT_SETTINGS.ai }

function baseOpts(overrides: Partial<Parameters<typeof runAgentChat>[0]> = {}): Parameters<typeof runAgentChat>[0] {
  return {
    settings: SETTINGS,
    projectRoot: '/app/projects/demo',
    messages: [{ role: 'user', content: 'hello' }],
    onDelta: () => {},
    approveWrite: async () => false,
    ...overrides,
  }
}

afterEach(() => {
  invokeMock.mockReset()
})

describe('runAgentChat 错误传导', () => {
  it('请求失败（401）时继续上抛，不吞成「已中止」', async () => {
    invokeMock.mockRejectedValue('HTTP 401: invalid API key')
    await expect(
      runAgentChat(baseOpts({ isAborted: () => false })),
    ).rejects.toThrow('HTTP 401: invalid API key')
  })

  it('用户主动中止时仍按中止语义优雅返回', async () => {
    let aborted = false
    // invoke 挂起（流进行中），10ms 后用户点「停止」→ 看门狗 reject「已中止」
    invokeMock.mockImplementation(() => {
      setTimeout(() => {
        aborted = true
      }, 10)
      return new Promise(() => {})
    })
    const result = await runAgentChat(baseOpts({ isAborted: () => aborted }))
    expect(result).toBe('（已中止）')
  })
})
