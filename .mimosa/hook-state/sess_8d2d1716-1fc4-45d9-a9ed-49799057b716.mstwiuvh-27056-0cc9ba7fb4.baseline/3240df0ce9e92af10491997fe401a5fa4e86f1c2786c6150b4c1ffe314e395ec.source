import { describe, expect, it } from 'vitest'
import { colorToRgba, findColors, parseColor } from '../src/features/editor/colorDecorations'
import { scanSections, sectionFoldRanges } from '../src/features/editor/outline'
import { isPreviewableImage } from '../src/utils/paths'

describe('颜色解析', () => {
  it('解析 6 位颜色', () => {
    const c = parseColor('#1a73e8')!
    expect(c.r).toBe(26)
    expect(c.g).toBe(115)
    expect(c.b).toBe(232)
    expect(c.a).toBe(1)
    expect(colorToRgba(c)).toBe('rgba(26, 115, 232, 1)')
  })
  it('解析 3 位和 8 位颜色', () => {
    expect(parseColor('#abc')?.hex).toBe('#AABBCC')
    expect(parseColor('#80112233')?.a).toBeCloseTo(128 / 255)
    expect(parseColor('red')).toBeNull()
  })
  it('扫描一行中的颜色 token', () => {
    const colors = findColors('color: #fff; shadow: #80112233')
    expect(colors).toHaveLength(2)
    expect(colors[0].from).toBe(7)
  })
})

describe('Section 大纲与折叠', () => {
  const text = '[core]\nname: x\nprice: 1\n\n[attack]\nrange: 100\n'
  it('扫描节标题和行号', () => {
    expect(scanSections(text)).toEqual([
      { name: 'core', line: 1, from: 0 },
      { name: 'attack', line: 5, from: 25 },
    ])
  })
  it('每个节生成折叠范围', () => {
    const ranges = sectionFoldRanges(text)
    expect(ranges).toHaveLength(2)
    expect(ranges[0].from).toBeGreaterThan(0)
    expect(ranges[0].to).toBeLessThan(ranges[1].from)
  })
})

describe('图片扩展名', () => {
  it('识别支持的图片格式', () => {
    expect(isPreviewableImage('a.png')).toBe(true)
    expect(isPreviewableImage('人物.JPEG')).toBe(true)
    expect(isPreviewableImage('mod.txt')).toBe(false)
    expect(isPreviewableImage('image.svg')).toBe(false)
  })
})
