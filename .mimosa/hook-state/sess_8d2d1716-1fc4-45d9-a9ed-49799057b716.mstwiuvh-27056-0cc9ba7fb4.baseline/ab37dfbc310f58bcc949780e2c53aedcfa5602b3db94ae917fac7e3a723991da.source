import { describe, expect, it } from 'vitest'
import { lintIniText, stripInlineComment, validateValue } from '../src/features/editor/rustLint'
import type { ValueTypeInfo } from '../src/services/codeData'

/** 测试用最小数据源 */
const TYPE_RULES: Record<string, ValueTypeInfo> = {
  int: { name: '整数', type: 'int', rule: '^\\$\\{[^.]+\\.?[^.]+\\}|^-?\\d+' },
  float: { name: '小数', type: 'float', rule: '^\\$\\{[^.]+\\.?[^.]+\\}|^-?\\d+\\.?\\d*' },
  boolean: { name: '布尔', type: 'boolean', rule: 'true|false' },
  color: { name: '颜色', type: 'color', rule: '#[\\dA-Fa-f]{8}|#[\\dA-Fa-f]{6}' },
  time: { name: '时间', type: 'time', rule: '-?\\d+\\.?\\d*s?' },
  movementType: { name: '移动类型', type: 'movementType', rule: 'NONE|LAND|BUILDING|AIR|WATER|HOVER|OVER_CLIFF|OVER_CLIFF_WATER' },
  image: { name: '图像', type: 'image', rule: 'NONE|AUTO|.+\\.png' },
  baseImage: { name: '底图', type: 'baseImage', rule: '.+\\.png|.+\\.jpg' },
  position: { name: '坐标', type: 'position', rule: '-?\\d+,-?\\d+' },
  string: { name: '字符串', type: 'string', rule: '.+' },
  key: { name: '键', type: 'key', rule: '^[^#:]+:' },
}

const data = {
  findCode: (k: string) => {
    const map: Record<string, { type: string }> = {
      maxHp: { type: 'int' },
      speed: { type: 'float' },
      isBio: { type: 'boolean' },
      color: { type: 'color' },
      life: { type: 'time' },
      movementType: { type: 'movementType' },
      image: { type: 'baseImage' },
      image_shadow: { type: 'image' },
      pos: { type: 'position' },
      displayText: { type: 'string' },
      canBuild_1_name: { type: 'key' },
      // 中文模式：名称 → name（string）
      name: { type: 'string' },
    }
    return map[k]
  },
  findType: (t: string) => TYPE_RULES[t],
  zhToEn: (k: string) => (k === '名称' ? 'name' : k === '是' ? 'true' : k === '真' ? 'true' : k === '假' ? 'false' : k === '生命值' ? 'maxHp' : undefined),
}

describe('值合法性检查（validateValue）', () => {
  it('合法值通过', () => {
    expect(validateValue('maxHp', '100', data)).toBeNull()
    expect(validateValue('maxHp', '-5', data)).toBeNull()
    expect(validateValue('speed', '1.5', data)).toBeNull()
    expect(validateValue('speed', '0', data)).toBeNull()
    expect(validateValue('isBio', 'true', data)).toBeNull()
    expect(validateValue('isBio', 'false', data)).toBeNull()
    expect(validateValue('life', '0.5s', data)).toBeNull()
    expect(validateValue('movementType', 'AIR', data)).toBeNull()
    expect(validateValue('image', 'CORE:/tank/base.png', data)).toBeNull()
    expect(validateValue('image', 'SHARED:/tank/base.jpg', data)).toBeNull()
    expect(validateValue('image_shadow', 'AUTO', data)).toBeNull()
    expect(validateValue('image_shadow', 'NONE', data)).toBeNull()
    expect(validateValue('pos', '-1,2', data)).toBeNull()
  })

  it('非法值报错（含期望说明）', () => {
    const err = validateValue('maxHp', 'abc', data)
    expect(err).toContain('maxHp')
    expect(err).toContain('不符合类型 int')
    expect(validateValue('isBio', 'yes', data)).not.toBeNull()
    expect(validateValue('color', 'red', data)).not.toBeNull()
    expect(validateValue('movementType', 'FLY', data)).not.toBeNull()
  })

  it('行内注释先剥离再校验', () => {
    expect(validateValue('movementType', 'LAND     # NONE/LAND/BUILDING/AIR...', data)).toBeNull()
    expect(validateValue('maxHp', '100   # 血量上限', data)).toBeNull()
  })

  it('变量引用 ${...} 放行', () => {
    expect(validateValue('maxHp', '${self.maxHp}', data)).toBeNull()
    expect(validateValue('life', '${self.life}', data)).toBeNull()
  })

  it('中文模式兼容：中文键/中文布尔值', () => {
    expect(validateValue('名称', '步枪兵', data)).toBeNull() // string 类型不检查
    expect(validateValue('生命值', '100', data)).toBeNull() // 中文键 → maxHp
    expect(validateValue('isBio', '是', data)).toBeNull() // 是 → true
    expect(validateValue('isBio', '真', data)).toBeNull()
    expect(validateValue('isBio', '假', data)).toBeNull()
  })

  it('键不在代码表 / 无规则 / 行级规则 → 不检查', () => {
    expect(validateValue('自定义字段', '任意内容', data)).toBeNull()
    expect(validateValue('displayText', '任意说明', data)).toBeNull() // string
    expect(validateValue('canBuild_1_name', 'landFactory', data)).toBeNull() // key 是行级规则
  })

  it('值内任意位置含 ${ 视为表达式放行', () => {
    expect(validateValue('speed', '0.3+cos( ${timer_2s} * 360) * 0.2', data)).toBeNull()
  })

  it('逗号分隔多值列表：任一元素合法即放行', () => {
    // 模拟 effect 类型（rule 只认 NONE/CUSTOM:，但列表里可以混普通特效名）
    const effectData = {
      ...data,
      findCode: (k: string) => (k === 'explodeEffect' ? { type: 'effect' } : data.findCode(k)),
      findType: (t: string) => (t === 'effect' ? { name: '特效', type: 'effect', rule: '[nN][oO][nN][eE]|[cC][uU][sS][tT][oO][mM]:.+' } : data.findType(t)),
    }
    expect(validateValue('explodeEffect', 'smallExplosion, CUSTOM:hitLightFlash, CUSTOM:projectilePassThrough', effectData)).toBeNull()
    expect(validateValue('explodeEffect', 'CUSTOM:hitLightFlash', effectData)).toBeNull()
  })

  it('大小写不敏感回退（Upgrade 匹配规则里的 upgrade）', () => {
    const dtData = {
      ...data,
      findCode: (k: string) => (k === 'displayType' ? { type: 'displayType' } : data.findCode(k)),
      findType: (t: string) => (t === 'displayType' ? { name: '显示类型', type: 'displayType', rule: 'NONE|rally|upgrade|queueUnit|building|action|infoOnly|infoOnlyNoBox' } : data.findType(t)),
    }
    expect(validateValue('displayType', 'Upgrade', dtData)).toBeNull()
  })

  it('布尔/逻辑字段允许 if 语句与 CUSTOM: 引用', () => {
    const logicData = {
      ...data,
      findCode: (k: string) => (k === 'ai_isDisabled' ? { type: 'boolean' } : data.findCode(k)),
    }
    expect(validateValue('ai_isDisabled', 'if self.ammo(greaterThan=3)', logicData)).toBeNull()
    expect(validateValue('trailEffect', 'CUSTOM:projectileTrail', logicData)).toBeNull()
  })
})

describe('stripInlineComment', () => {
  it('剥离空格开头的注释', () => {
    expect(stripInlineComment('LAND     # NONE/LAND')).toBe('LAND')
    expect(stripInlineComment('true # 是否生物')).toBe('true')
  })

  it('颜色值 # 开头不受影响', () => {
    expect(stripInlineComment('#FFccCCEE')).toBe('#FFccCCEE')
  })
})

describe('整篇文档诊断（lintIniText）', () => {
  it('合法的单位文件无诊断', () => {
    const content = `[core]
name: 测试单位
maxHp: 100
isBio: false

[graphics]
image: CORE:/unit/base.png
image_shadow: AUTO
`
    expect(lintIniText(content, data)).toEqual([])
  })

  it('非法值 → error 且范围指向值部分', () => {
    const content = '[core]\nmaxHp: 不是数字\n'
    const diags = lintIniText(content, data)
    expect(diags).toHaveLength(1)
    expect(diags[0].severity).toBe('error')
    // from 指向行内冒号后（即值部分起点）
    expect(diags[0].from).toBe(content.indexOf(':') + 1)
  })

  it('节外键值行 → warning', () => {
    const content = 'name: 没进节的单位\n[core]\nmaxHp: 100\n'
    const diags = lintIniText(content, data)
    expect(diags.some((d) => d.severity === 'warning' && d.message.includes('不在任何'))).toBe(true)
  })

  it('注释行与空行不产生诊断', () => {
    expect(lintIniText('# 注释\n\n[core]\nmaxHp: 100\n', data)).toEqual([])
  })
})

describe('M13 多值类型 OR 语义（float,logicBoolean）', () => {
  const multiData = {
    findCode: (k: string) => {
      const map: Record<string, { type: string }> = {
        selfBuildRate: { type: 'float,logicBoolean' },
        ai_isDisabled: { type: 'logicBoolean' },
        imageScaleX: { type: 'float,logicBoolean' },
        // 中文模式键回译
        自动建造速度: { type: 'float,logicBoolean' },
      }
      return map[k]
    },
    findType: (t: string) => (t === 'float' ? TYPE_RULES.float : t === 'logicBoolean' ? { name: '逻辑布尔', type: 'logicBoolean', rule: 'true|false|if.*' } : TYPE_RULES[t]),
    zhToEn: (k: string) => (k === '自动建造速度' ? 'selfBuildRate' : undefined),
  }

  it('float,logicBoolean 接受数字（float 段规则）', () => {
    expect(validateValue('selfBuildRate', '0.5', multiData)).toBeNull()
  })

  it('float,logicBoolean 接受动态逻辑（logicBoolean 段规则 + if 放行）', () => {
    expect(validateValue('selfBuildRate', 'if self.ammo(greaterThan=3)', multiData)).toBeNull()
    expect(validateValue('imageScaleX', '(self.resource.持续时间/90)', multiData)).toBeNull()
  })

  it('中文显示层：如果 开头的逻辑值放行（默认中文模式高频场景）', () => {
    expect(validateValue('自动建造速度', '如果 self.ammo(greaterThan=3)', multiData)).toBeNull()
    expect(validateValue('ai_isDisabled', '如果 self.hp(lessThan=50) 和 self.energy(greaterThan=10)', multiData)).toBeNull()
  })

  it('logicBoolean 的 if/CUSTOM 放行', () => {
    expect(validateValue('ai_isDisabled', 'if self.ammo(greaterThan=3)', multiData)).toBeNull()
    expect(validateValue('ai_isDisabled', 'CUSTOM:my_condition', multiData)).toBeNull()
  })

  it('非法值仍报错', () => {
    expect(validateValue('selfBuildRate', 'abc', multiData)).not.toBeNull()
  })
})
