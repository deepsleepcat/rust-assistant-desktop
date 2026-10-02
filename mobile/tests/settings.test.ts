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
    expect(s.leftWidth).toBe(180)
    expect(s.rightWidth).toBe(760)
    expect(s.fontSize).toBe(20)
    expect(s.background.opacity).toBe(100)
    expect(s.background.blur).toBe(0)
  })

  it('非法主题和背景类型回退默认值', () => {
    const s = sanitizeSettings({ theme: 'neon', background: { kind: 'weird' } })
    expect(s.theme).toBe('light')
    expect(s.background.kind).toBe('none')
  })

  it('合法主题值被保留（light/dark/system）', () => {
    expect(sanitizeSettings({ theme: 'dark' }).theme).toBe('dark')
    expect(sanitizeSettings({ theme: 'system' }).theme).toBe('system')
    expect(sanitizeSettings({ theme: 'light' }).theme).toBe('light')
  })

  it('非法颜色回退默认值', () => {
    const s = sanitizeSettings({ background: { color: 'red; x' } })
    expect(s.background.color).toBe(DEFAULT_SETTINGS.background.color)
  })

  it('合法值被保留', () => {
    const input: Partial<AppSettings> = { theme: 'dark', fontSize: 16, leftWidth: 300, rightWidth: 400 }
    const s = sanitizeSettings(input)
    expect(s.theme).toBe('dark')
    expect(s.fontSize).toBe(16)
    expect(s.leftWidth).toBe(300)
    expect(s.rightWidth).toBe(400)
  })

  it('M6 鼠标特效字段：默认关闭、强度限制在 1-3、颜色默认黑', () => {
    expect(DEFAULT_SETTINGS.cursorEffect).toBe(false)
    expect(DEFAULT_SETTINGS.cursorEffectIntensity).toBe(1)
    expect(DEFAULT_SETTINGS.cursorEffectColor).toBe('#000000')
    const s = sanitizeSettings({ cursorEffect: true, cursorEffectIntensity: 9, cursorEffectColor: '#FFB7C5' })
    expect(s.cursorEffect).toBe(true)
    expect(s.cursorEffectIntensity).toBe(3)
    expect(s.cursorEffectColor).toBe('#FFB7C5')
    const off = sanitizeSettings({ cursorEffect: 'yes' as never, cursorEffectIntensity: 0, cursorEffectColor: 'red; x' })
    expect(off.cursorEffect).toBe(false)
    expect(off.cursorEffectIntensity).toBe(1)
    expect(off.cursorEffectColor).toBe('#000000')
  })

  it('clamp 正确处理 NaN 与边界', () => {
    expect(clamp(Number.NaN, 1, 10)).toBe(1)
    expect(clamp(0, 1, 10)).toBe(1)
    expect(clamp(42, 1, 10)).toBe(10)
    expect(clamp(7, 1, 10)).toBe(7)
  })

  it('M29 布局字段：比例夹紧、布尔校验、损坏数据回退', () => {
    expect(DEFAULT_SETTINGS.layout).toEqual({
      leftARatio: 0.3,
      leftACollapsed: false,
      rightARatio: 0.38,
      rightACollapsed: false,
      leftCollapsed: false,
      rightCollapsed: false,
      outlineHeight: 180,
      outlineCollapsed: true,
    })
    const s = sanitizeSettings({
      layout: {
        leftARatio: 9,
        leftACollapsed: 'yes',
        rightARatio: 0,
        rightACollapsed: true,
        leftCollapsed: true,
        rightCollapsed: false,
        outlineHeight: 5,
        outlineCollapsed: 1,
      },
    })
    expect(s.layout.leftARatio).toBe(0.8)
    expect(s.layout.leftACollapsed).toBe(false)
    expect(s.layout.rightARatio).toBe(0.15)
    expect(s.layout.rightACollapsed).toBe(true)
    expect(s.layout.leftCollapsed).toBe(true)
    expect(s.layout.rightCollapsed).toBe(false)
    expect(s.layout.outlineHeight).toBe(80)
    expect(s.layout.outlineCollapsed).toBe(true)
  })

  it('M29 布局字段：合法值被保留', () => {
    const s = sanitizeSettings({
      layout: { leftARatio: 0.4, rightARatio: 0.5, outlineHeight: 240, outlineCollapsed: true },
    })
    expect(s.layout.leftARatio).toBe(0.4)
    expect(s.layout.rightARatio).toBe(0.5)
    expect(s.layout.outlineHeight).toBe(240)
    expect(s.layout.outlineCollapsed).toBe(true)
  })

  it('M29 布局字段：layout 为非对象（字符串/数组）时回退默认', () => {
    expect(sanitizeSettings({ layout: 'oops' }).layout).toEqual(DEFAULT_SETTINGS.layout)
    expect(sanitizeSettings({ layout: [1, 2] }).layout).toEqual(DEFAULT_SETTINGS.layout)
    expect(sanitizeSettings({ layout: 42 }).layout).toEqual(DEFAULT_SETTINGS.layout)
  })
})
