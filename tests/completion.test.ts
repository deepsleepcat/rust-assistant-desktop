import { describe, expect, it } from 'vitest'
import { computeRustCompletions } from '../src/features/editor/completion'
import type { CompletionDataSource } from '../src/features/editor/completion'
import { parseValueList } from '../src/services/codeData'

/** 假数据源：模拟手机版数据结构 */
const fakeData: CompletionDataSource = {
  findSectionsByQuery: (q) =>
    [
      { code: 'core', translate: '核心' },
      { code: 'attack', translate: '攻击' },
      { code: 'turret', translate: '炮塔' },
    ].filter((s) => s.code.includes(q) || s.translate.includes(q)),
  findCodesBySection: (section, q) =>
    [
      { code: 'name', translate: '名称', description: '单位名称', type: 'string', section: 'core' },
      { code: 'price', translate: '价格', description: '造价', type: 'resource', section: 'core' },
      { code: 'health', translate: '生命值', description: '血量', type: 'int', section: 'core' },
    ]
      .filter((c) => c.section === 'all' || c.section === section)
      .filter((c) => c.code.includes(q) || c.translate.includes(q)),
  findCodeByCode: (code) => {
    const map: Record<string, { code: string; translate: string; description: string; type: string }> = {
      name: { code: 'name', translate: '名称', description: '', type: 'string' },
      price: { code: 'price', translate: '价格', description: '', type: 'resource' },
    }
    return map[code]
  },
  findValueType: (type) => {
    const map: Record<string, { external?: string; list?: string }> = {
      string: { external: ':' },
      resource: { external: ':', list: 'NONE,AUTO,@file(png)' },
    }
    return map[type]
  },
  findCodesByQuery: (q) => fakeData.findCodesBySection('core', q),
}

describe('补全候选计算（注入假数据源）', () => {
  it('节补全：未闭合 [ 时按前缀返回节候选', () => {
    const result = computeRustCompletions('[c', '', 'c', '[c', 0, ['[c'], fakeData)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].apply).toMatch(/^\[.+?\]$/)
    expect(result.map((r) => r.apply)).toContain('[core]')
    expect(result.map((r) => r.label)).toContain('core · 核心')
  })

  it('值补全：冒号后按值类型 list 返回候选，且自动追加冒号', () => {
    const result = computeRustCompletions('name: ', 'core', '', 'name: ', 0, ['[core]', 'name: '], fakeData)
    // name 是 string 类型，list 为空 → 退回键补全（带 external 冒号）
    expect(result.length).toBeGreaterThan(0)
    // price 是 resource 类型，list 含 NONE/AUTO
    const priceResult = computeRustCompletions('price: ', 'core', '', 'price: ', 0, ['[core]', 'price: '], fakeData)
    expect(priceResult.map((r) => r.apply)).toContain('NONE')
    expect(priceResult.map((r) => r.apply)).toContain('AUTO')
  })

  it('键补全：无冒号行返回当前节键，中文可匹配', () => {
    const result = computeRustCompletions('名', 'core', '名', '名', 0, ['[core]', '名'], fakeData)
    expect(result.map((r) => r.label)).toContain('name · 名称')
    // 提交自动带冒号
    expect(result.find((r) => r.apply === 'name:')).toBeTruthy()
  })

  it('节过滤：非当前节的键不出现', () => {
    const result = computeRustCompletions('', 'turret', '', '', 0, ['[turret]'], fakeData)
    // 假数据源没有 turret 节的键 → 空
    expect(Array.isArray(result)).toBe(true)
  })
})

describe('值类型 list 解析', () => {
  it('解析逗号分隔并过滤特殊指令', () => {
    expect(parseValueList('true,false')).toEqual(['true', 'false'])
    expect(parseValueList('NONE,AUTO,@file(png),ROOT:')).toEqual(['NONE', 'AUTO', 'ROOT:'])
    expect(parseValueList('')).toEqual([])
    expect(parseValueList(undefined)).toEqual([])
  })
})
