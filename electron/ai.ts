/**
 * 主进程 AI 服务：DeepSeek 提供者（基于 Pi 引擎）。
 *
 * - 运行在 Electron 主进程（Node 环境），渲染进程通过 IPC 调用；
 * - DeepSeek 通过 pi-ai 的 OpenAI 兼容 provider 接入；
 * - CommunityProvider 为闭源社区后端预留（协议 OpenAI 兼容，占位实现）；
 * - 流式对话通过 webContents.send 推送事件给界面。
 */
import type { WebContents } from 'electron'
import type { AiCheckResult, AiChatParams, AiProviderType, AiStreamEvent } from '../src/types/ai'

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

/** 注册 DeepSeek provider（pi-ai 自定义 provider，离线注册） */
async function createDeepSeekModel(config: DeepSeekConfig) {
  const { createModels, createProvider, envApiKeyAuth } = await loadPiAi()
  const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
  const models = createModels()
  models.setProvider(createProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    auth: { apiKey: envApiKeyAuth('DeepSeek API key', ['DEEPSEEK_API_KEY']) },
    api: openAICompletionsApi(),
    models: [{
      id: config.model || 'deepseek-chat',
      name: 'DeepSeek Chat',
      api: 'openai-completions' as const,
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      reasoning: false,
      input: ['text'] as const,
      cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
      contextWindow: 128000,
      maxTokens: 8192,
    }],
  }))
  return { models, model: models.getModel('deepseek', config.model || 'deepseek-chat') }
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

/** 流式对话：把事件推送给渲染进程 */
export async function streamDeepSeek(
  webContents: WebContents,
  channel: string,
  params: AiChatParams,
  config: DeepSeekConfig,
): Promise<void> {
  const emit = (event: AiStreamEvent) => {
    if (!webContents.isDestroyed()) webContents.send(channel, event)
  }
  try {
    const { models, model } = await createDeepSeekModel(config)
    if (!model) throw new Error('模型注册失败')
    emit({ type: 'start' })
    let fullText = ''
    // pi-ai 的 Message 类型非常严格；主进程内部用宽松结构转换（运行时行为一致）
    const messages = params.messages.map((m) => {
      if (m.role === 'assistant') {
        return { role: 'assistant', content: [{ type: 'text', text: m.content }], timestamp: Date.now() }
      }
      return { role: 'user', content: m.content, timestamp: Date.now() }
    }) as never
    const stream = await models.streamSimple(model, {
      systemPrompt: params.systemPrompt,
      messages,
    }, { apiKey: config.apiKey })
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        const delta = (event as { delta?: string }).delta ?? ''
        fullText += delta
        emit({ type: 'delta', text: delta })
      }
    }
    emit({ type: 'done', fullText })
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

/** 把底层错误转成用户看得懂的中文提示 */
function toFriendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/401|invalid api key|authentication/i.test(message)) return 'API Key 无效，请在设置中检查'
  if (/402|insufficient|quota|balance/i.test(message)) return '额度不足或余额耗尽，请检查账户'
  if (/timeout|ETIMEDOUT|ECONNREFUSED|fetch failed/i.test(message)) return '网络连接失败，请检查网络'
  if (/429|rate limit/i.test(message)) return '请求过于频繁，请稍后再试'
  return message
}
