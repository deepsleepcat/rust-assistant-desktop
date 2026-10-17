import { describe, expect, it } from 'vitest'
import { chartValues, formatCount, reasoningLabel, normalizeLayout, swapSlots, DEFAULT_LAYOUT } from './dashboardModel'

describe('dashboard real values', () => {
  it('keeps missing counters distinct from true zero and does not invent reasoning', () => {
    expect(formatCount(null)).toBe('未记录')
    expect(formatCount(0)).toBe('0')
    expect(reasoningLabel(null)).toBe('未记录')
    expect(chartValues([{ date: '2026-10-17', inputTokens: null, outputTokens: 0 }])).toEqual([{ date: '2026-10-17', input: null, output: 0 }])
  })
  it('preserves account layout order and falls back on invalid layout', () => {
    const swapped = swapSlots(DEFAULT_LAYOUT.slots)
    expect(normalizeLayout(swapped).slots).toEqual(['tokens', 'balance'])
    expect(normalizeLayout({ version: 1, slots: ['tokens', 'tokens'] })).toEqual(DEFAULT_LAYOUT)
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT)
  })
})
