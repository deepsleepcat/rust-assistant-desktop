/**
 * AI 提供者层（AiProvider）——M4 的地基，也是社区后端预留的"插座"。
 *
 * 设计原则（用户已确认）：
 * - 只提供两种 AI 来源：DeepSeek（用户自己的 API Key）或 社区后端（我们提供的闭源服务）；
 * - 界面层只认识 AiProviderType / AiSettings / 事件流，永远不关心具体实现；
 * - 将来社区后端上线 = 新增 community 实现 + 设置里切换，界面与业务零改动；
 * - 社区协议采用 OpenAI 兼容接口，服务器实现成本最低。
 */

/** 提供者类型：现在只有 DeepSeek；community 为将来社区后端预留 */
export type AiProviderType = 'deepseek' | 'community'

/** 用户可感知的提供者信息（设置面板展示用） */
export interface AiProviderInfo {
  type: AiProviderType
  name: string
  description: string
  /** 是否已配置（如 API Key 是否填写） */
  configured: boolean
  /** 是否可用（预留：社区后端上线后由服务器决定） */
  available: boolean
  /** 可用模型列表 */
  models: string[]
}

/** AI 设置（本地持久化，API Key 不入 git） */
export interface AiSettings {
  /** 当前使用的提供者 */
  provider: AiProviderType
  /** DeepSeek API Key */
  deepseekApiKey: string
  /** DeepSeek 模型 */
  deepseekModel: string
  /** 社区后端地址（预留） */
  communityEndpoint: string
  /** 社区后端令牌（预留） */
  communityToken: string
  /** 社区后端模型（预留） */
  communityModel: string
}

/** 对话消息（发给提供者的统一格式） */
export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 流式对话参数 */
export interface AiChatParams {
  provider: AiProviderType
  model: string
  systemPrompt: string
  messages: AiChatMessage[]
}

/** 流式对话事件（从主进程推送到界面） */
export type AiStreamEvent =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'done'; fullText: string }
  | { type: 'error'; message: string }

/** 健康检查结果 */
export interface AiCheckResult {
  ok: boolean
  message: string
}

/** 社区后端协议草案：将来服务器实现 OpenAI 兼容 /v1/chat/completions 即可接入 */
export const COMMUNITY_PROTOCOL_DRAFT = {
  /**
   * 社区后端推荐协议：OpenAI 兼容流式接口。
   * 服务器只需实现 POST {endpoint}/v1/chat/completions（stream: true），
   * 即可复用与 DeepSeek 相同的适配层，前端与 Pi 引擎零改动。
   */
  transport: 'https + sse',
  path: '/v1/chat/completions',
  auth: 'Authorization: Bearer <token>',
  streaming: true,
} as const
