import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, clamp, sanitizeSettings } from '../src/utils/settings'
import type { AppSettings } from '../src/types/domain'

describe('设置清洗', () => {
  it('空输入返回默认设置', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('数字被限制在合法范围', () => {
    const s = sanitizeSettings({ leftWidth: 5, rightWidth: 9999, fontSize: 99, background: { opacity: 150, blur: -5 } })
    expect(s.leftWidth).toBe(220)
    expect(s.rightWidth).toBe(640)
    expect(s.fontSize).toBe(20)
    expect(s.background.opacity).toBe(100)
    expect(s.background.blur).toBe(0)
  })

  it('非法主题和背景类型回退默认值', () => {
    const s = sanitizeSettings({ theme: 'neon', background: { kind: 'weird' } })
    expect(s.theme).toBe('light')
    expect(s.background.kind).toBe('none')
  })

  it('非法颜色回退默认值', () => {
    const s = sanitizeSettings({ background: { color: 'red; x' } })
    expect(s.background.color).toBe(DEFAULT_SETTINGS.background.color)
  })

  it('合法值被保留', () => {
    const input: Partial<AppSettings> = { theme: 'dark', rainbow: false, fontSize: 16, leftWidth: 300, rightWidth: 400 }
    const s = sanitizeSettings(input)
    expect(s.theme).toBe('light')
    expect(s.rainbow).toBe(false)
    expect(s.fontSize).toBe(16)
    expect(s.leftWidth).toBe(300)
    expect(s.rightWidth).toBe(400)
  })

  it('clamp 正确处理 NaN 与边界', () => {
    expect(clamp(Number.NaN, 1, 10)).toBe(1)
    expect(clamp(0, 1, 10)).toBe(1)
    expect(clamp(42, 1, 10)).toBe(10)
    expect(clamp(7, 1, 10)).toBe(7)
  })
})
