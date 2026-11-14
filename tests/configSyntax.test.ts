import { describe, expect, it } from 'vitest'
import { findConfigCommentStart, findKeyValueSeparator, normalizeKeyValueSeparators, splitTopLevelConfigValue } from '../src/services/configSyntax'

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

describe('游戏配置注释边界', () => {
  it.each(['# 注释', '  # 注释', '\t# 注释', '\ufeff# 注释'])(
    '只识别整行注释并返回原始索引：%s', (line) => {
      expect(findConfigCommentStart(line)).toBe(line.indexOf('#'))
    },
  )

  it.each([
    '',
    'name: # 文本',
    'name:#文本',
    'color:#8E8E8E',
    'color: #8E8E8E',
    'color = #FF8E8E8E',
    'color:#8E8E8E #尾文本',
    'color: #abcd',
    'image: path.png#fragment',
    'name: "has # inside"',
    "name: 'has # inside'",
    'autoTrigger: true #尾文本',
  ])('值内井号不属于注释：%s', (line) => {
    expect(findConfigCommentStart(line)).toBe(-1)
  })
})
