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
  text: { type: 'string' },
  displayText: { type: 'string' },
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

  it('minimapIcon/icon 不是引擎键：不再产生资源路径问题；iconImage 真实键仍检查', () => {
    // 引擎无 minimapIcon/icon 键（小地图图标由引擎自动找 icon.png），前导斜杠/.. 不再检查
    const ghost = runSemanticChecks(`[graphics]\nicon: /base3.png\nminimapIcon: ../shared/icon.png\n`, {
      ctx,
      ruleIds: new Set(['checkResourceHudSemantics']),
    })
    expect(ghost).toEqual([])
    // 真实键 iconImage（原版单位在用）仍检查：前导斜杠照常警告
    const real = runSemanticChecks(`[graphics]\niconImage: /missing.png\n`, {
      ctx,
      ruleIds: new Set(['checkResourceHudSemantics']),
    })
    expect(real.some((i) => i.severity === 'warning' && i.message.includes('iconImage'))).toBe(true)
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

  it('requiredUnit 不是引擎键：不再作为单位引用检查；convertTo 仍正常检查', () => {
    // 引擎无 requiredUnit 键 → 值不检查存在性
    const ghost = runSemanticChecks(`[core]\nrequiredUnit: ghostFactory\nname: x\n`, {
      ctx,
      ruleIds: new Set(['checkRiskyUnitReferenceSemantics']),
    })
    expect(ghost).toEqual([])
    // 真实键 convertTo（非行动节）仍检查：引用缺失单位照常警告
    const real = runSemanticChecks(`[core]\nconvertTo: ghostFactory\nname: x\n`, {
      ctx,
      ruleIds: new Set(['checkRiskyUnitReferenceSemantics']),
    })
    expect(real.some((i) => i.message.includes('ghostFactory'))).toBe(true)
  })
})

describe('checkActionReferences', () => {
  it('action 节名引擎对齐：任意后缀合法（空格/标点/数字开头/小数点/罗马数字/中文）；convertTo 引用缺失警告', () => {
    // 引擎 ag.java:1903/1912：action_/hiddenAction_ 前缀节即行动，startsWith 判断、后缀无字符限制
    const okCases = [
      `[action_upgrade T2]\ntext: x\n`, // 空格后缀
      `[action_upgrade-T2]\ntext: x\n`, // 连字符
      `[action1]\ntext: x\n`, // 无下划线、数字开头——仍是合法节名（引擎仅按前缀识别行动节）
      `[action_1]\ntext: x\n`, // 官方形态
      `[action_]\ntext: x\n`, // 空后缀（引擎接受，空名行动）
      `[action回收]\ntext: x\n`, // 中文
      `[action_Ⅻ]\ntext: x\n`, // 罗马数字
      `[action_0.1]\ntext: x\n`, // 小数点（AbyssStars 真实用法）
      `[action_79框]\ntext: x\n`, // 数字开头（真实用法）
      `[hiddenAction_获取资金1.5]\ntext: x\n`, // 中文+数字+小数点（ASEU 真实用法）
      `[hiddenAction_tankCheck4.1]\ntext: x\n`,
    ]
    for (const c of okCases) {
      expect(runSemanticChecks(c, { ctx, ruleIds: new Set(['checkActionReferences']) })).toEqual([])
    }
    const issues2 = runSemanticChecks(`[action_upgradeT2]\nconvertTo: ghostUnit\n`, {
      ctx,
      ruleIds: new Set(['checkActionReferences']),
    })
    expect(issues2.some((i) => i.message.includes('ghostUnit'))).toBe(true)
    const ok = runSemanticChecks(`[action_upgradeT2]\nconvertTo: myTank\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
    expect(ok).toEqual([])
  })

  it('[action]/[hiddenAction] 缺 _ 前缀报疑似拼写警告（引擎不识别为行动节，节内键成为未使用键）', () => {
    const withKeys = runSemanticChecks(`[action]\ntext: x\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
    expect(withKeys.some((i) => i.message.includes('缺少 _ 前缀'))).toBe(true)
    expect(withKeys.every((i) => i.severity === 'warning')).toBe(true)
    const hidden = runSemanticChecks(`[hiddenAction]\ntext: x\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
    expect(hidden.some((i) => i.message.includes('缺少 _ 前缀'))).toBe(true)
    // 空节（无键）不打扰
    const empty = runSemanticChecks(`[action]\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
    expect(empty).toEqual([])
  })

  it('convertTo 引用支持引擎单位列表语法（*数量 剥除后匹配）', () => {
    const issues = runSemanticChecks(`[action_upgradeT2]\nconvertTo: ghostUnit*2\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
    expect(issues.some((i) => i.message.includes('ghostUnit'))).toBe(true)
    const ok = runSemanticChecks(`[action_upgradeT2]\nconvertTo: myTank*2\n`, { ctx, ruleIds: new Set(['checkActionReferences']) })
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

describe('checkVersionCompatibility（M11）', () => {
  const versionCtx: SemanticCheckContext = {
    ...ctx,
    findCode: (k) => {
      const map: Record<string, { type: string; addVersion?: number; removeVersion?: number }> = {
        maxHp: { type: 'int', addVersion: 1 },
        mass: { type: 'int', addVersion: 1 },
        oldField: { type: 'string', addVersion: 1, removeVersion: 4 },
        newField: { type: 'string', addVersion: 6 },
        plainField: { type: 'string' },
      }
      return map[k] ?? (map[Object.keys(map).find((c) => c.toLowerCase() === k.toLowerCase()) ?? ''] as never)
    },
    targetVersionNumber: 4, // 1.15
  }

  it('加入版本晚于目标版本 → 警告', () => {
    const issues = runSemanticChecks(`[core]\nnewField: x\nmaxHp: 100\n`, { ctx: versionCtx, ruleIds: new Set(['checkVersionCompatibility']) })
    expect(issues.some((i) => i.ruleId === 'checkVersionCompatibility' && i.message.includes('newField') && i.message.includes('6'))).toBe(true)
    expect(issues.some((i) => i.message.includes('maxHp'))).toBe(false)
  })

  it('目标版本跟随最新时不报过新字段', () => {
    const issues = runSemanticChecks(`[core]\nnewField: x\n`, {
      ctx: { ...versionCtx, targetVersionNumber: 9 },
      ruleIds: new Set(['checkVersionCompatibility']),
    })
    expect(issues).toEqual([])
  })

  it('已移除字段（removeVersion ≤ 目标）→ 警告', () => {
    const issues = runSemanticChecks(`[core]\noldField: x\n`, { ctx: versionCtx, ruleIds: new Set(['checkVersionCompatibility']) })
    expect(issues.some((i) => i.message.includes('oldField') && i.message.includes('移除'))).toBe(true)
  })

  it('无版本信息字段不报', () => {
    const issues = runSemanticChecks(`[core]\nplainField: x\n`, { ctx: versionCtx, ruleIds: new Set(['checkVersionCompatibility']) })
    expect(issues).toEqual([])
  })
})

describe('M28 真实模组对齐回归', () => {
  it('checkFile 对 .template 模板源文件不要求 [core]/name（引擎只加载 .ini，ag.java:3760）', () => {
    const tpl = `[core]\nmaxHp: 100\n` // 有 core 但无 name（模板合法形态）
    expect(runSemanticChecks(tpl, { ctx: { ...ctx, file: '模板/全局.template' }, ruleIds: new Set(['checkFile']) })).toEqual([])
    const tplNoCore = `[graphics]\nimage: a.png\n`
    expect(runSemanticChecks(tplNoCore, { ctx: { ...ctx, file: '模板/折跃.template' }, ruleIds: new Set(['checkFile']) })).toEqual([])
    // 同名内容在 .ini 下仍报缺 name
    const ini = runSemanticChecks(tpl, { ctx: { ...ctx, file: 'units/a.ini' }, ruleIds: new Set(['checkFile']) })
    expect(ini.some((i) => i.message.includes('缺少 name'))).toBe(true)
  })

  it('checkPositiveCoreStats：0 降级 warning；负数 error；price 多资源（含 : 分隔）合法', () => {
    const zero = runSemanticChecks(`[core]\nmaxHp: 0\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(zero.every((i) => i.severity === 'warning')).toBe(true)
    expect(zero.some((i) => i.message.includes('为 0'))).toBe(true)
    const negative = runSemanticChecks(`[core]\nmaxHp: -5\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(negative.some((i) => i.severity === 'error')).toBe(true)
    const priceMulti = runSemanticChecks(`[core]\nprice: 50000,矿=1000,聚能:500\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(priceMulti).toEqual([]) // 真实模组 2级侦察船.ini
    const priceBad = runSemanticChecks(`[core]\nprice: 矿=abc\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(priceBad.some((i) => i.severity === 'error')).toBe(true)
  })

  it('单位引用值支持引擎语法：单位名(参数) 与 *数量（ci.java:55-80），括号内逗号不分段', () => {
    const issues = runSemanticChecks(
      `[core]\nname: x\nspawnUnits: 开馈赠(spawnChance=0.2,maxSpawnLimit=1),多的矿(spawnChance=0.6),myTank*2,ghostUnit\n`,
      { ctx, ruleIds: new Set(['checkRiskyUnitReferenceSemantics']) },
    )
    const warned = issues.map((i) => i.message)
    // 括号参数段内的逗号不误拆成单位名（旧 bug：把 maxSpawnLimit=1) 当引用）
    expect(warned.some((m) => m.includes('maxSpawnLimit'))).toBe(false)
    expect(warned.some((m) => m.includes('spawnChance'))).toBe(false)
    // 开馈赠/多的矿 不在项目里 → 正常警告；myTank 存在 → 不报；ghostUnit 不存在 → 警告
    expect(warned.some((m) => m.includes('开馈赠'))).toBe(true)
    expect(warned.some((m) => m.includes('多的矿'))).toBe(true)
    expect(warned.some((m) => m.includes('myTank'))).toBe(false)
    expect(warned.some((m) => m.includes('ghostUnit'))).toBe(true)
  })

  it('弹体 life 支持时间后缀 s（引擎 time 读取）；跨文件弹体引用放行（ctx.projectProjectiles）', () => {
    const ok = runSemanticChecks(`[projectile_锁定]\nlife: 0.2s\n`, { ctx, ruleIds: new Set(['checkProjectileLifecycle']) })
    expect(ok).toEqual([])
    const crossFile = runSemanticChecks(`[turret_1]\nprojectile: 锁定\n`, {
      ctx: { ...ctx, projectProjectiles: new Set(['锁定']) },
      ruleIds: new Set(['checkProjectileLifecycle']),
    })
    expect(crossFile).toEqual([])
    const stillMissing = runSemanticChecks(`[turret_1]\nprojectile: 不存在弹体\n`, {
      ctx: { ...ctx, projectProjectiles: new Set(['锁定']) },
      ruleIds: new Set(['checkProjectileLifecycle']),
    })
    expect(stillMissing.some((i) => i.message.includes('不存在弹体'))).toBe(true)
  })

  it('parseUnitListValue 括号感知：参数段内逗号/嵌套调用不误拆', async () => {
    const { parseUnitListValue } = await import('../src/features/editor/semanticChecks/helpers')
    expect(parseUnitListValue('开馈赠(spawnChance=0.2,maxSpawnLimit=1),多的矿(spawnChance=0.6)')).toEqual(['开馈赠', '多的矿'])
    expect(parseUnitListValue('原生-兵卵*1(spawnChance=0.1),myTank*2')).toEqual(['原生-兵卵', 'myTank'])
    expect(parseUnitListValue('中立视野副本(spawnSource=createMarker(x=self.x(), y=self.y()))')).toEqual(['中立视野副本'])
  })
})

describe('M28 审查修正回归（语义检查器）', () => {
  it('checkPositiveCoreStats：price 支持竖线分隔（引擎 d.b.a 按 , 或 | 分段）', () => {
    const ok = runSemanticChecks(`[core]\nprice: 500|100\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(ok).toEqual([])
    const ok2 = runSemanticChecks(`[core]\nprice: 20,矿=500|100\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(ok2).toEqual([])
    const bad = runSemanticChecks(`[core]\nprice: 500|abc\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(bad.some((i) => i.severity === 'error')).toBe(true)
  })

  it('checkRiskyUnitReferenceSemantics：[action回收]（无 _ 前缀）不是行动节，convertTo 照常检查', () => {
    const issues = runSemanticChecks(`[action回收]\nconvertTo: ghostUnit\n`, { ctx, ruleIds: new Set(['checkRiskyUnitReferenceSemantics']) })
    expect(issues.some((i) => i.message.includes('ghostUnit'))).toBe(true)
    // 真正的行动节（action_ 前缀）仍由 checkActionReferences 负责，这里跳过
    const inAction = runSemanticChecks(`[action_upgrade]\nconvertTo: ghostUnit\n`, { ctx, ruleIds: new Set(['checkRiskyUnitReferenceSemantics']) })
    expect(inAction).toEqual([])
  })

  it('checkKeyTypos：语言后缀键剥后缀查基础名（displayTex_en 报、text_en 不报）', () => {
    const typo = runSemanticChecks(`[core]\ndisplayTex_en: x\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })
    expect(typo.some((i) => i.suggestion.includes('displayText'))).toBe(true)
    // text/displayText 基础名在代码表 → 合法
    expect(runSemanticChecks(`[core]\ntext_en: x\ndisplayText_en: x\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })).toEqual([])
    // 普通自定义键（无相似候选）不报
    expect(runSemanticChecks(`[core]\nmyCustomKey_en: x\n`, { ctx, ruleIds: new Set(['checkKeyTypos']) })).toEqual([])
  })

  it('三引号多行字符串：串内 key: value 行不进入语义检查器', () => {
    const content = `[core]\nname: x\nmaxHp: 100\ntext: """\nmaxHp: abc\nspeed: bogus\n"""\n`
    const issues = runSemanticChecks(content, { ctx, ruleIds: new Set(['checkPositiveCoreStats', 'checkFile']) })
    expect(issues).toEqual([])
    // 串外同样的错误仍报
    const outside = runSemanticChecks(`[core]\nname: x\nmaxHp: abc\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(outside.some((i) => i.severity === 'error')).toBe(true)
  })

  it('三引号同行开闭（text: """x"""）不吞掉后续行', () => {
    const content = `[core]\nname: x\ntext: """单行"""\nmaxHp: abc\n`
    const issues = runSemanticChecks(content, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    // 只有串外的 maxHp 报错；text 行不进入多行串状态
    expect(issues.some((i) => i.message.includes('maxHp'))).toBe(true)
    expect(issues.some((i) => i.line === 3)).toBe(false)
  })

  it('checkPositiveCoreStats：单段资源价格合法（price: 矿=500）；多段/单段负数价格都报错', () => {
    // 单段资源形式（引擎资源解析器对单段同样接受）→ 不误报「不是数字」
    expect(runSemanticChecks(`[core]\nprice: 矿=500\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })).toEqual([])
    // 多段中负数段报错（旧实现整段放过）
    const multiNeg = runSemanticChecks(`[core]\nprice: -5,矿=100\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(multiNeg.some((i) => i.severity === 'error' && i.message.includes('负'))).toBe(true)
    // 资源名=负数 段报错
    const resNeg = runSemanticChecks(`[core]\nprice: 矿=-5\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(resNeg.some((i) => i.severity === 'error' && i.message.includes('负'))).toBe(true)
    // 单段纯负数仍报错
    const plainNeg = runSemanticChecks(`[core]\nprice: -5\n`, { ctx, ruleIds: new Set(['checkPositiveCoreStats']) })
    expect(plainNeg.some((i) => i.severity === 'error')).toBe(true)
  })

  it('CUSTOM: 跨模组单位引用不查存在性（parseUnitListValue 保留前缀，跳过分支生效）', async () => {
    const { parseUnitListValue } = await import('../src/features/editor/semanticChecks/helpers')
    expect(parseUnitListValue('CUSTOM:otherMod*2')).toEqual(['CUSTOM:otherMod'])
    const issues = runSemanticChecks(`[core]\nname: x\nconvertTo: CUSTOM:otherMod\nspawnUnit: CUSTOM:ghost*3\n`, {
      ctx,
      ruleIds: new Set(['checkRiskyUnitReferenceSemantics']),
    })
    expect(issues).toEqual([])
    // 非 CUSTOM 引用照常警告
    const plain = runSemanticChecks(`[core]\nname: x\nspawnUnits: ghostUnit\n`, { ctx, ruleIds: new Set(['checkRiskyUnitReferenceSemantics']) })
    expect(plain.some((i) => i.message.includes('ghostUnit'))).toBe(true)
  })
})
