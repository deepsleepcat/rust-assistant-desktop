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

describe('翻译追踪表（M8：防保存改写数据）', () => {
  function dict() {
    return makeDict(
      new Map([
        ['name', '名称'],
        ['tank', '坦克'],
        ['image', '图像'],
        ['Image', '图像'],
      ]),
      new Map([
        ['名称', 'name'],
        ['坦克', 'c_tank'],
        ['图像', 'image'],
      ]),
    )
  }

  it('tracker 模式：翻译产生的中文精确还原原文（含大小写）', () => {
    const d = dict()
    const tracker = new Map<string, string>()
    const zh = enToZh('name: Image\nimage: tank.png', d, tracker)
    // 大小写变体（Image/image 同译「图像」）：首见翻译，后见保持英文显示（M1，避免保存归一化）
    expect(zh).toBe('名称: 图像\nimage: 坦克.png')
    expect(zhToEn(zh, d, tracker)).toBe('name: Image\nimage: tank.png')
  })

  it('tracker 模式：文件里原有的中文数据（用户手写）保留，不被词典回译改写', () => {
    const d = dict()
    const tracker = new Map<string, string>()
    // 打开一个本身就含中文数据的文件：enToZh 不翻译中文（不进入 tracker）
    const zh = enToZh('name: 坦克\nimage: x.png', d, tracker)
    expect(zh).toBe('名称: 坦克\n图像: x.png')
    // 保存时：翻译产生的「名称/图像」还原成 name/image；原文中文「坦克」保留（词典里即使有 c_tank 也不动它）
    const back = zhToEn(zh, d, tracker)
    expect(back).toBe('name: 坦克\nimage: x.png')
  })

  it('无 tracker 时保持旧行为（词典回译）', () => {
    const d = dict()
    expect(zhToEn('名称', d)).toBe('name')
    expect(zhToEn('坦克', d)).toBe('c_tank')
  })
})

describe('M9 第四轮修复回归：编号/宏字段键往返', () => {
  function dict() {
    return makeDict(
      new Map([
        ['projectile', '抛射体'],
        ['builtfrom', '建造自'],
        ['name', '名称'],
        ['canbuild', '可建造'],
        ['tooltip', '提示'],
        ['flag', '标志'],
      ]),
      new Map([
        ['抛射体', 'projectile'],
        ['建造自', 'builtfrom'],
        ['名称', 'name'],
        ['可建造', 'canbuild'],
        ['提示', 'tooltip'],
      ]),
    )
  }

  it('[projectile_1] 与 builtFrom_1_name 键保存往返无损（不会把中文键写盘）', () => {
    const d = dict()
    const tracker = new Map<string, string>()
    const original = '[projectile_1]\nbuiltFrom_1_name: tank\ncanBuild_2_tooltip: 描述'
    const zh = enToZh(original, d, tracker)
    expect(zh).toContain('[抛射体_1]')
    expect(zh).toContain('建造自_1_名称')
    const back = zhToEn(zh, d, tracker)
    expect(back).toBe(original)
  })

  it('大小写变体（true/True）不互相归一化：后见变体保持英文显示', () => {
    const d = makeDict(new Map([['true', '是']]), new Map([['是', 'true']]))
    const tracker = new Map<string, string>()
    const zh = enToZh('flag: true\nother: True', d, tracker)
    // 首见 true → 是；变体 True → 保持英文显示（避免保存时被归一化）
    expect(zh).toBe('flag: 是\nother: True')
    const back = zhToEn(zh, d, tracker)
    expect(back).toBe('flag: true\nother: True')
  })

  it('混合中文数据（我的坦克2）整体保留，不被词典改写', () => {
    const d = makeDict(new Map([['tank', '坦克'], ['name', '名称']]), new Map([['坦克', 'c_tank'], ['名称', 'name']]))
    const tracker = new Map<string, string>()
    const zh = enToZh('name: 我的坦克2', d, tracker)
    expect(zh).toBe('名称: 我的坦克2')
    const back = zhToEn(zh, d, tracker)
    expect(back).toBe('name: 我的坦克2')
  })
})
