import type {
  DashboardBalance,
  DashboardCounts,
  DashboardCoverage,
  DashboardLayout,
  DashboardSlot,
  DashboardSummary,
} from '../../services/dashboardApi'

/**
 * 仪表盘的纯展示逻辑（无副作用，便于定向回归）。
 * 硬性口径：null=未记录/来源不可靠；真实记录的 0 显示 0；
 * 不出现“剩余 Token”字段，也不把计费额度换算成 Token。
 */

export const DEFAULT_LAYOUT: DashboardLayout = { version: 1, slots: ['balance', 'tokens'] }

export const RANGE_OPTIONS: Array<{ value: '7d' | '30d' | '90d'; label: string }> = [
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
]

export type ChartMode = 'line' | 'bar' | 'pie'

export const CHART_OPTIONS: Array<{ value: ChartMode; label: string }> = [
  { value: 'line', label: '折线' },
  { value: 'bar', label: '柱状' },
  { value: 'pie', label: '占比' },
]

export const COUNT_LABELS: Array<{ key: keyof DashboardCounts; label: string }> = [
  { key: 'inputTokens', label: '输入 Token' },
  { key: 'outputTokens', label: '输出 Token' },
  { key: 'cacheReadTokens', label: '缓存读' },
  { key: 'cacheWriteTokens', label: '缓存写' },
]

const UNRECORDED = '未记录'

/** 只有准确的非负整数才格式化；null 一律“未记录”，0 正常显示 0。 */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNRECORDED
  if (!Number.isSafeInteger(value) || value < 0) return UNRECORDED
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function coverageLabel(coverage: DashboardCoverage, reason?: string | null): string {
  switch (coverage) {
    case 'complete':
      return '覆盖完整'
    case 'partial':
      return reason ? `部分覆盖：${reason}` : '部分覆盖'
    default:
      return reason ? `数据不可用：${reason}` : '数据不可用'
  }
}

export function fieldCoverageLabel(coverage: DashboardCoverage): string {
  switch (coverage) {
    case 'complete': return '完整'
    case 'partial': return '部分'
    default: return '无准确样本'
  }
}

export function reasoningLabel(effort: string | null | undefined): string {
  if (typeof effort === 'string' && effort.trim()) return effort
  return UNRECORDED
}

export function usageSourceLabel(source: string): string {
  if (source === 'upstream') return '上游准确值'
  if (source === 'gateway_estimate') return '网关估算'
  return '未记录'
}

export interface CachePieSegment {
  key: 'uncachedInput' | 'cacheRead' | 'cacheWrite'
  label: string
  value: number
}

/**
 * 缓存饼图门控：只有当输入/缓存读/缓存写三个互斥部分都来自
 * “同一批全部调用的准确样本”时才可绘制，否则返回 null 并由调用方显示覆盖说明。
 * 输入总量包含缓存，因此非缓存输入 = 输入 - 缓存读 - 缓存写。
 */
export function cachePieSegments(summary: DashboardSummary | null | undefined): CachePieSegment[] | null {
  if (!summary) return null
  const { inputTokens, cacheReadTokens, cacheWriteTokens } = summary
  if (inputTokens === null || cacheReadTokens === null || cacheWriteTokens === null) return null
  const total = summary.requestCount
  if (total <= 0) return null
  const fields = summary.fieldCoverage
  if (!fields) return null
  const counts = [fields.inputTokens?.exactRequestCount, fields.cacheReadTokens?.exactRequestCount, fields.cacheWriteTokens?.exactRequestCount]
  // 同一准确样本集合的可验证充分条件：三个字段的准确样本数相等且覆盖全部调用。
  if (counts.some((count) => typeof count !== 'number' || count !== total)) return null
  if (cacheReadTokens + cacheWriteTokens > inputTokens) return null
  const uncached = inputTokens - cacheReadTokens - cacheWriteTokens
  if (uncached < 0) return null
  if (uncached + cacheReadTokens + cacheWriteTokens === 0) return null
  return [
    { key: 'uncachedInput', label: '非缓存输入', value: uncached },
    { key: 'cacheRead', label: '缓存读', value: cacheReadTokens },
    { key: 'cacheWrite', label: '缓存写', value: cacheWriteTokens },
  ]
}

export function balanceText(balance: DashboardBalance | null | undefined): { value: string; note: string | null } {
  if (!balance) return { value: UNRECORDED, note: null }
  if (typeof balance.amount === 'number' && Number.isSafeInteger(balance.amount)) {
    return { value: new Intl.NumberFormat('zh-CN').format(balance.amount), note: balance.unit }
  }
  return { value: UNRECORDED, note: balance.reason ?? '余额来源不可用' }
}

/** 交换两个小部件位置（数组顺序有语义）。 */
export function swapSlots(slots: [DashboardSlot, DashboardSlot]): DashboardLayout {
  return { version: 1, slots: [slots[1], slots[0]] }
}

export function normalizeLayout(value: Partial<DashboardLayout> | null | undefined): DashboardLayout {
  if (!value || value.version !== 1 || !Array.isArray(value.slots) || value.slots.length !== 2) return DEFAULT_LAYOUT
  const [first, second] = value.slots
  const valid: DashboardSlot[] = ['balance', 'tokens']
  if (!valid.includes(first) || !valid.includes(second) || first === second) return DEFAULT_LAYOUT
  return { version: 1, slots: [first, second] }
}

/** 折线/柱状图取值：null 不画点，也不当作 0。 */
export function chartValues(
  series: Array<{ date: string } & Pick<DashboardSummary, 'inputTokens' | 'outputTokens'>>,
): Array<{ date: string; input: number | null; output: number | null }> {
  return series.map((day) => ({ date: day.date, input: day.inputTokens ?? null, output: day.outputTokens ?? null }))
}
