import { describe, expect, it } from 'vitest'
import { findKeyValueSeparator, normalizeKeyValueSeparators, splitTopLevelConfigValue } from '../src/services/configSyntax'

describe('配置语法标点兼容', () => {
  it('识别 ASCII/中文冒号和等号', () => {
    expect(findKeyValueSeparator('name: tank')).toBe(4)
    expect(findKeyValueSeparator('名称：坦克')).toBe(2)
    expect(findKeyValueSeparator('name = tank')).toBe(5)
    expect(findKeyValueSeparator('[core]')).toBe(-1)
  })

  it('中文逗号与英文逗号都按顶层分段，括号内不拆', () => {
    expect(splitTopLevelConfigValue('a，b,c')).toEqual(['a', 'b', 'c'])
    expect(splitTopLevelConfigValue('fn(a，b),c')).toEqual(['fn(a，b)', 'c'])
  })

  it('只把键值位置的全角冒号写回 ASCII', () => {
    expect(normalizeKeyValueSeparators('名称：坦克，重型\n自由文本：不在值结构外')).toBe('名称:坦克，重型\n自由文本:不在值结构外')
    expect(normalizeKeyValueSeparators('[核心]\n# 注释：保留\n[核心] # 行尾注释：保留')).toBe('[核心]\n# 注释：保留\n[核心] # 行尾注释：保留')
  })

  it('保留 CRLF，并跳过三引号多行值内部的全角冒号', () => {
    const source = 'name：坦克\r\ndescription: """\r\n第一行：保留\r\n"""\r\n'
    expect(normalizeKeyValueSeparators(source)).toBe('name:坦克\r\ndescription: """\r\n第一行：保留\r\n"""\r\n')
  })
})
