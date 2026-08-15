/**
 * AI 消息流测试（第一线 ②：补核心链路测试——sendAiMessage/respondApproval）。
 * 之前 store 的 AI 流（发消息→工具调用→审批→写后质检→完成）零测试；
 * 这里用 Mock 桥 + 自定义事件序列模拟完整 AI 会话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge } from '../src/services/mockBridge'
import type { AiStreamEvent } from '../src/types/ai'

// M26 审查修复（M1）：写后质检链路真实可测——mock checkAiWrittenFile 返回固定问题，
// 断言其挂到对应 writeFile 工具卡片上（真实实现依赖主进程文件，测试环境读不到）
vi.mock('../src/features/ai/aiQualityCheck', () => ({
  checkAiWrittenFile: vi.fn(async (_root: string, relPath: string) =>
    /\.(ini|template)$/i.test(relPath)
      ? [{ line: 3, message: '血量超出推荐范围', severity: 'warning' as const, suggestion: '调低 maxHp' }]
      : null,
  ),
}))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** node 测试环境没有 localStorage：mock 桥的存储/用量统计依赖它 */
function setupLocalStorage(): void {
  const mem = new Map<string, string>()
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => { mem.clear() },
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
}

describe('AI 消息流（sendAiMessage）', () => {
  let bridge: ReturnType<typeof createMockBridge>
  let store: ReturnType<typeof createWorkspaceStore>
  let convId: string
  /** 测试自持的 AI 事件监听器（模拟主进程推送） */
  let listeners: Set<(e: AiStreamEvent) => void>
  let emit: (e: AiStreamEvent) => void

  beforeEach(async () => {
    setupLocalStorage()
    bridge = createMockBridge()
    store = createWorkspaceStore(bridge)
    await store.getState().init()
    await store.getState().openProject()
    store.getState().createConversation()
    convId = store.getState().conversations[0].id

    listeners = new Set()
    emit = (e) => listeners.forEach((l) => l(e))
    bridge.ai.onAiEvent = (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('全链路：流式回复 → 工具调用 → 审批 → 写后质检 → 完成', async () => {
    let approvedPayload: { id: string; approved: boolean } | null = null
    bridge.ai.approve = async (r) => {
      approvedPayload = r
      return true
    }
    bridge.ai.stream = async () => {
      emit({ type: 'delta', text: '好的，我来创建。' })
      await sleep(5)
      emit({ type: 'tool_start', name: 'writeFile', args: { path: 'units/new.ini', content: '[core]\nname="新单位"\n' } })
      await sleep(5)
      emit({ type: 'approval_request', id: 'appr-1', tool: 'writeFile', path: 'units/new.ini', contentPreview: '[core]', contentLength: 22, diff: null, diffSummary: null, oldExists: false, newFile: true })
      await sleep(5)
      emit({ type: 'tool_end', name: 'writeFile', ok: true, summary: '已新增 units/new.ini', path: 'units/new.ini', snapshotId: 'snap-1', snapshotSkipped: false })
      await sleep(5)
      emit({ type: 'done', fullText: '写好了' })
      return 'ai:stream'
    }

    const send = store.getState().sendAiMessage(convId, '帮我新建一个单位')

    // 审批弹窗出现：内容预览 + 新文件标记
    await vi.waitFor(() => expect(store.getState().pendingApproval?.id).toBe('appr-1'))
    expect(store.getState().pendingApproval?.newFile).toBe(true)
    expect(store.getState().pendingApproval?.path).toBe('units/new.ini')

    // 用户批准 → 主进程收到审批响应
    await store.getState().respondApproval(true)
    expect(approvedPayload).toEqual({ id: 'appr-1', approved: true })

    await send
    // 写后质检是异步 IIFE（不阻塞流）：给一点时间让 lint 结果挂到工具卡片
    await sleep(80)

    const conv = store.getState().conversations.find((c) => c.id === convId)!
    // 消息：用户 + AI 流式填充
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(conv.messages[0].content).toBe('帮我新建一个单位')
    expect(conv.messages[1].content).toContain('好的，我来创建')
    // 工具卡片：tool_start（content 已剥离防持久化膨胀）+ tool_end（带快照 id）
    const starts = (conv.toolEvents ?? []).filter((t) => t.type === 'tool_start')
    expect(starts.length).toBe(1)
    expect(starts[0].args).not.toHaveProperty('content')
    expect(starts[0].args).toHaveProperty('path')
    const ends = (conv.toolEvents ?? []).filter((t) => t.type === 'tool_end')
    expect(ends.length).toBe(1)
    expect(ends[0].ok).toBe(true)
    expect(ends[0].path).toBe('units/new.ini')
    expect(ends[0].snapshotId).toBe('snap-1')
    // 写后质检结果挂到本次 writeFile 的工具卡片上（文件 + 行号 + 建议）
    expect(ends[0].lint).toEqual([
      { line: 3, message: '血量超出推荐范围', severity: 'warning', suggestion: '调低 maxHp' },
    ])
    // 流结束：锁释放、审批清空
    expect(store.getState().aiStreamingConversationId).toBeNull()
    expect(store.getState().pendingApproval).toBeNull()
  })

  it('审批被拒绝：响应传 false，弹窗关闭', async () => {
    let approvedPayload: { id: string; approved: boolean } | null = null
    bridge.ai.approve = async (r) => {
      approvedPayload = r
      return true
    }
    bridge.ai.stream = async () => {
      emit({ type: 'approval_request', id: 'appr-2', tool: 'writeFile', path: 'units/x.txt', contentPreview: 'x', contentLength: 1 })
      await sleep(5)
      emit({ type: 'done', fullText: '好的，不写' })
      return 'ai:stream'
    }
    const send = store.getState().sendAiMessage(convId, '写个文件')
    await vi.waitFor(() => expect(store.getState().pendingApproval?.id).toBe('appr-2'))
    await store.getState().respondApproval(false)
    expect(approvedPayload).toEqual({ id: 'appr-2', approved: false })
    await send
    expect(store.getState().pendingApproval).toBeNull()
  })

  it('错误事件：写入失败消息并释放通道', async () => {
    bridge.ai.stream = async () => {
      emit({ type: 'error', message: 'API Key 无效，请在设置中检查' })
      return 'ai:stream'
    }
    await store.getState().sendAiMessage(convId, '你好')
    const conv = store.getState().conversations.find((c) => c.id === convId)!
    expect(conv.messages[1].content).toContain('AI 请求失败：API Key 无效')
    expect(store.getState().aiStreamingConversationId).toBeNull()
    expect(store.getState().toast).toContain('API Key 无效')
  })

  it('stream 返回 Promise 失败：同样落失败消息，不锁死通道', async () => {
    bridge.ai.stream = async () => {
      throw new Error('网络连接失败')
    }
    await store.getState().sendAiMessage(convId, '你好')
    const conv = store.getState().conversations.find((c) => c.id === convId)!
    expect(conv.messages[1].content).toContain('AI 请求失败：网络连接失败')
    expect(store.getState().aiStreamingConversationId).toBeNull()
  })

  it('空白消息直接忽略（不调用 stream）', async () => {
    let called = false
    bridge.ai.stream = async () => {
      called = true
      return 'ai:stream'
    }
    await store.getState().sendAiMessage(convId, '   ')
    expect(called).toBe(false)
    const conv = store.getState().conversations.find((c) => c.id === convId)!
    expect(conv.messages.length).toBe(0)
  })

  it('流式回复中拒绝第二条消息（提示不打扰，不重复入队）', async () => {
    bridge.ai.stream = async () => {
      await new Promise<void>(() => { /* 永不结束：模拟挂起流 */ })
      return 'ai:stream'
    }
    void store.getState().sendAiMessage(convId, '第一条')
    await vi.waitFor(() => expect(store.getState().aiStreamingConversationId).toBe(convId))
    await store.getState().sendAiMessage(convId, '第二条')
    const conv = store.getState().conversations.find((c) => c.id === convId)!
    expect(conv.messages.filter((m) => m.role === 'user').length).toBe(1)
    expect(store.getState().toast).toContain('AI 正在回复中')
  })

  it('5 分钟看门狗：流无任何事件时释放通道并通知主进程中止', async () => {
    vi.useFakeTimers()
    let aborted = false
    bridge.ai.streamAbort = async () => {
      aborted = true
      return { aborted: true }
    }
    bridge.ai.stream = async () => {
      await new Promise<void>(() => { /* 永不结束且无事件 */ })
      return 'ai:stream'
    }
    void store.getState().sendAiMessage(convId, '你好')
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000)
    expect(aborted).toBe(true)
    expect(store.getState().aiStreamingConversationId).toBeNull()
    expect(store.getState().pendingApproval).toBeNull()
  })

  it('审批过期（主进程返回 false）：明确提示未生效', async () => {
    bridge.ai.approve = async () => false // 120s 超时后主进程已按拒绝处理
    bridge.ai.stream = async () => {
      emit({ type: 'approval_request', id: 'appr-3', tool: 'writeFile', path: 'units/x.txt', contentPreview: 'x', contentLength: 1 })
      await sleep(5)
      emit({ type: 'done', fullText: '完成' })
      return 'ai:stream'
    }
    const send = store.getState().sendAiMessage(convId, '写个文件')
    await vi.waitFor(() => expect(store.getState().pendingApproval?.id).toBe('appr-3'))
    await store.getState().respondApproval(true)
    expect(store.getState().toast).toContain('审批已过期')
    await send
  })

  it('reasoning（思考过程）实时追加', async () => {
    bridge.ai.stream = async () => {
      emit({ type: 'reasoning', text: '思考第一步' })
      await sleep(5)
      emit({ type: 'reasoning', text: '，思考第二步' })
      await sleep(5)
      emit({ type: 'done', fullText: '' })
      return 'ai:stream'
    }
    await store.getState().sendAiMessage(convId, '想一想')
    const conv = store.getState().conversations.find((c) => c.id === convId)!
    expect(conv.messages[1].reasoning).toContain('思考第一步')
    expect(conv.messages[1].reasoning).toContain('思考第二步')
  })
})
