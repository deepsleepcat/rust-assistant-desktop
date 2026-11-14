/**
 * AI 本地用量统计（对齐桌面端 usageStats）纯函数测试：
 * token 估算、记录上限、今日/近 7 天/累计汇总边界、损坏数据容错。
 */
import { describe, expect, it } from 'vitest'
import { MAX_USAGE_RECORDS, addUsageRecord, estimateTokens, parseStoredUsage, summarizeUsage, type AiUsageRecord } from '../src/features/ai/usageStats'

describe('estimateTokens', () => {
  it('空文本为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })
  it('字符数 / 4 向上取整，最少 1', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(1024))).toBe(256)
  })
})

describe('addUsageRecord', () => {
  const rec = (at: number): AiUsageRecord => ({ at, provider: 'deepseek', model: 'm', inputTokens: 1, outputTokens: 2 })

  it('追加返回新数组（不改动原数组）', () => {
    const prev = [rec(1)]
    const next = addUsageRecord(prev, rec(2))
    expect(next.length).toBe(2)
    expect(prev.length).toBe(1)
  })
  it('超过上限丢最旧', () => {
    const full = Array.from({ length: MAX_USAGE_RECORDS }, (_, i) => rec(i))
    const next = addUsageRecord(full, rec(9999))
    expect(next.length).toBe(MAX_USAGE_RECORDS)
    expect(next[0].at).toBe(1)
    expect(next[next.length - 1].at).toBe(9999)
  })
})

describe('summarizeUsage', () => {
  it('按今日/近 7 天/累计分组汇总', () => {
    // 2026-11-10 12:00 本地时区
    const now = new Date(2026, 10, 10, 12, 0, 0).getTime()
    const today = now - 3600 * 1000
    const threeDaysAgo = now - 3 * 24 * 3600 * 1000
    const tenDaysAgo = now - 10 * 24 * 3600 * 1000
    const records: AiUsageRecord[] = [
      { at: today, provider: 'deepseek', model: 'm', inputTokens: 100, outputTokens: 10 },
      { at: threeDaysAgo, provider: 'deepseek', model: 'm', inputTokens: 200, outputTokens: 20 },
      { at: tenDaysAgo, provider: 'deepseek', model: 'm', inputTokens: 400, outputTokens: 40 },
    ]
    const s = summarizeUsage(records, now)
    expect(s.totalCalls).toBe(3)
    expect(s.totalTokens).toBe(770)
    expect(s.todayCalls).toBe(1)
    expect(s.todayTokens).toBe(110)
    expect(s.weekCalls).toBe(2)
    expect(s.weekTokens).toBe(330)
  })
  it('今日边界 = 本地时区自然日零点', () => {
    const noon = new Date(2026, 10, 10, 12, 0, 0).getTime()
    const justAfterMidnight = new Date(2026, 10, 10, 0, 0, 1).getTime()
    const justBeforeMidnight = new Date(2026, 10, 9, 23, 59, 59).getTime()
    const s = summarizeUsage(
      [
        { at: justAfterMidnight, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 0 },
        { at: justBeforeMidnight, provider: 'p', model: 'm', inputTokens: 1, outputTokens: 0 },
      ],
      noon,
    )
    expect(s.todayCalls).toBe(1)
    expect(s.weekCalls).toBe(2)
  })
})

describe('parseStoredUsage', () => {
  it('非数组 → 空', () => {
    expect(parseStoredUsage(null)).toEqual([])
    expect(parseStoredUsage('x')).toEqual([])
    expect(parseStoredUsage({})).toEqual([])
  })
  it('正常记录保留', () => {
    const raw = [{ at: 1755000000000, provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 512, outputTokens: 128 }]
    expect(parseStoredUsage(raw)).toEqual(raw)
  })
  it('损坏条目逐字段容错（非法时间剔除，字段缺失/非法给默认值）', () => {
    const out = parseStoredUsage([
      null,
      'junk',
      { at: 'not-a-number' },
      { at: 1755000000000 },
      { at: 1755000000000, provider: 42, model: 7, inputTokens: -5, outputTokens: 'x' },
    ])
    expect(out.length).toBe(2)
    expect(out[0]).toEqual({ at: 1755000000000, provider: 'unknown', model: '', inputTokens: 0, outputTokens: 0 })
    expect(out[1]).toEqual({ at: 1755000000000, provider: 'unknown', model: '', inputTokens: 0, outputTokens: 0 })
  })
})
