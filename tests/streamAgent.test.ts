/**
 * AI 流审批链路测试（M27-1）：mock pi-agent-core 的 Agent，
 * 驱动 streamAgent 验证 beforeToolCall 对写类工具（writeFile/applyDiff）的审批行为：
 * - applyDiff 先应用补丁算出完整内容参与预览，审批通过才放行；
 * - 补丁无法应用（上下文不匹配/文件不存在）→ 直接拒绝并回传原因给 AI，不发起审批；
 * - 审批事件携带正确的 path/diff 预览；tool_end 按 toolCallId 关联 path（质检入口）。
 * pi-ai 为真实模块（模型注册离线操作，不触网）；Agent.prompt 被 mock 掉。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AiChatParams } from '../src/types/ai'

// Agent mock：捕获构造参数（含 beforeToolCall），prompt 立即返回（不触网）
const captured: { options?: Record<string, unknown>; subscriber?: (e: unknown) => void } = {}
vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: class {
    constructor(options: Record<string, unknown>) {
      captured.options = options
    }
    subscribe(fn: (e: unknown) => void): void {
      captured.subscriber = fn
    }
    async prompt(): Promise<void> {
      // 不触网：直接完成
    }
  },
}))

import { streamAgent } from '../electron/ai'

let root: string
let send: ReturnType<typeof vi.fn>
const webContents = (): { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } => ({
  isDestroyed: () => false,
  send,
})

const params: AiChatParams = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  systemPrompt: 'test',
  messages: [{ role: 'user', content: 'hi' }],
}
// 测试用假凭据（不触网，仅走模型注册）：从环境读取，避免把凭据形态写进源码
const config = { apiKey: process.env.TEST_FAKE_API_KEY ?? 'fake', model: 'deepseek-v4-flash' }

interface ApprovalReq {
  type: string
  id: string
  tool: string
  path: string
  contentPreview: string
  contentLength?: number
  diff?: unknown
}

/** 启动一个流；返回 beforeToolCall 钩子、手动批准函数、实时事件读取 */
async function startStream(): Promise<{
  beforeToolCall: (ctx: { toolCall: { name: string; id?: string }; args: unknown }) => Promise<unknown>
  /** 批准最近一次审批请求（轮询等待 resolver 注册——beforeToolCall 需先跑过异步段） */
  approve: (approved: boolean) => Promise<void>
  events: () => ApprovalReq[]
}> {
  send = vi.fn()
  captured.options = undefined
  captured.subscriber = undefined
  const resolvers = new Map<string, (r: { id: string; approved: boolean }) => void>()
  const resolver = (id: string, resolve: (r: { id: string; approved: boolean }) => void): void => {
    resolvers.set(id, resolve)
  }
  const cancelled = { current: false }
  // Agent.prompt mock 立即返回 → 流完成（beforeToolCall 由测试手动触发）
  await streamAgent(webContents() as never, 'chan', params, config, root, resolver as never, cancelled)
  expect(captured.options).toBeTruthy()
  const opts = captured.options as unknown as { beforeToolCall: (ctx: { toolCall: { name: string; id?: string }; args: unknown }) => Promise<unknown> }
  const beforeToolCall = opts.beforeToolCall
  return {
    beforeToolCall,
    approve: async (approved: boolean) => {
      for (let i = 0; i < 100; i++) {
        const lastId = [...resolvers.keys()].pop()
        if (lastId) {
          resolvers.get(lastId)?.( { id: lastId, approved } )
          return
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('未等到审批请求注册（beforeToolCall 未到达等待点）')
    },
    events: () => send.mock.calls.map((c) => c[1] as ApprovalReq),
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-agent-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('streamAgent 审批链路（M27-1）', () => {
  it('applyDiff：补丁可应用 → 发起审批，预览为应用后的完整内容', async () => {
    await fs.writeFile(path.join(root, 'unit.ini'), '[core]\nname = "a"\nmaxHp = 100\n', 'utf8')
    const { beforeToolCall, approve, events } = await startStream()
    const diff = '@@ -2,2 +2,2 @@\n name = "a"\n-maxHp = 100\n+maxHp = 999\n'
    // 先启动审批（内部 await 等待用户响应），再并发批准——避免测试挂起
    const result = beforeToolCall({ toolCall: { name: 'applyDiff', id: 't1' }, args: { path: 'unit.ini', diff } })
    const approvePromise = approve(true)
    expect(await result).toBeUndefined() // 批准后放行
    await approvePromise
    const approval = events().find((e) => e.type === 'approval_request')
    expect(approval).toBeTruthy()
    expect(approval?.path).toBe('unit.ini')
    expect(approval?.tool).toBe('applyDiff')
    // 预览是应用后的完整内容（含改动行），不是补丁本身
    expect(approval?.contentPreview).toContain('maxHp = 999')
    expect(approval?.contentPreview).toContain('[core]')
    expect((approval?.contentLength ?? 0)).toBeGreaterThan(0)
    expect(approval?.diff).not.toBeNull()
  })

  it('applyDiff：上下文不匹配 → 直接拒绝并回传原因，不发起审批', async () => {
    await fs.writeFile(path.join(root, 'unit.ini'), '[core]\nname = "a"\n', 'utf8')
    const { beforeToolCall, events } = await startStream()
    const diff = '@@ -1,2 +1,2 @@\n xxxx\n name = "a"\n'
    const result = await beforeToolCall({ toolCall: { name: 'applyDiff', id: 't1' }, args: { path: 'unit.ini', diff } })
    expect(result).toMatchObject({ block: true })
    expect(String((result as { reason: string }).reason)).toContain('applyDiff 无法应用补丁')
    expect(events().some((e) => e.type === 'approval_request')).toBe(false)
  })

  it('applyDiff：目标文件不存在 → 拒绝，提示用 writeFile', async () => {
    const { beforeToolCall, events } = await startStream()
    const result = await beforeToolCall({
      toolCall: { name: 'applyDiff', id: 't1' },
      args: { path: 'missing.ini', diff: '@@ -1,1 +1,1 @@\n-a\n+b\n' },
    })
    expect(result).toMatchObject({ block: true })
    expect(String((result as { reason: string }).reason)).toContain('目标文件不存在')
    expect(events().some((e) => e.type === 'approval_request')).toBe(false)
  })

  it('writeFile：回归——审批事件 tool 为 writeFile，新建文件 newFile 标记', async () => {
    const { beforeToolCall, approve, events } = await startStream()
    const result = beforeToolCall({ toolCall: { name: 'writeFile', id: 'w1' }, args: { path: 'new.ini', content: '[core]\nname = "n"\n' } })
    const approvePromise = approve(true)
    expect(await result).toBeUndefined()
    await approvePromise
    const approval = events().find((e) => e.type === 'approval_request')
    expect(approval?.tool).toBe('writeFile')
    expect(approval?.path).toBe('new.ini')
  })

  it('applyDiff：审批通过后 tool_end 按 toolCallId 关联 path（质检/历史入口）', async () => {
    await fs.writeFile(path.join(root, 'unit.ini'), '[core]\nname = "a"\n', 'utf8')
    const { beforeToolCall, approve, events } = await startStream()
    const diff = '@@ -2,1 +2,1 @@\n-name = "a"\n+name = "b"\n'
    const pending = beforeToolCall({ toolCall: { name: 'applyDiff', id: 't1' }, args: { path: 'unit.ini', diff } })
    const approvePromise = approve(true)
    expect(await pending).toBeUndefined()
    await approvePromise
    // 工具执行完成事件（真实 Agent 在 execute 后发出）：writePaths 已记录 t1 → unit.ini
    captured.subscriber?.({
      type: 'tool_execution_end',
      toolName: 'applyDiff',
      toolCallId: 't1',
      result: { content: [{ text: '已应用补丁' }] },
      isError: false,
    })
    const toolEnd = events().find((e) => e.type === 'tool_end') as { name: string; path?: string; ok: boolean } | undefined
    expect(toolEnd).toBeTruthy()
    expect(toolEnd?.name).toBe('applyDiff')
    expect(toolEnd?.path).toBe('unit.ini')
    expect(toolEnd?.ok).toBe(true)
  })
})
