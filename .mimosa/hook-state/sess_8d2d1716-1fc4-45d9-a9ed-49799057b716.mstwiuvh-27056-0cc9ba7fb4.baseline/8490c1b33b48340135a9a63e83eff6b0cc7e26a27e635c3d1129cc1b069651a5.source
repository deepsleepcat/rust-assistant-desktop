/**
 * 本地 AI 用量统计（M23，P3 任务 2）：
 * 记录每次 AI 调用（时间/提供者/模型/估算 token），供本地查看与未来服务器
 * 阶段对接成本核算。纯本地存储（store 键 aiUsage），不上传。
 *
 * 数据格式（文档化，供未来服务器阶段对接）：
 * {
 *   "aiUsage": [
 *     { "at": 1755000000000, "provider": "deepseek", "model": "deepseek-v4-flash",
 *       "inputTokens": 512, "outputTokens": 128 }
 *   ]
 * }
 * token 为估算值（字符数/4，中英文通用近似）；未来接入真实 usage 时替换 estimateTokens。
 */
export interface AiUsageRecord {
  at: number
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}

export interface AiUsageSummary {
  totalCalls: number
  totalTokens: number
  todayCalls: number
  todayTokens: number
  weekCalls: number
  weekTokens: number
}

/** 记录上限：超出丢弃最旧（防长期使用无限膨胀） */
export const MAX_USAGE_RECORDS = 2000

/** token 估算：字符数 / 4 向上取整（中英文通用近似，与常见计费口径一致） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

/** 追加一条用量记录（返回新数组；超上限丢最旧） */
export function addUsageRecord(records: AiUsageRecord[], record: AiUsageRecord): AiUsageRecord[] {
  const next = [...records, record]
  return next.length > MAX_USAGE_RECORDS ? next.slice(next.length - MAX_USAGE_RECORDS) : next
}

/** 汇总（今日 = 本地时区自然日；近 7 天 = 今天往前 7×24h） */
export function summarizeUsage(records: AiUsageRecord[], now = Date.now()): AiUsageSummary {
  const dayStart = new Date(now)
  dayStart.setHours(0, 0, 0, 0)
  const dayStartMs = dayStart.getTime()
  const weekStartMs = now - 7 * 24 * 3600 * 1000
  let totalCalls = 0
  let totalTokens = 0
  let todayCalls = 0
  let todayTokens = 0
  let weekCalls = 0
  let weekTokens = 0
  for (const r of records) {
    totalCalls++
    totalTokens += r.inputTokens + r.outputTokens
    if (r.at >= dayStartMs) {
      todayCalls++
      todayTokens += r.inputTokens + r.outputTokens
    }
    if (r.at >= weekStartMs) {
      weekCalls++
      weekTokens += r.inputTokens + r.outputTokens
    }
  }
  return { totalCalls, totalTokens, todayCalls, todayTokens, weekCalls, weekTokens }
}

/** 读取存储里的记录（非数组/损坏 → 空） */
export function parseStoredUsage(raw: unknown): AiUsageRecord[] {
  if (!Array.isArray(raw)) return []
  const out: AiUsageRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Partial<AiUsageRecord>
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue
    out.push({
      at: r.at,
      provider: typeof r.provider === 'string' ? r.provider : 'unknown',
      model: typeof r.model === 'string' ? r.model : '',
      inputTokens: typeof r.inputTokens === 'number' && r.inputTokens >= 0 ? r.inputTokens : 0,
      outputTokens: typeof r.outputTokens === 'number' && r.outputTokens >= 0 ? r.outputTokens : 0,
    })
  }
  return out
}
