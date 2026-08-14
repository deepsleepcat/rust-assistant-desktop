/**
 * 单位表单同步（M14，任务 4）测试：解析/写回/默认值/校验。
 */
import { describe, expect, it } from 'vitest'
import { applyUnitFormValue, fillDefaults, parseUnitForm, validateFormValue } from '../src/features/editor/unitForm/unitFormSync'
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
    // 五组全有
    expect(Object.keys(state).length).toBe(UNIT_FORM_GROUPS.length)
  })
})

describe('applyUnitFormValue', () => {
  it('已存在键整行替换（保留注释）', () => {
    const out = applyUnitFormValue('[core]\nmaxHp: 500 # 血\n', 'core', 'maxHp', '800')
    expect(out).toBe('[core]\nmaxHp: 800 # 血\n')
  })

  it('节存在键缺失：追加到节尾（节内有其他内容不破坏）', () => {
    const out = applyUnitFormValue('[core]\nname: x\n\n[graphics]\nimage: a.png\n', 'graphics', 'shadowOffsetX', '2')
    expect(out).toBe('[core]\nname: x\n\n[graphics]\nimage: a.png\nshadowOffsetX: 2\n')
  })

  it('节不存在：文件尾新建节', () => {
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
