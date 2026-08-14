/**
 * AI 写后质检（任务 3）纯函数测试：偏移量→行号、诊断→可操作清单、建议映射。
 */
import { describe, expect, it } from 'vitest'
import { lineNumberAt, suggestionFor, toLintItems } from '../src/features/ai/aiQualityCheck'

describe('lineNumberAt', () => {
  it('偏移量 → 行号（从 1 起）', () => {
    const content = 'a\nb\nc'
    expect(lineNumberAt(content, 0)).toBe(1)
    expect(lineNumberAt(content, 2)).toBe(2)
    expect(lineNumberAt(content, 4)).toBe(3)
  })

  it('超过内容的偏移量不越界', () => {
    expect(lineNumberAt('ab', 999)).toBe(1)
  })

  it('兼容 \\r\\n（\\r 不计行）', () => {
    const content = 'a\r\nb'
    expect(lineNumberAt(content, 3)).toBe(2)
  })
})

describe('suggestionFor', () => {
  it('值类型错误给出对照代码表的建议', () => {
    expect(suggestionFor('「name」的值「x」不符合类型 int')).toContain('代码表')
  })
  it('节外代码给出移入节内的建议', () => {
    expect(suggestionFor('此键值行不在任何 [节] 内，游戏会忽略它')).toContain('[节]')
  })
  it('其他问题给出通用建议', () => {
    expect(suggestionFor('未知问题')).toContain('格式')
  })
})

describe('toLintItems', () => {
  it('诊断 → 文件行号 + 原因 + 修复建议', () => {
    const content = '[core]\nname: x\nhp: -1\n'
    const items = toLintItems(content, [
      { from: 7, to: 14, message: '「name」的值「x」不符合类型 int（期望：整数）', severity: 'error' },
      { from: 15, to: 21, message: '「hp」的值「-1」不符合类型 int', severity: 'error' },
    ])
    expect(items).toEqual([
      { line: 2, message: '「name」的值「x」不符合类型 int（期望：整数）', severity: 'error', suggestion: expect.stringContaining('代码表') },
      { line: 3, message: '「hp」的值「-1」不符合类型 int', severity: 'error', suggestion: expect.stringContaining('代码表') },
    ])
  })

  it('空诊断 → 空清单', () => {
    expect(toLintItems('a\nb', [])).toEqual([])
  })
})
