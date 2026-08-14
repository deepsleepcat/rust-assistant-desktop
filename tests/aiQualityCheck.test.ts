/**
 * AI 写后质检（任务 3）纯函数测试：行起始表、偏移量→行号、诊断→可操作清单、
 * 建议映射、条目上限折叠。
 */
import { describe, expect, it } from 'vitest'
import { joinProjectPath, lineNumberAt, lineStarts, suggestionFor, toLintItems } from '../src/features/ai/aiQualityCheck'

describe('joinProjectPath', () => {
  it('把 AI 相对路径拼成项目内绝对路径（统一正斜杠，兼容多种写法）', () => {
    expect(joinProjectPath('W:\\proj', 'units/rifle.ini')).toBe('W:\\proj/units/rifle.ini')
    expect(joinProjectPath('W:\\proj\\', '/units/rifle.ini')).toBe('W:\\proj/units/rifle.ini')
    expect(joinProjectPath('W:/proj', './units\\rifle.ini')).toBe('W:/proj/units/rifle.ini')
  })

  it('拒绝盘符写法（防未来被复用于写通道）', () => {
    expect(() => joinProjectPath('W:\\proj', 'C:/evil.txt')).toThrow()
    expect(() => joinProjectPath('W:\\proj', 'D:\\evil.txt')).toThrow()
  })
})

describe('lineStarts / lineNumberAt', () => {
  it('构建每行起始偏移表，行号从 1 起', () => {
    const content = 'a\nb\nc'
    const starts = lineStarts(content)
    expect(starts).toEqual([0, 2, 4])
    expect(lineNumberAt(starts, 0)).toBe(1)
    expect(lineNumberAt(starts, 2)).toBe(2)
    expect(lineNumberAt(starts, 4)).toBe(3)
  })

  it('超过内容的偏移量不越界', () => {
    expect(lineNumberAt(lineStarts('ab'), 999)).toBe(1)
  })

  it('兼容 \\r\\n（\\r 不计行）', () => {
    const starts = lineStarts('a\r\nb')
    expect(starts).toEqual([0, 3])
    expect(lineNumberAt(starts, 3)).toBe(2)
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

  it('超过 200 条时折叠为汇总条目（line=0，无建议）', () => {
    const diagnostics = Array.from({ length: 205 }, (_, i) => ({
      from: 0,
      to: 1,
      message: `问题 ${i}`,
      severity: 'warning' as const,
    }))
    const items = toLintItems('a', diagnostics)
    expect(items.length).toBe(201)
    expect(items[200].line).toBe(0)
    expect(items[200].message).toContain('其余 5 条问题未列出')
    expect(items[200].suggestion).toBe('')
  })
})
