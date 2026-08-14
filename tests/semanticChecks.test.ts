/**
 * 语义检查器框架测试（M10，P1 任务 1）：
 * - 15 个专项检查器逐规则验证（触发/不触发/边界）；
 * - 注册表：默认配置、清洗、启用过滤；
 * - 统一入口：ruleIds 过滤、检查器异常隔离；
 * - 中文显示层（zhToEn 回译）与官方单位真实样例（无误报）。
 */
import { describe, expect, it } from 'vitest'
import { runSemanticChecks, semanticIssuesToDiagnostics, semanticLineStarts, lineNumberAtOffset } from '../src/features/editor/semanticChecks'
import {
  defaultSemanticCheckerConfig,
  enabledRuleIds,
  sanitizeCheckerConfig,
  ALL_SEMANTIC_CHECKERS,
} from '../src/features/editor/semanticChecks/registry'
import { checkKeyTypos, findSimilarKey } from '../src/features/editor/semanticChecks/checkKeyTypos'
import { DRAW_LAYERS } from '../src/features/editor/semanticChecks/checkDrawLayerEnum'
import type { SemanticCheckContext } from '../src/features/editor/semanticChecks'

/** 测试用代码表（覆盖各检查器用到的键） */
const CODES: Record<string, { type: string }> = {
  maxHp: { type: 'int' },
  mass: { type: 'int' },
  price: { type: 'resource' },
  radius: { type: 'float' },
  moveSpeed: { type: 'float' },
  moveAccelerationSpeed: { type: 'float' },
  moveDecelerationSpeed: { type: 'float' },
  maxTurnSpeed: { type: 'float' },
  turretTurnSpeed: { type: 'float' },
  life: { type: 'time' },
  speed: { type: 'float' },
  range: { type: 'float' },
  directDamage: { type: 'int' },
  x: { type: 'float' },
  y: { type: 'float' },
  drawLayer: { type: 'drawLayer' },
  shadowOffsetX: { type: 'float' },
  shadowOffsetY: { type: 'float' },
  image: { type: 'baseImage' },
  image_shadow: { type: 'image' },
  name: { type: 'string' },
  projectile: { type: 'projectile' },
  canAttack: { type: 'boolean' },
  canMove: { type: 'logicBoolean' },
  isActive: { type: 'logicBoolean' },
  builtFrom_1_name: { type: 'prefixKey' },
  action_1_convertTo: { type: 'key' },
  moveSpeed_typo: { type: 'float' }, // 故意不给，模拟未知键
}

const ctx: SemanticCheckContext = {
  findCode: (k) => CODES[k] ?? CODES[Object.keys(CODES).find((c) => c.toLowerCase() === k.toLowerCase()) ?? ''],
  codes: Object.keys(CODES),
  unitNames: new Set(['landFactory', 'myTank', 'airFactory']),
  zhToEn: (k) => (k === '名称' ? 'name' : k === '生命值' ? 'maxHp' : k === '移动速度' ? 'moveSpeed' : k === '绘制层' ? 'drawLayer' : undefined),
}

/** 官方单位真实样例（aa_beam_gunship 精简，应零报错） */
const OFFICIAL_UNIT = `[core]
name: aaBeamGunship
class: CustomUnitMetadata
displayLocaleKey: aaBeamGunship
price: 6000
maxHp: 2500
mass: 20000
techLevel: 2
buildSpeed: 35s
radius: 22
isBio: false
builtFrom_1_name: airFactory

[graphics]
total_frames: 1
image:        base3.png
image_wreak:  base3_dead.png
image_turret: NONE
image_shadow: AUTO
shadowOffsetX:1
shadowOffsetY:1

[attack]
canAttack: true
canAttackFlyingUnits: true
turretSize: 20
turretTurnSpeed: 1.8
maxAttackRange: 280
shootDelay: 20

[movement]
movementType: AIR
moveSpeed: 1.00
moveAccelerationSpeed: 0.015
moveDecelerationSpeed: 0.015
maxTurnSpeed: 1.2

[turret_1]
image: beam_turret.png
x: 0
y: 2
idleDir:0
projectile: beam

[projectile_beam]
life: 15
instant: true
directDamage: 22
explodeEffect: NONE
`

describe('注册表与配置', () => {
  it('15 个专项检查器全部注册（≥8 达标）', () => {
    expect(ALL_SEMANTIC_CHECKERS.length).toBeGreaterThanOrEqual(8)
    const ids = new Set(ALL_SEMANTIC_CHECKERS.map((c) => c.id))
    expect(ids.size).toBe(ALL_SEMANTIC_CHECKERS.length) // id 无重复
    expect(ids).toContain('checkKeyTypos')
    expect(ids).toContain('checkFile')
    expect(ids).toContain('checkProjectileLifecycle')
  })

  it('默认配置全部开启；清洗只保留已知 id', () => {
    const def = defaultSemanticCheckerConfig()
    expect(Object.keys(def).length).toBe(ALL_SEMANTIC_CHECKERS.length)
    expect(Object.values(def).every((v) => v === true)).toBe(true)
    const cleaned = sanitizeCheckerConfig({ checkFile: false, bogusRule: false, checkKeyTypos: 'yes' })
    expect(cleaned.checkFile).toBe(false)
    expect(cleaned.checkKeyTypos).toBe(true) // 非布尔忽略
    expect(cleaned.bogusRule).toBeUndefined()
    expect(enabledRuleIds(cleaned).has('checkFile')).toBe(false)
    expect(enabledRuleIds(cleaned).has('checkKeyTypos')).toBe(true)
  })

  it('未知配置输入回退默认', () => {
    expect(sanitizeCheckerConfig(null)).toEqual(defaultSemanticCheckerConfig())
    expect(sanitizeCheckerConfig('junk')).toEqual(defaultSemanticCheckerConfig())
  })
})

describe('统一入口', () => {
  it('ruleIds 过滤：只跑指定规则', () => {
    const bad = `[core]\nmaxHp: 0\nname: x\n`
    const issues = runSemanticChecks(bad, { ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(issues.length).toBe(1)
    expect(issues[0].ruleId).toBe('checkPositiveCoreStats')
  })

  it('检查器异常隔离：坏规则不影响其它规则', () => {
    const broken: SemanticCheckContext = {
      ...ctx,
      // 模拟 findCode 抛异常（checkLogicBooleanPrecedence 会崩）
      findCode: (k) => {
        if (k === 'canMove') throw new Error('boom')
        return CODES[k]
      },
    }
    const content = `[core]\nname: x\nmaxHp: -1\n`
    const issues = runSemanticChecks(content, { ctx: broken })
    expect(issues.length).toBeGreaterThanOrEqual(1)
    expect(issues.every((i) => i.ruleId !== 'checkLogicBooleanPrecedence')).toBe(true)
  })

  it('官方单位样例零误报（15 个检查器全开）', () => {
    const issues = runSemanticChecks(OFFICIAL_UNIT, { ctx })
    expect(issues).toEqual([])
  })

  it('dont_load: true 文件跳过全部检查（官方模板/槽位文件）', () => {
    const issues = runSemanticChecks(`[core]\ndont_load: true\nmaxHp: -5\nmoveSpeed: -3\n`, {
      ctx,
      ruleIds: new Set(['checkPositiveCoreStats', 'checkPositiveMovementSpeed', 'checkFile']),
    })
    expect(issues).toEqual([])
  })
})

describe('checkFile', () => {
  it('缺 [core] 报错', () => {
    const issues = runSemanticChecks(`[graphics]\nimage: a.png\n`, { ctx, ruleIds: new Set(['checkFile']) })
    expect(issues.some((i) => i.ruleId === 'checkFile' && i.severity === 'error' && i.message.includes('[core]'))).toBe(true)
  })

  it('有 core 缺 name 报错；name 含空格警告', () => {
    const issues = runSemanticChecks(`[core]\nmaxHp: 100\n`, { ctx, ruleIds: new Set(['checkFile']) })
    expect(issues.some((i) => i.message.includes('name'))).toBe(true)
    const issues2 = runSemanticChecks(`[core]\nname: my tank\n`, { ctx, ruleIds: new Set(['checkFile']) })
    expect(issues2.some((i) => i.severity === 'warning' && i.message.includes('空白'))).toBe(true)
  })

  it('非单位文件（mod-info）不报', () => {
    const issues = runSemanticChecks(`[mod]\ntitle: x\n`, { ctx, ruleIds: new Set(['checkFile']) })
    expect(issues).toEqual([])
  })
})

describe('checkPositiveCoreStats', () => {
  it('maxHp/mass ≤ 0 报错；price 负报错、0 放行', () => {
    const content = `[core]\nmaxHp: -5\nmass: 0\nprice: 0\n`
    const issues = runSemanticChecks(content, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    const msgs = issues.map((i) => i.message)
    expect(msgs.some((m) => m.includes('maxHp'))).toBe(true)
    expect(msgs.some((m) => m.includes('mass'))).toBe(true)
    expect(msgs.some((m) => m.includes('price'))).toBe(false)
  })

  it('非数字值报错（maxHp: 2500s）', () => {
    const issues = runSemanticChecks(`[core]\nmaxHp: 2500s\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(issues.some((i) => i.message.includes('不是数字'))).toBe(true)
  })
})

describe('checkPositiveMovementSpeed / checkPositiveRotateTurnSpeed', () => {
  it('moveSpeed 负报错、0 放行（官方过渡形态）；加速为负报错', () => {
    const issues = runSemanticChecks(`[movement]\nmoveSpeed: -1\nmoveAccelerationSpeed: -1\n`, {
      ctx,
      ruleIds: new Set(['checkPositiveMovementSpeed']),
    })
    expect(issues.length).toBe(2)
    const ok = runSemanticChecks(`[movement]\nmoveSpeed: 0\n`, { ctx, ruleIds: new Set(['checkPositiveMovementSpeed']) })
    expect(ok).toEqual([])
  })

  it('maxTurnSpeed 0 放行（官方合法）、负数报错', () => {
    const issues = runSemanticChecks(`[movement]\nmaxTurnSpeed: 0\n`, { ctx, ruleIds: new Set(['checkPositiveRotateTurnSpeed']) })
    expect(issues).toEqual([])
    const issues2 = runSemanticChecks(`[movement]\nmaxTurnSpeed: -2\n`, { ctx, ruleIds: new Set(['checkPositiveRotateTurnSpeed']) })
    expect(issues2[0].severity).toBe('error')
  })

  it('turretTurnSpeed 负报错', () => {
    const issues = runSemanticChecks(`[attack]\nturretTurnSpeed: -1\n`, { ctx, ruleIds: new Set(['checkPositiveRotateTurnSpeed']) })
    expect(issues.length).toBe(1)
  })
})

describe('checkProjectileLifecycle', () => {
  it('被引用的弹体缺 life 报错；未被引用（特效弹体）放行', () => {
    const issues = runSemanticChecks(`[turret_1]\nprojectile: myBolt\n[projectile_myBolt]\ndirectDamage: 10\n`, {
      ctx,
      ruleIds: new Set(['checkProjectileLifecycle']),
    })
    expect(issues.some((i) => i.message.includes('life'))).toBe(true)
    const effect = runSemanticChecks(`[projectile_explode]\nareaDamage: 450\n`, { ctx, ruleIds: new Set(['checkProjectileLifecycle']) })
    expect(effect).toEqual([])
  })

  it('life 为 0 放行（即时弹体）、负数报错', () => {
    const issues = runSemanticChecks(`[projectile_bullet]\nlife: 0\n`, { ctx, ruleIds: new Set(['checkProjectileLifecycle']) })
    expect(issues).toEqual([])
    const issues2 = runSemanticChecks(`[projectile_bullet]\nlife: -3\n`, { ctx, ruleIds: new Set(['checkProjectileLifecycle']) })
    expect(issues2.some((i) => i.message.includes('负数'))).toBe(true)
  })

  it('引用内置弹体（数字/白名单）放行；未定义弹体警告', () => {
    const ok = runSemanticChecks(`[turret_1]\nprojectile: 1\n`, { ctx, ruleIds: new Set(['checkProjectileLifecycle']) })
    expect(ok).toEqual([])
    const warn = runSemanticChecks(`[turret_1]\nprojectile: myCustomBolt\n`, { ctx, ruleIds: new Set(['checkProjectileLifecycle']) })
    expect(warn.some((i) => i.message.includes('myCustomBolt') && i.severity === 'warning')).toBe(true)
    const ok2 = runSemanticChecks(`[turret_1]\nprojectile: myCustomBolt\n[projectile_myCustomBolt]\nlife: 30\n`, {
      ctx,
      ruleIds: new Set(['checkProjectileLifecycle']),
    })
    expect(ok2).toEqual([])
  })
})

describe('checkProjectileRangeSemantics', () => {
  it('弹体 speed 负报错、0 放行；directDamage 负报错', () => {
    const issues = runSemanticChecks(`[projectile_bullet]\nspeed: -1\ndirectDamage: -5\n`, {
      ctx,
      ruleIds: new Set(['checkProjectileRangeSemantics']),
    })
    expect(issues.some((i) => i.message.includes('speed'))).toBe(true)
    expect(issues.some((i) => i.message.includes('directDamage'))).toBe(true)
    const ok = runSemanticChecks(`[projectile_bullet]\nspeed: 0\n`, { ctx, ruleIds: new Set(['checkProjectileRangeSemantics']) })
    expect(ok).toEqual([])
  })
})

describe('checkAttachmentPosition', () => {
  it('turret 与 attachment 的 x/y 非数字报错', () => {
    const issues = runSemanticChecks(`[turret_1]\nx: center\ny: 0\n[attachment_unitSlot1]\nx: -1\ny: up\n`, {
      ctx,
      ruleIds: new Set(['checkAttachmentPosition']),
    })
    expect(issues.length).toBe(2)
  })
})

describe('checkDrawLayerEnum', () => {
  it('合法绘制层放行；非法值报错', () => {
    for (const layer of DRAW_LAYERS) {
      const issues = runSemanticChecks(`[graphics]\ndrawLayer: ${layer}\n`, { ctx, ruleIds: new Set(['checkDrawLayerEnum']) })
      expect(issues).toEqual([])
    }
    const issues = runSemanticChecks(`[graphics]\ndrawLayer: skybox\n`, { ctx, ruleIds: new Set(['checkDrawLayerEnum']) })
    expect(issues.some((i) => i.message.includes('skybox'))).toBe(true)
  })
})

describe('checkGraphicsShadowOffset', () => {
  it('非数字偏移报错；只写一个偏移提示', () => {
    const issues = runSemanticChecks(`[graphics]\nshadowOffsetX: a\n`, { ctx, ruleIds: new Set(['checkGraphicsShadowOffset']) })
    expect(issues.some((i) => i.severity === 'error')).toBe(true)
    expect(issues.some((i) => i.severity === 'info' && i.message.includes('补齐'))).toBe(true)
  })
})

describe('checkLogicBooleanPrecedence', () => {
  it('括号不配对报错', () => {
    const issues = runSemanticChecks(`[core]\ncanMove: if( a and b )\n`, { ctx, ruleIds: new Set(['checkLogicBooleanPrecedence']) })
    expect(issues).toEqual([])
    const issues2 = runSemanticChecks(`[core]\ncanMove: if( a and b\n`, { ctx, ruleIds: new Set(['checkLogicBooleanPrecedence']) })
    expect(issues2.some((i) => i.message.includes('括号'))).toBe(true)
  })

  it('and/or 混用无括号警告', () => {
    const issues = runSemanticChecks(`[core]\ncanMove: if( a and b or c )\n`, { ctx, ruleIds: new Set(['checkLogicBooleanPrecedence']) })
    expect(issues.some((i) => i.message.includes('and 与 or'))).toBe(true)
  })

  it('非逻辑字段不检查', () => {
    const issues = runSemanticChecks(`[core]\nmaxHp: (100\n`, { ctx, ruleIds: new Set(['checkLogicBooleanPrecedence']) })
    expect(issues).toEqual([])
  })
})

describe('checkEventTimingSemantics', () => {
  it('动画时间负值/乱序检查', () => {
    const ok = runSemanticChecks(`[animation_idle]\nbody_0s: {frame:0}\nbody_0.8s: {frame:3}\n`, {
      ctx,
      ruleIds: new Set(['checkEventTimingSemantics']),
    })
    expect(ok).toEqual([])
    const issues = runSemanticChecks(`[animation_idle]\nbody_0.8s: {frame:3}\nbody_0.2s: {frame:1}\n`, {
      ctx,
      ruleIds: new Set(['checkEventTimingSemantics']),
    })
    expect(issues.some((i) => i.message.includes('跳帧'))).toBe(true)
  })
})

describe('checkResourceHudSemantics', () => {
  it('前导斜杠警告；.. 穿越报错', () => {
    const issues = runSemanticChecks(`[graphics]\nimage: /base3.png\nimage_wreak: ../shared/dead.png\n`, {
      ctx,
      ruleIds: new Set(['checkResourceHudSemantics']),
    })
    expect(issues.some((i) => i.severity === 'warning' && i.message.includes('斜杠'))).toBe(true)
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('..'))).toBe(true)
  })

  it('SHARED:/NONE/AUTO 放行', () => {
    const issues = runSemanticChecks(`[graphics]\nimage: SHARED:beam3.png\nimage_shadow: AUTO\nimage_turret: NONE\n`, {
      ctx,
      ruleIds: new Set(['checkResourceHudSemantics']),
    })
    expect(issues).toEqual([])
  })
})

describe('checkRiskyUnitReferenceSemantics', () => {
  it('引用项目外单位警告；无 unitNames 时跳过', () => {
    const issues = runSemanticChecks(`[core]\nbuiltFrom_1_name: ghostFactory\nname: x\n`, {
      ctx,
      ruleIds: new Set(['checkRiskyUnitReferenceSemantics']),
    })
    expect(issues.some((i) => i.message.includes('ghostFactory'))).toBe(true)
    const noCtx = runSemanticChecks(`[core]\nbuiltFrom_1_name: ghostFactory\n`, {
      ctx: { findCode: ctx.findCode },
      ruleIds: new Set(['checkRiskyUnitReferenceSemantics']),
    })
    expect(noCtx).toEqual([])
    const ok = runSemanticChecks(`[core]\nbuiltFrom_1_name: landFactory, myTank\n`, {
      ctx,
      ruleIds: new Set(['checkRiskyUnitReferenceSemantics']),
    })
    expect(ok).toEqual([])
  })
})

describe('checkActionReferences', () => {
  it('action 节名非法报错；convertTo 引用缺失警告', () => {
    const issues = runSemanticChecks(`[action_upgrade T2]\ntext: x\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
    expect(issues.some((i) => i.severity === 'error')).toBe(true)
    const issues2 = runSemanticChecks(`[action_upgradeT2]\nconvertTo: ghostUnit\n`, {
      ctx,
      ruleIds: new Set(['checkActionReferences']),
    })
    expect(issues2.some((i) => i.message.includes('ghostUnit'))).toBe(true)
    const ok = runSemanticChecks(`[action_upgradeT2]\nconvertTo: myTank\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
    expect(ok).toEqual([])
  })
})

describe('checkKeyTypos', () => {
  it('疑似拼写错误给出候选', () => {
    expect(findSimilarKey('maxHp', ['maxHp', 'mass', 'moveSpeed'])).toBe('maxHp')
    expect(findSimilarKey('moveSpec', ['moveSpeed', 'mass', 'x'])).toBe('moveSpeed')
    expect(findSimilarKey('zzzz', ['maxHp', 'mass'])).toBeUndefined()
  })

  it('未知键有相似候选时警告；宏字段跳过', () => {
    const issues = runSemanticChecks(`[core]\nmoveSpeeed: 1.0\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })
    expect(issues.some((i) => i.message.includes('moveSpeeed') && i.suggestion.includes('moveSpeed'))).toBe(true)
    const macro = runSemanticChecks(`[core]\nbuiltFrom_9_name: factory\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })
    expect(macro).toEqual([])
  })

  it('无候选的自定义键不报', () => {
    const issues = runSemanticChecks(`[core]\ncustomTag123: hello\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })
    expect(issues).toEqual([])
  })

  it('中文显示层回译后命中代码表不报', () => {
    const issues = runSemanticChecks(`[核心]\n名称: myUnit\n生命值: 100\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })
    expect(issues).toEqual([])
  })
})

describe('诊断转换', () => {
  it('lineStarts / lineNumberAtOffset 行号正确（含 CRLF）', () => {
    const content = 'a\r\nb\r\nc'
    const starts = semanticLineStarts(content)
    expect(lineNumberAtOffset(starts, 0)).toBe(1)
    expect(lineNumberAtOffset(starts, 4)).toBe(2)
    expect(lineNumberAtOffset(starts, 7)).toBe(3)
  })

  it('SemanticIssue → CodeMirror 诊断（行范围）', () => {
    const content = '[core]\nmaxHp: -1\nname: x\n'
    const issues = runSemanticChecks(content, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    const diags = semanticIssuesToDiagnostics(content, issues)
    expect(diags[0].from).toBe(content.indexOf('maxHp'))
    expect(diags[0].to).toBeGreaterThanOrEqual(diags[0].from)
    expect(diags[0].severity).toBe('error')
  })

  it('checkKeyTypos 检查器定义完整性', () => {
    expect(checkKeyTypos.title).toBeTruthy()
    expect(checkKeyTypos.description).toBeTruthy()
    expect(checkKeyTypos.defaultOn).toBe(true)
  })
})

describe('M10 首轮审查修复回归', () => {
  it('name 空值报错', () => {
    const issues = runSemanticChecks(`[core]\nname:\n`, { ctx, ruleIds: new Set(['checkFile']) })
    expect(issues.some((i) => i.message.includes('为空'))).toBe(true)
  })

  it('hiddenAction 节内 convertTo 引用检查生效', () => {
    const issues = runSemanticChecks(`[hiddenAction_autoSwitchBack]\nconvertTo: ghostUnit\n`, {
      ctx,
      ruleIds: new Set(['checkActionReferences']),
    })
    expect(issues.some((i) => i.message.includes('ghostUnit'))).toBe(true)
  })

  it('convertTo 引用缺失只报一次（risky 与 action 不重复）', () => {
    const issues = runSemanticChecks(`[action_upgradeT2]\nconvertTo: ghostUnit\n`, {
      ctx,
      ruleIds: new Set(['checkActionReferences', 'checkRiskyUnitReferenceSemantics']),
    })
    const count = issues.filter((i) => i.message.includes('ghostUnit')).length
    expect(count).toBe(1)
  })

  it('dont_load 大小写/行尾注释均跳过', () => {
    const issues = runSemanticChecks(`[core]\nDONT_LOAD: TRUE #模板文件\nmaxHp: -5\n`, {
      ctx,
      ruleIds: new Set(['checkPositiveCoreStats']),
    })
    expect(issues).toEqual([])
  })

  it('动画时间键支持 armN/legN 前缀与小数，按轴分组单调', () => {
    const ok = runSemanticChecks(`[animation_idle]\nleg1_0s: {x:0}\nleg2_0s: {x:0}\nleg1_3s: {x:10}\nleg2_0.5s: {x:5}\n`, {
      ctx,
      ruleIds: new Set(['checkEventTimingSemantics']),
    })
    expect(ok).toEqual([])
    const bad = runSemanticChecks(`[animation_idle]\nleg1_3s: {x:10}\nleg1_0.5s: {x:5}\n`, {
      ctx,
      ruleIds: new Set(['checkEventTimingSemantics']),
    })
    expect(bad.some((i) => i.message.includes('跳帧'))).toBe(true)
    const neg = runSemanticChecks(`[animation_idle]\nbody_-1s: {frame:0}\n`, { ctx, ruleIds: new Set(['checkEventTimingSemantics']) })
    expect(neg.some((i) => i.message.includes('非负'))).toBe(true)
  })

  it('动画键（body_0.2s）不触发键名拼写检查', () => {
    const issues = runSemanticChecks(`[animation_idle]\nbody_0.2s: {frame:1}\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })
    expect(issues).toEqual([])
  })
})
