/**
 * 主进程 AI 服务：DeepSeek 提供者（基于 Pi 引擎）。
 *
 * - 运行在 Electron 主进程（Node 环境），渲染进程通过 IPC 调用；
 * - DeepSeek 通过 pi-ai 的 OpenAI 兼容 provider 接入；
 * - CommunityProvider 为闭源社区后端预留（协议 OpenAI 兼容，占位实现）；
 * - 流式对话通过 webContents.send 推送事件给界面。
 */
import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AiCheckResult, AiApprovalResponse, AiChatParams, AiProviderType, AiStreamEvent } from '../src/types/ai'
import { createRustAgentTools, setAgentRoot } from './rustAgentTools'
import type { AgentTool } from '@earendil-works/pi-agent-core'

let piAi: typeof import('@earendil-works/pi-ai') | null = null

/** 懒加载 pi-ai（ESM 包，主进程为 CJS，需动态 import） */
async function loadPiAi() {
  if (!piAi) {
    piAi = await import('@earendil-works/pi-ai')
  }
  return piAi
}

interface DeepSeekConfig {
  apiKey: string
  model: string
}

/** DeepSeek V4 官方模型与定价（人民币/百万 tokens，来源 api-docs.deepseek.com） */
const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    reasoning: false,
    cost: { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 1 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    reasoning: true,
    cost: { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 3 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
]

/** 旧模型名 → V4 迁移（deepseek-chat 已停推） */
const MODEL_MIGRATION: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
}

/** 注册 DeepSeek provider（pi-ai 自定义 provider，离线注册） */
async function createDeepSeekModel(config: DeepSeekConfig) {
  const { createModels, createProvider, envApiKeyAuth } = await loadPiAi()
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
  const modelId = MODEL_MIGRATION[config.model] ?? config.model ?? 'deepseek-v4-flash'
  const spec = DEEPSEEK_MODELS.find((m) => m.id === modelId) ?? DEEPSEEK_MODELS[0]
  const models = createModels()
  models.setProvider(createProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    auth: { apiKey: envApiKeyAuth('DeepSeek API key', ['DEEPSEEK_API_KEY']) },
    api: openAICompletionsApi(),
    models: [{
      id: spec.id,
      name: spec.name,
      api: 'openai-completions' as const,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      reasoning: spec.reasoning,
      input: ['text'] as const,
      cost: spec.cost,
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
    }],
  }))
  return { models, model: models.getModel('deepseek', spec.id) }
}

/** DeepSeek 健康检查：真实请求一次极简对话 */
export async function checkDeepSeek(config: DeepSeekConfig): Promise<AiCheckResult> {
  if (!config.apiKey) return { ok: false, message: '未配置 DeepSeek API Key，请在设置中填写' }
  try {
    const { models, model } = await createDeepSeekModel(config)
    if (!model) return { ok: false, message: '模型注册失败' }
    const reply = await models.completeSimple(model, {
      systemPrompt: 'Reply with exactly: OK',
      messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
    }, { apiKey: config.apiKey })
    const content = reply.content as unknown
    const text = typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ text?: string }>).map((c) => c.text ?? '').join('') : ''
    return { ok: true, message: text.trim() || '连接成功' }
  } catch (err) {
    return { ok: false, message: toFriendlyError(err) }
  }
}

/** Agent 模式：带铁锈战争工具与写文件审批的完整对话循环。
 * cancelled：流级取消标志（abort 只置当前流的标志，新流不复位旧流）。
 * 置位后 emit 全部静默——旧流事件不会泄漏到渲染层新流的监听器；
 * 联动 AbortController 硬停止在途模型请求（停止计费）。 */
export async function streamAgent(
  webContents: WebContents,
  channel: string,
  params: AiChatParams,
  config: DeepSeekConfig,
  projectRoot: string,
  approvalResolver: (id: string, resolve: (response: AiApprovalResponse) => void) => void,
  cancelled: { current: boolean; abort?: () => void },
): Promise<void> {
  const emit = (event: AiStreamEvent) => {
    // 流已取消（abort 后）：事件一律不再发出，防止陈旧流污染新流对话/审批
    if (cancelled.current) return
    if (!webContents.isDestroyed()) webContents.send(channel, event)
  }
  try {
    const { Agent } = await import('@earendil-works/pi-agent-core')
    const { models, model } = await createDeepSeekModel(config)
    if (!model) throw new Error('模型注册失败')
    setAgentRoot(projectRoot)
    const tools = createRustAgentTools()

    // 写文件审批：beforeToolCall 钩子里等待用户响应（Pi 官方做法）
    // 用户 2 分钟未响应则自动拒绝并继续，避免 Agent 永久挂起、后续对话被阻塞
    const APPROVAL_TIMEOUT_MS = 120_000
    const beforeToolCall = async (context: { toolCall: { name: string; id?: string }; args: unknown }) => {
      // 流已取消：所有工具一律拒绝（不只 writeFile）——旧流不能继续以
      // 新流设置的项目根执行任何工具，也不能再发起审批/写盘
      if (cancelled.current) {
        return { block: true, reason: '此请求已超时取消，请重新发起对话' }
      }
      if (context.toolCall.name !== 'writeFile') return undefined
      const args = (context.args ?? {}) as { path?: string; content?: string }
      const id = context.toolCall.id ?? randomUUID()
      // 预览 2000 字符 + 完整长度：让用户批准前能看到足够内容和规模
      //（400 字符预览时恶意尾部内容可能被跳过，用户批准的实际写盘内容远超所见）
      const full = String(args.content ?? '')
      const preview = full.slice(0, 2000)
      emit({ type: 'approval_request', id, tool: 'writeFile', path: args.path ?? '?', contentPreview: preview, contentLength: full.length })
      const response = await new Promise<AiApprovalResponse>((resolve) => {
        let settled = false
        const finish = (approved: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ id, approved })
        }
        const timer = setTimeout(() => {
          // 超时：通知界面关闭审批弹窗，按“拒绝”继续对话
          if (!webContents.isDestroyed()) webContents.send(channel, { type: 'approval_expired', id })
          finish(false)
        }, APPROVAL_TIMEOUT_MS)
        // 把请求 id 一并交给主进程：界面响应时按 id 匹配，过期响应一律忽略
        approvalResolver(id, (r) => finish(r.approved))
      })
      return response.approved
        ? undefined
        : { block: true, reason: '用户拒绝了此修改，请调整方案或询问用户' }
    }

    // 硬停止：AbortController 联动 cancelled——abort 时中断在途模型请求（停止计费）。
    // streamFn 把 signal 透传给 pi-ai（SimpleStreamOptions.signal）
    const abortController = new AbortController()
    cancelled.abort = () => abortController.abort()

    const agent = new Agent({
      streamFn: (m, ctx, opts) => models.streamSimple(m, ctx, { ...opts, signal: abortController.signal }),
      initialState: {
        systemPrompt: params.systemPrompt,
        model,
        tools: tools as AgentTool[],
        // 预置多轮对话历史（Pi Agent 支持 initialState.messages）：
        // 每轮对话都是新 Agent，不预置历史的话 AI 会“失忆”，不知道之前聊过什么。
        // 最后一条用户消息由 prompt() 追加，避免重复。
        // 注意：pi-ai 估算上下文时会读 assistant.usage.totalTokens，历史消息没有
        // 真实用量，必须补零值占位，否则会抛 undefined 崩溃。
        messages: params.messages.slice(0, -1).map((m) =>
          m.role === 'assistant'
            ? {
                role: 'assistant',
                content: [{ type: 'text', text: m.content }],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
                timestamp: Date.now(),
              }
            : { role: 'user', content: m.content, timestamp: Date.now() },
        ) as never,
      },
      beforeToolCall: beforeToolCall as never,
      // Agent 循环不会把模型请求异常向外抛出，必须显式提供 API Key。
      getApiKey: () => config.apiKey,
    })

    let agentError: string | null = null
    agent.subscribe((event) => {
      if (event.type === 'message_update') {
        const assistantEvent = event.assistantMessageEvent as { type?: string; delta?: string }
        if (assistantEvent.type === 'text_delta') {
          emit({ type: 'delta', text: assistantEvent.delta ?? '' })
        }
        if (assistantEvent.type === 'thinking_delta') {
          emit({ type: 'reasoning', text: assistantEvent.delta ?? '' })
        }
      }
      if (event.type === 'tool_execution_start') {
        emit({ type: 'tool_start', name: (event as { toolName: string }).toolName, args: (event as { args: Record<string, unknown> }).args })
      }
      if (event.type === 'tool_execution_end') {
        const e = event as { toolName: string; result: { content?: Array<{ text?: string }> }; isError: boolean }
        const summary = e.isError ? '执行失败' : (e.result?.content?.[0]?.text ?? '完成').slice(0, 120)
        emit({ type: 'tool_end', name: e.toolName, ok: !e.isError, summary })
      }
      if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
        agentError = event.message.errorMessage ?? 'AI 请求失败'
      }
    })

    emit({ type: 'start' })
    await agent.prompt(params.messages[params.messages.length - 1]?.content ?? '')
    if (agentError) {
      emit({ type: 'error', message: toFriendlyError(agentError) })
    } else {
      emit({ type: 'done', fullText: '' })
    }
  } catch (err) {
    emit({ type: 'error', message: toFriendlyError(err) })
  }
}

/** 社区后端（闭源服务，预留）：未上线时返回"即将上线" */
export function checkCommunity(config: { endpoint: string; token: string }): AiCheckResult {
  if (!config.endpoint || !config.token) {
    return { ok: false, message: '社区 AI 服务即将上线（内部预留）' }
  }
  // TODO(community)：请求 {endpoint}/health，处理 维护中/可用/额度 状态
  return { ok: false, message: '社区 AI 服务即将上线' }
}

export function communityInfo(): { type: AiProviderType; name: string; available: boolean; models: string[] } {
  return { type: 'community', name: '社区后端', available: false, models: [] }
}

/** 把底层错误转成用户看得懂的中文提示（L7：回传前掩码 API Key，防止错误体泄漏密钥） */
function toFriendlyError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err)
  // 掩码 sk- 开头的密钥片段（DeepSeek/OpenAI 风格），避免 provider 错误体回显完整 Key
  message = message.replace(/sk-[A-Za-z0-9_-]{8,}/g, (m) => `sk-***${m.slice(-4)}`)
  if (/401|invalid api key|authentication/i.test(message)) return 'API Key 无效，请在设置中检查'
  if (/402|insufficient|quota|balance/i.test(message)) return '额度不足或余额耗尽，请检查账户'
  if (/timeout|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(message)) return '网络连接失败，请检查网络'
  if (/429|rate limit/i.test(message)) return '请求过于频繁，请稍后再试'
  return message
}
