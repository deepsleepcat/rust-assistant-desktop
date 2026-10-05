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

/** 单次流式请求（Rust 代理 → SSE 事件） */
export async function chatOnce(
  settings: AiSettings,
  messages: AiChatMessage[],
  opts: { tools?: boolean; onDelta: (text: string) => void },
): Promise<ChatOnceResult> {
  return new Promise<ChatOnceResult>((resolve, reject) => {
    let unlisten: UnlistenFn | null = null
    let fullText = ''
    let toolCallsJson: string | null = null
    const timer = setTimeout(() => {
      unlisten?.()
      reject(new Error('AI 响应超时（30s 无事件），请重试'))
    }, 120_000)

    listen<unknown>(AI_EVENT_CHANNEL, (ev) => {
      const payload = ev.payload as {
        type: 'start' | 'delta' | 'done' | 'error'
        text?: string
        full_text?: string
        tool_calls?: string | null
        message?: string
      }
      if (payload.type === 'delta' && payload.text) {
        fullText += payload.text
        opts.onDelta(payload.text)
      } else if (payload.type === 'done') {
        clearTimeout(timer)
        unlisten?.()
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
        clearTimeout(timer)
        unlisten?.()
        reject(new Error(payload.message ?? 'AI 请求失败'))
      }
    }).then((fn) => {
      unlisten = fn
      void invoke('ai_stream', {
        request: {
          apiKey: settings.deepseekApiKey,
          model: settings.deepseekModel,
          systemPrompt: RUST_ASSISTANT_SYSTEM_PROMPT,
          messages,
          tools: opts.tools === false ? [] : AI_TOOLS,
          noTools: opts.tools === false,
        },
      }).catch((err) => {
        clearTimeout(timer)
        unlisten?.()
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
    const result = await chatOnce(opts.settings, messages, { onDelta: opts.onDelta })
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
