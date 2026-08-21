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

  it('损坏中文命名节无 tracker 时也能恢复官方前缀', () => {
    const d = makeDict(
      new Map([['hiddenaction', '隐藏行动']]),
      new Map([['隐藏行动', 'hiddenAction']]),
      new Map(),
      new Map([
        ['隐藏行动', 'hiddenAction'],
        ['隐藏行动_', 'hiddenAction_'],
      ]),
    )
    const tracker = new Map<string, string>()
    expect(zhToEn('[隐藏行动_治疗友军]', d, tracker)).toBe('[hiddenAction_治疗友军]')
  })

  it('完整复合字段优先于下划线分段翻译', () => {
    const d = makeDict(
      new Map([
        ['addwaypoint', '添加路径点'],
        ['type', '类型'],
        ['addwaypoint_type', '添加路径点动作类型'],
        ['addwaypoint_target_nearestunit_tagged', '添加路径点检索标签'],
        ['takeresources', '提取资源'],
        ['takeresources_includeunitswithinrange', '提取资源范围'],
        ['takeresources_excludeunitswithouttags', '提取资源标签'],
      ]),
      new Map([
        ['添加路径点', 'addwaypoint'],
        ['类型', 'type'],
        ['添加路径点动作类型', 'addwaypoint_type'],
        ['添加路径点检索标签', 'addwaypoint_target_nearestunit_tagged'],
        ['提取资源', 'takeresources'],
        ['提取资源范围', 'takeresources_includeunitswithinrange'],
        ['提取资源标签', 'takeresources_excludeunitswithouttags'],
      ]),
    )
    const tracker = new Map<string, string>()
    const original = [
      'addWaypoint_type: move',
      'addWaypoint_target_nearestUnit_tagged: repair',
      'takeResources_includeUnitsWithinRange: 300',
      'takeResources_excludeUnitsWithoutTags: medic',
    ].join('\n')

    const zh = enToZh(original, d, tracker)

    expect(zh).toBe([
      '添加路径点动作类型: move',
      '添加路径点检索标签: repair',
      '提取资源范围: 300',
      '提取资源标签: medic',
    ].join('\n'))
    expect(zhToEn(zh, d, tracker)).toBe(original)
  })

  it('中文 → 英文（最长匹配优先）', () => {
    expect(zhToEn('名称 = "步枪兵"', dict())).toBe('name = "rifleman"')
    expect(zhToEn('价格 = 300', dict())).toBe('price = 300')
  })

  it('全角冒号按键值分隔解析并在回写时规范为 ASCII 冒号', () => {
    const tracker = new Map<string, string>()
    const shown = enToZh('name：rifleman', dict(), tracker)
    expect(shown).toBe('名称：步枪兵')
    expect(zhToEn(shown, dict(), tracker)).toBe('name:rifleman')
  })

  it('注释和 CRLF 回译保持结构与行尾不变', () => {
    const tracker = new Map<string, string>()
    const source = '# name: rifleman\r\nname：rifleman # health: 100\r\n[core] # note：keep\r\n'
    const shown = enToZh(source, dict(), tracker)
    expect(shown).toBe('# name: rifleman\r\n名称：步枪兵 # health: 100\r\n[core] # note：keep\r\n')
    expect(zhToEn(shown, dict(), tracker)).toBe('# name: rifleman\r\nname:rifleman # health: 100\r\n[core] # note：keep\r\n')
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

  it('isbuilder 与 isBuilder 中文显示往返保留原始键大小写', () => {
    const d = makeDict(
      new Map([['isbuilder', '是建造者']]),
      new Map([['是建造者', 'isBuilder']]),
    )
    const tracker = new Map<string, string>()
    const original = 'isbuilder: true\nisBuilder: false'
    const zh = enToZh(original, d, tracker)
    expect(zh).toBe('是建造者: true\nisBuilder: false')
    expect(zhToEn(zh, d, tracker)).toBe(original)
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

describe('M32 保存回译修复（E1/E2/E3）', () => {
  function dict() {
    return makeDict(
      new Map([
        ['x', 'x坐标'],
        ['y', 'y坐标'],
        ['name', '名称'],
        ['attack', '攻击'],
        ['tank', '坦克'],
        ['true', '是'],
      ]),
      new Map([
        ['x坐标', 'x'],
        ['y坐标', 'y'],
        ['名称', 'name'],
        ['攻击', 'attack'],
        ['坦克', 'tank'],
        ['是', 'true'],
      ]),
      new Map([
        ['x坐标', 'x'],
        ['y坐标', 'y'],
        ['名称', 'name'],
        ['生命值', 'hp'],
      ]),
    )
  }

  it('E1：ASCII 开头译名键（x坐标）保存往返无损，不再中文键写盘', () => {
    const d = dict()
    const tracker = new Map<string, string>()
    const original = '[turret_1]\nx: 50\ny: 20'
    const zh = enToZh(original, d, tracker)
    expect(zh).toContain('x坐标: 50')
    expect(zh).toContain('y坐标: 20')
    // 无任何编辑直接保存：回译必须还原成英文键（旧实现会原样中文写盘）
    const back = zhToEn(zh, d, tracker)
    expect(back).toBe(original)
  })

  it('E1b：x坐标 键不做编辑时 dirty 判定为 false（回译 == 原文）', () => {
    const d = dict()
    const tracker = new Map<string, string>()
    const original = 'x: 50'
    const zh = enToZh(original, d, tracker)
    expect(zhToEn(zh, d, tracker)).toBe(original)
  })

  it('E2：用户中文值与词典译名词内撞串（攻击力强 里的 攻击）保存不被改写', () => {
    const d = dict()
    const tracker = new Map<string, string>()
    // 文件里同时有英文 attack 键（登记 攻击→attack）与用户中文值「攻击力强」
    const zh = enToZh('attack: 1\ndescription: 攻击力强', d, tracker)
    expect(zh).toBe('攻击: 1\ndescription: 攻击力强')
    const back = zhToEn(zh, d, tracker)
    // 「攻击」键位置还原；「攻击力强」中词内「攻击」不得改写
    expect(back).toBe('attack: 1\ndescription: 攻击力强')
  })

  it('E3：表单新增中文键未登记 tracker → 键位置词典兜底回译（不中文写盘）', () => {
    const d = dict()
    // 空 tracker 模拟表单写入（不登记）：中文键靠词典兜底还原
    const tracker = new Map<string, string>()
    const back = zhToEn('[核心]\n名称: myTank', d, tracker)
    expect(back).toBe('[核心]\nname: myTank')
  })

  it('值位置未登记的中文保留（词典兜底只用于键位置）', () => {
    const d = dict()
    const tracker = new Map<string, string>()
    const back = zhToEn('name: 攻击力强', d, tracker)
    expect(back).toBe('name: 攻击力强')
  })

  it('E4：needName 节中文名（[炮塔_主炮]）只回译翻译部分 → [turret_主炮]', () => {
    const d = makeDict(
      new Map([['turret', '炮塔'], ['name', '名称'], ['tank', '坦克']]),
      new Map([['炮塔', 'turret'], ['名称', 'name'], ['坦克', 'tank']]),
      new Map([['炮塔', 'turret'], ['名称', 'name']]),
    )
    const tracker = new Map<string, string>()
    // enToZh：turret_1 节登记 炮塔_1；补全提交的 [炮塔_ 前缀登记 炮塔（不带 _）
    const zh = enToZh('[turret_1]\nname: tank', d, tracker)
    expect(zh).toContain('[炮塔_1]')
    tracker.set('炮塔', 'turret') // 模拟中文模式下补全提交 [炮塔_ 前缀
    // 用户中文模式输入 主炮 作为节实例名（不登记 tracker）
    const back = zhToEn('[炮塔_主炮]\n名称: myTank', d, tracker)
    // 「炮塔」来自翻译还原成 turret，实例名「主炮」是用户数据保留
    expect(back).toBe('[turret_主炮]\nname: myTank')
  })

  it('宏字段带数字后缀（建造自_1_名称_2）整体回译', () => {
    const d = makeDict(
      new Map([['builtfrom', '建造自'], ['name', '名称'], ['tank', '坦克']]),
      new Map([['建造自', 'builtfrom'], ['名称', 'name'], ['坦克', 'tank']]),
    )
    const tracker = new Map<string, string>()
    const zh = enToZh('builtFrom_1_name_2: tank', d, tracker)
    expect(zh).toContain('建造自_1_名称_2')
    const back = zhToEn(zh, d, tracker)
    expect(back).toBe('builtFrom_1_name_2: tank')
  })

  it('值位置下划线后缀保留（坦克_2 不被改写；键位置宏字段后缀仍回译）', () => {
    const d = makeDict(
      new Map([['tank', '坦克'], ['name', '名称'], ['builtfrom', '建造自']]),
      new Map([['坦克', 'tank'], ['名称', 'name'], ['建造自', 'builtfrom']]),
    )
    const tracker = new Map<string, string>()
    const zh = enToZh('name: 坦克_2\nbuiltFrom_1_name: tank', d, tracker)
    expect(zh).toContain('名称: 坦克_2')
    expect(zh).toContain('建造自_1_名称')
    const back = zhToEn(zh, d, tracker)
    // 值位置 坦克_2 完整保留（严格边界）；键位置宏字段回译
    expect(back).toBe('name: 坦克_2\nbuiltFrom_1_name: tank')
  })

  it('分隔符前空白保留（name = 50 往返无损，不误标脏）', () => {
    const d = makeDict(
      new Map([['name', '名称']]),
      new Map([['名称', 'name']]),
      new Map([['名称', 'name']]),
    )
    const tracker = new Map<string, string>()
    const original = 'name = 50'
    const zh = enToZh(original, d, tracker)
    expect(zh).toBe('名称 = 50')
    const back = zhToEn(zh, d, tracker)
    expect(back).toBe(original)
  })

  it('中文手输的布尔/枚举值保存前规范化，自由值保持原样', () => {
    const d = makeDict(
      new Map([
        ['isBio', '生物单位'],
        ['movementType', '移动类型'],
        ['name', '名称'],
      ]),
      new Map([
        ['生物单位', 'isBio'],
        ['移动类型', 'movementType'],
        ['名称', 'name'],
      ]),
      new Map([
        ['生物单位', 'isBio'],
        ['移动类型', 'movementType'],
        ['名称', 'name'],
      ]),
      undefined,
      undefined,
      undefined,
      new Set(['name']),
      undefined,
      (key) => key === 'name',
      (key, value) => key === 'isBio' ? (value.trim() === '是' ? 'true' : value) : key === 'movementType' && value.trim() === '空中' ? 'AIR' : value,
    )
    const tracker = new Map<string, string>()
    const view = '[core]\n生物单位: 是\n移动类型: 空中\n名称: 攻击'
    expect(zhToEn(view, d, tracker)).toBe('[core]\nisBio:true\nmovementType:AIR\nname: 攻击')
  })
})
