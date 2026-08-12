import { describe, expect, it } from 'vitest'
import { classifyLine, findSectionOfLine, isUnclosedSection, keyOfLine } from '../src/features/editor/rustLanguage'

describe('Rust 配置行分类（高亮规则）', () => {
  it('注释行', () => {
    expect(classifyLine('# 这是一条注释')).toEqual({ kind: 'comment' })
    expect(classifyLine('  # 带缩进注释')).toEqual({ kind: 'comment' })
  })

  it('节名行', () => {
    expect(classifyLine('[core]')).toEqual({ kind: 'section' })
    expect(classifyLine('[attack]')).toEqual({ kind: 'section' })
  })

  it('键值行', () => {
    const r = classifyLine('name: 步枪兵')
    expect(r.kind).toBe('keyvalue')
    if (r.kind === 'keyvalue') {
      expect(r.key).toBe('name')
      expect(r.value).toBe('步枪兵')
    }
  })

  it('普通行', () => {
    expect(classifyLine('some free text')).toEqual({ kind: 'plain' })
    expect(classifyLine('')).toEqual({ kind: 'plain' })
  })

  it('未闭合节判断', () => {
    expect(isUnclosedSection('[core')).toBe(true)
    expect(isUnclosedSection('[core]')).toBe(false)
    expect(isUnclosedSection('name: x')).toBe(false)
  })

  it('行内 key 提取', () => {
    expect(keyOfLine('name: 值')).toBe('name')
    expect(keyOfLine('damage : 12')).toBe('damage')
    expect(keyOfLine('没有冒号')).toBeNull()
  })

  it('向上扫描最近的节', () => {
    const lines = ['[core]', 'name: x', '[attack]', 'range: 100']
    expect(findSectionOfLine(lines, 0)).toBe('core')
    expect(findSectionOfLine(lines, 1)).toBe('core')
    expect(findSectionOfLine(lines, 2)).toBe('attack')
    expect(findSectionOfLine(lines, 3)).toBe('attack')
    expect(findSectionOfLine(['无节'], 0)).toBe('')
  })
})
