import { describe, expect, it } from 'vitest'
import { lintIniText, semanticInputContent, stripInlineComment, validateValue } from '../src/features/editor/rustLint'
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
      isBuilder: { type: 'boolean' },
    }
    return map[k] ?? map[Object.keys(map).find((name) => name.toLowerCase() === k.toLowerCase()) ?? '']
  },
  findType: (t: string) => TYPE_RULES[t],
  zhToEn: (k: string) => (k === '名称' ? 'name' : k === '是' ? 'true' : k === '真' ? 'true' : k === '假' ? 'false' : k === '生命值' ? 'maxHp' : undefined),
}

describe('语义检查输入', () => {
  it('中文显示层逻辑函数使用 tracker 恢复英文，普通中文值不被改写', () => {
    const tracker = new Map([['血量', 'hp'], ['自动触发', 'autoTrigger']])
    const input = '自动触发: if self.血量(lessThan=120)\ndescription: 血量不足时治疗'
    expect(semanticInputContent(input, tracker)).toBe('autoTrigger: if self.hp(lessThan=120)\ndescription: 血量不足时治疗')
  })
})

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

  it('isBuilder 大小写不敏感：isbuilder 与 isBuilder 都通过布尔校验', () => {
    expect(validateValue('isbuilder', 'true', data)).toBeNull()
    expect(validateValue('isBuilder', 'false', data)).toBeNull()
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

describe('M28 真实模组对齐（引擎源码实证）', () => {
  /** 枚举类类型（value_type.json 形态：rule 空 + list 逗号分隔字符串） */
  const enumData = {
    findCode: (k: string) => {
      const map: Record<string, { type: string }> = {
        autoTriggerOnEvent: { type: 'autoTriggerOnEvent' },
        drawType: { type: 'drawType' },
        trailEffect: { type: 'effect' },
        spawnUnits: { type: 'spawnUnits' },
        imageScale: { type: 'float' },
        alpha: { type: 'float,logicBoolean' },
        invisible: { type: 'boolean' },
        addResources: { type: 'resource' },
      }
      return map[k]
    },
    findType: (t: string) => {
      const types: Record<string, ValueTypeInfo> = {
        ...TYPE_RULES,
        autoTriggerOnEvent: {
          name: '自动触发事件', type: 'autoTriggerOnEvent', rule: '',
          list: 'created,completeAndActive,destroyed,killedAnyUnit,queuedUnitFinished,queueItemAdded(withActionTag="#"),queueItemCancelled(withActionTag="#"),teleported,touchTargetSuccess,newWaypointGivenByPlayer,teamChanged,transportingNewUnit,transportUnloadedOrRemovedUnit,tookDamage(withTag="#"),newMessage(withTag="#"),enteredTransport,leftTransport,attachmentRemoved',
        },
        drawType: { name: '绘制类型', type: 'drawType', rule: '-?\\d+|normal|displacement', list: '0,1,normal,displacement' },
        effect: { name: '效果', type: 'effect', rule: '', list: '' },
        spawnUnits: {
          name: '动作产生单位', type: 'spawnUnits', rule: '',
          list: 'neutralTeam,setToTeamOfLastAttacker,spawnChance,maxSpawnLimit,gridAlign,skipIfOverlapping,offsetX,offsetY,offsetRandomX,offsetRandomY,offsetRandomDir,addResources,spawnSource,techLevel,alwayStartDirAtZero,transportedUnitsToTransfer,copyWaypointsFrom,falling,offsetHeight,offsetDir,offsetRandomXY,aggressiveTeam,alwaysStartDirAtZero',
        },
        resource: { name: '资源', type: 'resource', rule: '.+[=:]-?\\d+(?:\\.\\d+)?|-?\\d+(?:\\.\\d+)?' },
      }
      return types[t]
    },
  }

  it('枚举类类型用 list 校验（引擎 ae.java 枚举 equalsIgnoreCase 匹配；列表条目自身可带参数示例）', () => {
    expect(validateValue('autoTriggerOnEvent', 'created', enumData)).toBeNull()
    expect(validateValue('autoTriggerOnEvent', 'tookDamage', enumData)).toBeNull() // 真实模组
    expect(validateValue('autoTriggerOnEvent', 'newMessage(withTag="工程虫")', enumData)).toBeNull() // 带参数
    expect(validateValue('autoTriggerOnEvent', 'QUEUEITEMADDED', enumData)).toBeNull() // 大小写不敏感
    expect(validateValue('autoTriggerOnEvent', 'notAnEvent', enumData)).not.toBeNull()
  })

  it('drawType 双形态：数字（ca.java Short 读取）与枚举（br.java 字符串）', () => {
    expect(validateValue('drawType', '0', enumData)).toBeNull()
    expect(validateValue('drawType', 'displacement', enumData)).toBeNull()
    expect(validateValue('drawType', 'bogus', enumData)).not.toBeNull()
  })

  it('effect 类型无约束放行（值 = 任意效果节名）', () => {
    expect(validateValue('trailEffect', '波', enumData)).toBeNull() // 真实模组
    expect(validateValue('trailEffect', 'CUSTOM:光', enumData)).toBeNull()
    expect(validateValue('trailEffect', 'wj', enumData)).toBeNull()
  })

  it('spawnUnits 结构校验：单位名(参数) / *数量 / 嵌套函数调用参数', () => {
    expect(validateValue('spawnUnits', '开馈赠(spawnChance=0.2,maxSpawnLimit=1)', enumData)).toBeNull()
    expect(validateValue('spawnUnits', '色幕(addResources=setFlag:1,offsetX=4200,alwayStartDirAtZero=true)', enumData)).toBeNull()
    expect(validateValue('spawnUnits', '原生-兵卵*1(spawnChance=0.1,maxSpawnLimit=1,offsetX=-30)', enumData)).toBeNull()
    expect(validateValue('spawnUnits', '中立视野副本(spawnSource=createMarker(x=self.x(), y=self.y(), teamId=thisActionTarget.teamId()))', enumData)).toBeNull()
    expect(validateValue('spawnUnits', 'sy(spawnChance=0.51,offsetRandomX=200,offsetRandomY=200,offsetRandomDir=360)', enumData)).toBeNull()
    expect(validateValue('spawnUnits', 'sas*1(Y偏移=8,效果产生几率=0.045),gign*1(Y偏移=8,效果产生几率=0.045)', enumData)).toBeNull()
    expect(validateValue('spawnUnits', 'sas(offsetY=8,生成概率=0.045,damagingBorder=true,zoneMarker=marker)', enumData)).toBeNull()
    expect(validateValue('spawnUnits', '色幕', enumData)).toBeNull()
    expect(validateValue('spawnUnits', '单位(未知参数=1)', enumData)).not.toBeNull()
    expect(validateValue('spawnUnits', '单位(offsetX)', enumData)).not.toBeNull()
  })

  it('float 时间后缀与算术表达式（引擎 time 读取：数字 + 可选 s）', () => {
    expect(validateValue('imageScale', '0.5', enumData)).toBeNull()
    expect(validateValue('imageScale', '1/2', enumData)).toBeNull() // 算术表达式（星球文件）
    expect(validateValue('imageScale', '1/5-0.01', enumData)).toBeNull()
    expect(validateValue('alpha', 'memory.time', enumData)).toBeNull() // 逻辑变量引用
    expect(validateValue('imageScale', 'abc', enumData)).not.toBeNull()
  })

  it('boolean 接受引擎 0/1（ae.java:622-635 equalsIgnoreCase）', () => {
    const boolData = {
      ...enumData,
      findType: (t: string) => (t === 'boolean' ? { name: '布尔', type: 'boolean', rule: 'true|false|1|0' } : enumData.findType(t)),
    }
    expect(validateValue('invisible', '0', boolData)).toBeNull()
    expect(validateValue('invisible', '1', boolData)).toBeNull()
    expect(validateValue('invisible', 'true', boolData)).toBeNull()
  })

  it('resource 值分隔符 = 与 : 都合法（真实模组 addResources:hp:-1000 / energy=0.505）', () => {
    expect(validateValue('addResources', 'hp=-1000', enumData)).toBeNull()
    expect(validateValue('addResources', 'hp:-1000', enumData)).toBeNull()
    expect(validateValue('addResources', 'energy=0.505', enumData)).toBeNull()
    expect(validateValue('addResources', '加速时间=1', enumData)).toBeNull() // 中文资源名
  })

  it('三引号多行字符串起始行放行（引擎 """ 语法）', () => {
    expect(validateValue('addResources', '"""', enumData)).toBeNull()
  })
})

describe('M28 审查修正回归（引擎语义实证）', () => {
  const boolData = {
    findCode: (k: string) => ({ unloadInCurrentPosition: { type: 'bool' }, autoTriggerOnEvent: { type: 'autoTriggerOnEvent' }, addResources: { type: 'resource' } } as Record<string, { type: string }>)[k],
    findType: (t: string) => {
      const types: Record<string, ValueTypeInfo> = {
        bool: { name: '布尔', type: 'bool', rule: 'true|false|1|0', list: 'true,false,1,0' },
        autoTriggerOnEvent: {
          name: '自动触发事件', type: 'autoTriggerOnEvent', rule: '',
          list: 'created,completeAndActive,destroyed,killedAnyUnit,queuedUnitFinished,queueItemAdded(withActionTag="#"),queueItemCancelled(withActionTag="#"),teleported,touchTargetSuccess,newWaypointGivenByPlayer,teamChanged,transportingNewUnit,transportUnloadedOrRemovedUnit,tookDamage(withTag="#"),newMessage(withTag="#"),enteredTransport,leftTransport,attachmentRemoved',
        },
        resource: { name: '资源', type: 'resource', rule: '.+[=:]-?\\d+(?:\\.\\d+)?|-?\\d+(?:\\.\\d+)?' },
      }
      return types[t]
    },
  }

  it('bool 类型接受引擎 0/1（ae.java Boolean 读取器 true/false/1/0 大小写不敏感）', () => {
    expect(validateValue('unloadInCurrentPosition', '0', boolData)).toBeNull()
    expect(validateValue('unloadInCurrentPosition', '1', boolData)).toBeNull()
    expect(validateValue('unloadInCurrentPosition', 'True', boolData)).toBeNull()
    expect(validateValue('unloadInCurrentPosition', 'abc', boolData)).not.toBeNull()
  })

  it('autoTriggerOnEvent 支持逗号多事件（ag.java:2513 括号感知分段）', () => {
    expect(validateValue('autoTriggerOnEvent', 'created,completeAndActive', boolData)).toBeNull()
    expect(validateValue('autoTriggerOnEvent', 'newMessage(withTag="a,b"),teamChanged', boolData)).toBeNull()
    expect(validateValue('autoTriggerOnEvent', 'created,bogus', boolData)).not.toBeNull()
  })

  it('resource 竖线分隔（引擎 d.b.a 按 , 或 | 分段）', () => {
    expect(validateValue('addResources', '500|100', boolData)).toBeNull()
    expect(validateValue('addResources', '矿=500|100', boolData)).toBeNull()
  })

  it('lintIniText：三引号多行字符串内行不参与键值校验（描述文本含 key: value 不误报）', () => {
    const content = `[core]\nname: x\ntext: """\nmaxHp: abc\n就是这样\n"""\n`
    expect(lintIniText(content, data)).toEqual([])
    // 串外同样的行仍报错（状态正确退出）
    const after = `[core]\nname: x\ntext: """\nmaxHp: abc\n"""\nmaxHp: abc\n`
    const diags = lintIniText(after, data)
    expect(diags.length).toBe(1)
    expect(diags[0].severity).toBe('error')
  })

  it('lintIniText：三引号同行开闭（key: """x"""）不吞后续行', () => {
    const content = `[core]\nname: x\nmaxHp: 100\ntext: """单行"""\nmaxHp: abc\n`
    const diags = lintIniText(content, data)
    // 只有串外的 maxHp 报错；text 行不进入多行串状态（否则后续 maxHp 被吞、无诊断）
    expect(diags.length).toBe(1)
    expect(diags[0].message).toContain('maxHp')
  })
})

describe('M38 中文枚举值回译（lint 不误报）', () => {
  const enumData = {
    findCode: (k: string) => {
      const map: Record<string, { type: string }> = {
        addWaypoint_target_nearestUnit_team: { type: 'addWaypoint_target_nearestUnit_team' },
        addWaypoint_target_nearestUnit_tagged: { type: 'string' },
        displayText: { type: 'string' },
      }
      return map[k]
    },
    findType: (t: string) => {
      const types: Record<string, ValueTypeInfo> = {
        addWaypoint_target_nearestUnit_team: {
          name: '路径点靠近队伍', type: 'addWaypoint_target_nearestUnit_team', rule: '',
          list: 'own,neutral,allyNotOwn,ally,enemy,any,notOwn',
        },
        string: { name: '字符串', type: 'string', rule: '.+' },
      }
      return types[t]
    },
    zhToEn: (_k: string) => undefined,
    valueZhToEn: (v: string) => {
      const map: Record<string, string> = {
        '己方': 'own', '中立': 'neutral', '友军': 'ally',
        '敌军': 'enemy', '任意': 'any', '非己方': 'notOwn',
        '友军（非己方）': 'allyNotOwn',
      }
      return map[v]
    },
  }

  it('中文枚举值回译后不报错（己方→own）', () => {
    expect(validateValue('addWaypoint_target_nearestUnit_team', '己方', enumData)).toBeNull()
  })

  it('其他中文枚举值同样不报错', () => {
    expect(validateValue('addWaypoint_target_nearestUnit_team', '中立', enumData)).toBeNull()
    expect(validateValue('addWaypoint_target_nearestUnit_team', '敌军', enumData)).toBeNull()
    expect(validateValue('addWaypoint_target_nearestUnit_team', '任意', enumData)).toBeNull()
    expect(validateValue('addWaypoint_target_nearestUnit_team', '友军（非己方）', enumData)).toBeNull()
  })

  it('逗号分隔多值中文枚举逐段回译', () => {
    expect(validateValue('addWaypoint_target_nearestUnit_team', '己方,友军', enumData)).toBeNull()
    expect(validateValue('addWaypoint_target_nearestUnit_team', '己方,中立,友军', enumData)).toBeNull()
  })

  it('英文枚举值仍然正常', () => {
    expect(validateValue('addWaypoint_target_nearestUnit_team', 'own', enumData)).toBeNull()
    expect(validateValue('addWaypoint_target_nearestUnit_team', 'enemy', enumData)).toBeNull()
  })

  it('未知中文值仍报错', () => {
    expect(validateValue('addWaypoint_target_nearestUnit_team', '不存在的中文', enumData)).not.toBeNull()
  })

  it('无 valueZhToEn 时不报错（向后兼容）', () => {
    const noValueZh = { ...enumData, valueZhToEn: undefined }
    expect(validateValue('addWaypoint_target_nearestUnit_team', '己方', noValueZh)).not.toBeNull()
  })
})
