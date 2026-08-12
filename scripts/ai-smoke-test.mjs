/**
 * M4.1 最小对话验证：DeepSeek 跑通一次真实对话。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/ai-smoke-test.mjs "你好"
 * 或在项目根目录 .env.local 中配置 DEEPSEEK_API_KEY。
 */
import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// 支持从 .env.local 读取（简单解析，不引依赖）
if (existsSync(resolve('.env.local'))) {
  for (const line of readFileSync(resolve('.env.local'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error('缺少 DEEPSEEK_API_KEY：请设置环境变量，或在 .env.local 写入 DEEPSEEK_API_KEY=sk-xxx')
  process.exit(1)
}

const models = createModels()
models.setProvider(createProvider({
  id: 'deepseek', name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  auth: { apiKey: envApiKeyAuth('DeepSeek API key', ['DEEPSEEK_API_KEY']) },
  api: openAICompletionsApi(),
  models: [{
    id: 'deepseek-chat', name: 'DeepSeek Chat',
    api: 'openai-completions', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    reasoning: false, input: ['text'],
    cost: { input: 0.27, output: 1.1 },
    contextWindow: 128000, maxTokens: 8192,
  }],
}))

const model = models.getModel('deepseek', 'deepseek-chat')
if (!model) throw new Error('模型注册失败')

const prompt = process.argv[2] ?? '你好，请用一句话自我介绍'
console.log(`[用户] ${prompt}`)

const reply = await models.completeSimple(model, {
  systemPrompt: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
}, { apiKey })

console.log(`[AI] ${reply.content}`)
console.log('\n✅ M4.1 最小对话验证通过')
