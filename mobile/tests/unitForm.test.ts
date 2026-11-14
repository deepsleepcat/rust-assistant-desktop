/**
 * 单位表单同步（M14，任务 4）测试：解析/写回/默认值/校验。
 * 「表单审计第一轮修复回归」覆盖：等号分隔符、多炮塔独立节、重复键生效值、
 * 值内 # 语义、三引号块跳过、资源路径坐标统一、炮塔节增删。
 */
import { describe, expect, it } from 'vitest'
import {
  appendTurretSection,
  applyUnitFormValue,
  fillDefaults,
  isUnitFile,
  nextTurretSectionName,
  parseUnitForm,
  removeUnitSection,
  unitResourceRelPath,
  validateFormValue,
} from '../src/features/editor/unitForm/unitFormSync'
import { findUnitField, UNIT_FORM_GROUPS } from '../src/features/editor/unitForm/unitFormFields'

const SAMPLE = `[core]
name: myTank
price: 300
maxHp: 500

[graphics]
image: tank.png
shadowOffsetX: 1

[movement]
movementType: LAND
moveSpeed: 1.0
`

describe('parseUnitForm', () => {
  it('解析已知字段为表单状态（未知键忽略）', () => {
    const state = parseUnitForm(SAMPLE)
    const core = state['core'] ?? []
    expect(core.find((v) => v.key === 'name')?.value).toBe('myTank')
    expect(core.find((v) => v.key === 'maxHp')?.value).toBe('500')
    expect(core.some((v) => v.key === 'unknownKey')).toBe(false)
    expect(state['movement']?.find((v) => v.key === 'moveSpeed')?.value).toBe('1.0')
  })

  it('空文件/非单位文件返回空状态', () => {
    expect(parseUnitForm('')).toEqual({})
    expect(parseUnitForm('[mod]\ntitle: x\n')).toEqual({})
  })

  it('中文显示层（zhToEn）回译后解析', () => {
    const zh = '[核心]\n名称: 我的坦克\n生命值: 800\n'
    const state = parseUnitForm(zh, { zhToEn: (k) => (k === '核心' ? 'core' : k === '名称' ? 'name' : k === '生命值' ? 'maxHp' : undefined) })
    expect(state['core']?.find((v) => v.key === 'name')?.value).toBe('我的坦克')
    expect(state['core']?.find((v) => v.key === 'maxHp')?.value).toBe('800')
  })
})

describe('fillDefaults', () => {
  it('缺失字段补默认值并标记 present=false', () => {
    const state = fillDefaults(parseUnitForm('[core]\nname: x\n'))
    const core = state['core'] ?? []
    expect(core.find((v) => v.key === 'name')?.present).toBe(true)
    expect(core.find((v) => v.key === 'price')?.present).toBe(false)
    expect(core.find((v) => v.key === 'price')?.value).toBe('300')
    // 无炮塔节时不生成 turret 实例；其余四组全有
    expect(Object.keys(state).sort()).toEqual(['attack', 'core', 'graphics', 'movement'])
  })

  it('炮塔节按实际节名逐实例补默认值', () => {
    const state = fillDefaults(parseUnitForm('[core]\nname: x\n[turret_1]\nx: 5\n[turret_2]\n'))
    expect(state['turret_1']?.find((v) => v.key === 'x')?.value).toBe('5')
    expect(state['turret_1']?.find((v) => v.key === 'projectile')?.present).toBe(false)
    expect(state['turret_2']?.find((v) => v.key === 'x')?.value).toBe('0')
    expect(state['turret_3']).toBeUndefined()
  })
})

describe('applyUnitFormValue', () => {
  it('已存在键整行替换：值内 # 属于值，不再当行内注释保留', () => {
    const out = applyUnitFormValue('[core]\nmaxHp: 500 # 血\n', 'core', 'maxHp', '800')
    expect(out).toBe('[core]\nmaxHp: 800\n')
  })

  it('节存在键缺失：追加到节尾（节内有其他内容不破坏）', () => {
    const out = applyUnitFormValue('[core]\nname: x\n\n[graphics]\nimage: a.png\n', 'graphics', 'shadowOffsetX', '2')
    expect(out).toBe('[core]\nname: x\n\n[graphics]\nimage: a.png\nshadowOffsetX: 2\n')
  })

  it('节不存在：按传入节名在文件尾创建', () => {
    const out = applyUnitFormValue('[core]\nname: x\n', 'movement', 'moveSpeed', '2.0')
    expect(out).toContain('\n[movement]\nmoveSpeed: 2.0')
  })

  it('CRLF 文件保持 CRLF', () => {
    const out = applyUnitFormValue('[core]\r\nname: x\r\n', 'core', 'maxHp', '1')
    expect(out).toContain('\r\n')
    expect(out.split('\r\n').some((l) => l === 'maxHp: 1')).toBe(true)
  })

  it('中文模式追加新键用中文键名', () => {
    const out = applyUnitFormValue('[核心]\n名称: x\n', 'movement', 'moveSpeed', '1', {
      enToZh: (k) => (k === 'moveSpeed' ? '移动速度' : undefined),
    })
    expect(out).toContain('移动速度: 1')
  })
})

describe('validateFormValue', () => {
  it('数字范围校验', () => {
    const field = findUnitField('maxHp')!
    expect(validateFormValue(field, '500')).toBeNull()
    expect(validateFormValue(field, '-1')).toContain('不能小于')
    expect(validateFormValue(field, 'abc')).toContain('数字')
    expect(validateFormValue(field, '')).toContain('必填')
  })

  it('数字输入中间态放行（M32：负号/1./.5/1e 可敲入）', () => {
    // shadowOffsetX 允许负数且无 min/max：输入过程中间态不得回退弹值
    const field = findUnitField('shadowOffsetX')!
    expect(validateFormValue(field, '-')).toBeNull()
    expect(validateFormValue(field, '1.')).toBeNull()
    expect(validateFormValue(field, '.5')).toBeNull()
    expect(validateFormValue(field, '1e')).toBeNull()
    expect(validateFormValue(field, '-0.5')).toBeNull()
    expect(validateFormValue(field, 'abc')).toContain('数字')
    // 完整数字仍受范围约束
    const bounded = findUnitField('maxHp')!
    expect(validateFormValue(bounded, '-')).toBeNull()
    expect(validateFormValue(bounded, '-1')).toContain('不能小于')
  })

  it('枚举校验（大小写不敏感）', () => {
    const field = findUnitField('movementType')!
    expect(validateFormValue(field, 'air')).toBeNull()
    expect(validateFormValue(field, 'FLYING')).toContain('必须是')
  })

  it('资源扩展名校验（NONE/AUTO/SHARED: 放行）', () => {
    const field = findUnitField('image')!
    expect(validateFormValue(field, 'tank.png')).toBeNull()
    expect(validateFormValue(field, 'NONE')).toBeNull()
    expect(validateFormValue(field, 'SHARED:beam3.png')).toBeNull()
    expect(validateFormValue(field, 'sound.ogg')).toContain('扩展名')
  })
})

describe('M14 审查修复回归', () => {
  it('[turret_1] 节独立解析与写回（官方真实节名）', () => {
    const content = '[core]\nname: t\n[turret_1]\nx: -14\ny: 5\nprojectile: 1\n'
    const state = parseUnitForm(content)
    expect(state['turret_1']?.find((v) => v.key === 'x')?.value).toBe('-14')
    // 写回 turret_1 的 x（不是新建 [turret] 节）
    const out = applyUnitFormValue(content, 'turret_1', 'x', '10')
    expect(out).toContain('[turret_1]')
    expect(out).toContain('x: 10')
    expect(out).not.toContain('\n[turret]\n')
  })

  it('shootDelay 接受官方 Ns 格式（text 类型）', () => {
    const field = findUnitField('shootDelay')!
    expect(field.type).toBe('text')
    expect(validateFormValue(field, '5s')).toBeNull()
    expect(validateFormValue(field, '20')).toBeNull()
  })

  it('shoot_sound 接受音效码名（text 类型）', () => {
    const field = findUnitField('shoot_sound')!
    expect(field.type).toBe('text')
    expect(validateFormValue(field, 'missile_fire')).toBeNull()
    expect(validateFormValue(field, 'NONE')).toBeNull()
  })

  it('清空非必填字段删除该行（不留空值行）', () => {
    const out = applyUnitFormValue('[core]\nname: x\nprice: 300\n', 'core', 'price', '')
    expect(out).toBe('[core]\nname: x\n')
  })

  it('键不存在且清空：无操作', () => {
    const out = applyUnitFormValue('[core]\nname: x\n', 'graphics', 'image', '')
    expect(out).toBe('[core]\nname: x\n')
  })
})

describe('M14 第二轮审查回归', () => {
  it('值内 # 保留为值的一部分（引擎只把整行 # 当注释）', () => {
    const state = parseUnitForm('[core]\nmaxHp: 500 # 血\n')
    expect(state['core']?.find((v) => v.key === 'maxHp')?.value).toBe('500 # 血')
  })

  it('中文文件替换键保留中文键名（不混入英文键）', () => {
    const zhToEn = (k: string) => (k === '核心' ? 'core' : k === '名称' ? 'name' : k === '生命值' ? 'maxHp' : undefined)
    const out = applyUnitFormValue('[核心]\n名称: x\n生命值: 500\n', 'core', 'maxHp', '800', { zhToEn })
    expect(out).toContain('生命值: 800')
    expect(out).not.toContain('maxHp: 800')
  })

  it('炮塔节不存在时按传入节名创建（turret_1）', () => {
    const out = applyUnitFormValue('[core]\nname: x\n', 'turret_1', 'x', '10')
    expect(out).toContain('[turret_1]')
    expect(out).not.toContain('[turret]\n')
  })

  it('shootDelay 格式校验（Ns 合法，abc 拒绝）', () => {
    const field = findUnitField('shootDelay')!
    expect(validateFormValue(field, '5s')).toBeNull()
    expect(validateFormValue(field, 'abc')).toContain('格式')
  })

  it('中文节名 isUnitFile 识别（[核心]）', () => {
    expect(isUnitFile('[核心]\n名称: x\n')).toBe(true)
    expect(isUnitFile('[core]\nname: x\n')).toBe(true)
    expect(isUnitFile('[graphics]\nimage: a.png\n')).toBe(false)
  })

  it('drawLayer 表单选项只含引擎真实绘制层（8 个，无 water——water 是 movementType 的值）', () => {
    const field = findUnitField('drawLayer')!
    const opts = Object.keys(field.options ?? {})
    expect([...opts].sort()).toEqual(['air', 'bottom', 'experimentals', 'ground', 'ground2', 'top', 'underwater', 'wreaks'].sort())
    expect(opts).not.toContain('water')
  })
})

describe('表单审计第一轮修复回归', () => {
  it('等号分隔符可解析，写回沿用原分隔符（不再重复添加字段）', () => {
    const source = '[core]\nname = tank\nmaxHp = 500\n'
    const state = parseUnitForm(source)
    expect(state['core']?.find((v) => v.key === 'maxHp')?.value).toBe('500')
    const edited = applyUnitFormValue(source, 'core', 'maxHp', '800')
    expect(edited).toContain('maxHp = 800')
    expect(edited).not.toContain('maxHp: 800')
    expect(edited).not.toContain('maxHp = 500')
  })

  it('多炮塔节独立解析与写回（改 turret_2 不影响 turret_1）', () => {
    const source = '[core]\nname: tank\n[turret_1]\nx: 1\n[turret_2]\nx: 2\nprojectile: secondary\n'
    const state = parseUnitForm(source)
    expect(state['turret_1']?.find((v) => v.key === 'x')?.value).toBe('1')
    expect(state['turret_2']?.find((v) => v.key === 'x')?.value).toBe('2')
    expect(state['turret_2']?.find((v) => v.key === 'projectile')?.value).toBe('secondary')
    const edited = applyUnitFormValue(source, 'turret_2', 'projectile', 'edited')
    expect(edited).toContain('[turret_1]\nx: 1\n[turret_2]\nx: 2\nprojectile: edited')
    expect(edited).not.toContain('projectile: secondary')
  })

  it('重复键显示游戏生效值（最后一处），写回更新生效行', () => {
    const source = '[core]\nname: tank\nmaxHp: 100\nmaxHp: 200\n'
    const v = parseUnitForm(source)['core']?.find((x) => x.key === 'maxHp')
    expect(v?.value).toBe('200')
    expect(v?.dupLines).toEqual([3, 4])
    const edited = applyUnitFormValue(source, 'core', 'maxHp', '500')
    expect(edited).toContain('maxHp: 100\nmaxHp: 500')
    expect(edited).not.toContain('maxHp: 200')
  })

  it('值内 # 不被截断，编辑后不带回旧值', () => {
    const source = '[core]\nname: tank #variant\n'
    expect(parseUnitForm(source)['core']?.[0].value).toBe('tank #variant')
    expect(applyUnitFormValue(source, 'core', 'name', 'new')).toBe('[core]\nname: new\n')
  })

  it('三引号多行字符串块内不解析键值', () => {
    const source = '[core]\nname: tank\ndisplayDescription: """\nx: 999\nmaxHp: 1\n"""\nprice: 300\n'
    const state = parseUnitForm(source)
    // 块内的 x/maxHp 不属于任何已映射字段，但 price 必须在块外正常解析
    expect(state['core']?.find((v) => v.key === 'price')?.value).toBe('300')
    expect(state['core']?.some((v) => v.key === 'maxHp')).toBe(false)
  })

  it('三引号块内不误匹配写回目标行', () => {
    const source = '[core]\nname: tank\ndisplayDescription: """\nmaxHp: 1\n"""\nmaxHp: 500\n'
    const edited = applyUnitFormValue(source, 'core', 'maxHp', '800')
    expect(edited).toContain('"""\nmaxHp: 1\n"""')
    expect(edited).toContain('maxHp: 800')
    expect(edited).not.toContain('maxHp: 500')
  })

  it('资源路径统一到项目根坐标：同目录资源写相对文件名（不再 ../../..）', () => {
    // 单位与资源同目录（正斜杠绝对路径）
    expect(unitResourceRelPath('/app/projects/demo/units/tank/tank.ini', '/app/projects/demo', 'units/tank/body.png')).toBe('body.png')
    // 跨目录
    expect(unitResourceRelPath('/app/projects/demo/units/tank.ini', '/app/projects/demo', 'images/body.png')).toBe('../images/body.png')
  })

  it('资源路径兼容 Windows 反斜杠与大小写差异', () => {
    expect(unitResourceRelPath('D:\\proj\\demo\\units\\tank.ini', 'd:/proj/demo', 'units/tank.png')).toBe('tank.png')
    expect(unitResourceRelPath('/app/Demo/units/tank.ini', '/app/demo', 'units/tank.png')).toBe('tank.png')
  })

  it('炮塔节名递增、追加与删除', () => {
    expect(nextTurretSectionName('[core]\nname: x\n')).toBe('turret_1')
    expect(nextTurretSectionName('[turret_1]\nx: 0\n[turret_2]\nx: 0\n')).toBe('turret_3')
    const added = appendTurretSection('[core]\nname: x\n', 'turret_1')
    expect(added).toBe('[core]\nname: x\n\n[turret_1]\nx: 0\ny: 0\n')
    const removed = removeUnitSection(added, 'turret_1')
    expect(removed).toBe('[core]\nname: x\n')
    expect(removeUnitSection('[core]\nname: x\n', 'turret_9')).toBe('[core]\nname: x\n')
  })
})
