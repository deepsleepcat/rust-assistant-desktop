import { describe, expect, it } from 'vitest'
import { enToZh, makeDict, zhToEn } from '../src/services/translation'

function dict() {
  return makeDict(
    new Map([
      ['name', '名称'],
      ['price', '价格'],
      ['health', '生命值'],
      ['damage', '伤害'],
      ['range', '射程'],
      ['rifleman', '步枪兵'],
    ]),
    new Map([
      ['名称', 'name'],
      ['价格', 'price'],
      ['生命值', 'health'],
      ['伤害', 'damage'],
      ['射程', 'range'],
      ['步枪兵', 'rifleman'],
    ]),
  )
}

describe('翻译服务', () => {
  it('英文 → 中文', () => {
    expect(enToZh('name = "Rifleman"', dict())).toBe('名称 = "步枪兵"')
    expect(enToZh('price = 300', dict())).toBe('价格 = 300')
  })

  it('保留首字母大写风格，全大写常量不翻译', () => {
    expect(enToZh('Name = "x"', dict())).toBe('名称 = "x"')
    expect(enToZh('PRICE = 1', dict())).toBe('PRICE = 1')
  })

  it('未收录的英文词保持原样', () => {
    expect(enToZh('unknownKey = 1', dict())).toBe('unknownKey = 1')
  })

  it('中文 → 英文（最长匹配优先）', () => {
    expect(zhToEn('名称 = "步枪兵"', dict())).toBe('name = "rifleman"')
    expect(zhToEn('价格 = 300', dict())).toBe('price = 300')
  })

  it('未收录的中文保持原样', () => {
    expect(zhToEn('自定义内容 = 1', dict())).toBe('自定义内容 = 1')
  })

  it('en→zh→en 往返无损（规范小写键名）', () => {
    const d = dict()
    const original = '[core]\nname = "rifleman"\nprice = 300\nhealth = 100'
    const zh = enToZh(original, d)
    expect(zh).toContain('名称')
    expect(zh).toContain('价格')
    const back = zhToEn(zh, d)
    expect(back).toBe('[core]\nname = "rifleman"\nprice = 300\nhealth = 100')
  })

  it('长词优先：名称 不会被 名 先替换', () => {
    const d = makeDict(new Map([['名称', 'name']]), new Map([['名称', 'name']]))
    expect(zhToEn('名称', d)).toBe('name')
  })
})
