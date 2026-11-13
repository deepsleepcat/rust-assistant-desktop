/**
 * AI 对话客户端（手机版 v1）：
 * - 单次请求走 Rust ai_stream（SSE 流式转发），事件经 tauri 事件通道回流；
 * - 对话循环：模型返回 tool_calls → 执行工具（写文件经审批）→ 结果回传 → 继续，
 *   直到模型不再请求工具（最多 MAX_TOOL_ROUNDS 轮防死循环）；
 * - 无工具请求时（写文件等待审批期间）置 no_tools 避免模型重复请求。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { AiChatMessage, AiSettings } from '../../types/ai'
import { AI_TOOLS, runTool, toolResultToMessage, type AiToolContext } from './rustAgentTools'
import { RUST_ASSISTANT_SYSTEM_PROMPT } from '../../ai/rustSystemPrompt'

export const AI_EVENT_CHANNEL = 'ai://event'

/** 单次请求的事件回调 */
export interface ChatOnceCallbacks {
  onDelta: (text: string) => void
  onStart?: () => void
}

export interface ChatOnceResult {
  fullText: string
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | null
}

/** 单次流式请求（Rust 代理 → SSE 事件）
 *
 * 中止链路：UI 停止按钮 → runAgentChat 的 isAborted() 为 true
 *  → chatOnce 看门狗检测到后 invoke('ai_stream_abort', { requestId }) 标记该请求
 *  → ai_stream 的 SSE 循环在下一轮迭代时提前终止（错误经 invoke reject 回流）
 *
 * 每个请求带唯一 requestId：Rust 端每个事件都回显，前端据此过滤——
 * 超时/中止后旧流（僵尸流）的迟到 Done/Delta 不会串扰下一次请求
 * （否则旧文本/旧工具调用会被误当新回合结果执行）。
 */
export async function chatOnce(
  settings: AiSettings,
  messages: AiChatMessage[],
  opts: { tools?: boolean; onDelta: (text: string) => void; isAborted?: () => boolean },
): Promise<ChatOnceResult> {
  return new Promise<ChatOnceResult>((resolve, reject) => {
    let unlisten: UnlistenFn | null = null
    let fullText = ''
    let toolCallsJson: string | null = null
    const requestId = crypto.randomUUID()
    let abortNotified = false
    const abortWatchdog = setInterval(() => {
      if (opts.isAborted?.()) {
        clearInterval(abortWatchdog)
        if (!abortNotified) {
          abortNotified = true
          void invoke('ai_stream_abort', { requestId }).catch(() => undefined)
          unlisten?.()
          clearTimeout(timer)
          reject(new Error('已中止'))
        }
      }
    }, 100)
    const cleanup = () => {
      clearInterval(abortWatchdog)
      clearTimeout(timer)
      unlisten?.()
    }
    const timer = setTimeout(() => {
      cleanup()
      // 尽力中止 Rust 侧仍在跑的流，避免僵尸流继续消耗网络与产生迟到事件
      void invoke('ai_stream_abort', { requestId }).catch(() => undefined)
      reject(new Error('AI 响应超时（120 秒未完成），请重试'))
    }, 120_000)

    listen<unknown>(AI_EVENT_CHANNEL, (ev) => {
      const payload = ev.payload as {
        request_id?: string
        type: 'start' | 'delta' | 'done' | 'error'
        text?: string
        full_text?: string
        tool_calls?: string | null
        message?: string
      }
      if (payload.request_id !== requestId) return
      if (payload.type === 'delta' && payload.text) {
        fullText += payload.text
        opts.onDelta(payload.text)
      } else if (payload.type === 'done') {
        cleanup()
        fullText = payload.full_text ?? fullText
        toolCallsJson = payload.tool_calls ?? null
        let toolCalls: ChatOnceResult['toolCalls'] = null
        if (toolCallsJson) {
          try {
            toolCalls = (JSON.parse(toolCallsJson) as Array<{ id: string; function: { name: string; arguments: string } }>).map(
              (tc) => ({
                id: tc.id,
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
              }),
            )
          } catch {
            toolCalls = null
          }
        }
        resolve({ fullText, toolCalls })
      } else if (payload.type === 'error') {
        cleanup()
        reject(new Error(payload.message ?? 'AI 请求失败'))
      }
    }).then((fn) => {
      unlisten = fn
      void invoke('ai_stream', {
        request: {
          requestId,
          apiKey: settings.deepseekApiKey,
          model: settings.deepseekModel,
          systemPrompt: RUST_ASSISTANT_SYSTEM_PROMPT,
          messages,
          tools: opts.tools === false ? [] : AI_TOOLS,
          noTools: opts.tools === false,
        },
      }).catch((err) => {
        cleanup()
        reject(new Error(typeof err === 'string' ? err : 'AI 请求失败'))
      })
    })
  })
}

export const MAX_TOOL_ROUNDS = 8

export interface AgentChatOptions {
  settings: AiSettings
  projectRoot: string
  messages: AiChatMessage[]
  onDelta: (text: string) => void
  /** 工具调用事件（UI 展示卡片用） */
  onTool?: (ev: { name: string; args: Record<string, unknown>; ok: boolean; summary: string }) => void
  /** 写文件审批（默认拒绝） */
  approveWrite: AiToolContext['approveWrite']
  /** 是否中止（UI 停止按钮） */
  isAborted?: () => boolean
}

/** 完整对话循环：流式回复 + 工具调用闭环 */
export async function runAgentChat(opts: AgentChatOptions): Promise<string> {
  const messages = [...opts.messages]
  const ctx: AiToolContext = { rootPath: opts.projectRoot, approveWrite: opts.approveWrite }
  let finalText = ''

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (opts.isAborted?.()) return finalText || '（已中止）'
    let result: ChatOnceResult
    try {
      result = await chatOnce(opts.settings, messages, { onDelta: opts.onDelta, isAborted: opts.isAborted })
    } catch (err) {
      // 用户主动中止（看门狗 reject）：按中止语义优雅返回（不打断整个页面）。
      // 其余失败（401/网络断开/超时）必须继续上抛，让 AiScreen 的 catch 显示
      // 错误信息——不能把所有 reject 都吞成「已中止」，否则请求失败在界面上
      // 表现为空白回复，用户无法区分「已停止」和「请求失败」。
      if (opts.isAborted?.()) return finalText || '（已中止）'
      throw err
    }
    finalText = result.fullText
    if (!result.toolCalls || result.toolCalls.length === 0) {
      // 模型结束（无工具调用）
      messages.push({ role: 'assistant', content: finalText })
      return finalText
    }
    // 有工具调用：assistant 消息 + 逐个执行
    messages.push({ role: 'assistant', content: finalText || '（调用工具中…）' })
    let allOk = true
    for (const tc of result.toolCalls) {
      const toolResult = await runTool(tc.name, tc.arguments, ctx)
      opts.onTool?.({
        name: tc.name,
        args: tc.arguments,
        ok: toolResult.ok,
        summary: toolResult.ok ? toolResult.output.slice(0, 200) : toolResult.error,
      })
      messages.push(toolResultToMessage(tc.name, toolResult))
      if (!toolResult.ok) allOk = false
    }
    // 写文件被拒/工具失败时再给模型一轮机会解释或调整
    void allOk
  }
  return finalText || '（工具调用轮数超限，请精简需求后重试）'
}
