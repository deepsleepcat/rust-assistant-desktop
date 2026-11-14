import { describe, expect, it } from 'vitest'
import { repairIniContent } from '../src/services/translationRepair'
import type { TranslationRepairDictionary } from '../src/services/translationRepair'

const dict: TranslationRepairDictionary = {
  sections: [
    { code: 'core', translate: '核心' },
    { code: 'graphics', translate: '图像' },
    { code: 'attack', translate: '攻击' },
    { code: 'movement', translate: '运动' },
    { code: 'turret', translate: '炮塔', needName: true },
    { code: 'projectile', translate: '抛射体', needName: true },
    { code: 'action', translate: '行动', needName: true },
    { code: 'hiddenAction', translate: '隐藏行动', needName: true },
    { code: 'effect', translate: '效果', needName: true },
  ],
  codes: [
    { code: 'invisible', translate: '隐藏图像', type: 'boolean' },
    { code: 'canAttackFlyingUnits', translate: '可攻击空中单位', type: 'logicBoolean' },
    { code: 'canAttackLandUnits', translate: '可攻击表面单位', type: 'logicBoolean' },
    { code: 'canAttackUnderwaterUnits', translate: '可攻击水下单位', type: 'logicBoolean' },
    { code: 'autoTrigger', translate: '自动触发', type: 'logicBoolean' },
    { code: 'name', translate: '名称', type: 'string' },
    { code: 'true', translate: '真', type: 'constant' },
    { code: 'false', translate: '假', type: 'constant' },
    { code: 'projectile', translate: '抛射体', type: 'string' },
  ],
  logicIdentifiers: new Map([['血量', 'hp']]),
}

describe('已翻译 INI 恢复器', () => {
  it('只恢复命名节前缀，保留自定义中文后缀与英文混合节', () => {
    const source = [
      '[隐藏行动_治疗友军]',
      '[行动_手榴弹]',
      '[炮塔_投掷手雷]',
      '[抛射体_高爆手雷]',
      '[效果_爆炸]',
      '[action_AK74]',
      'projectile:高爆手雷',
    ].join('\n')
    const result = repairIniContent(source, dict)
    expect(result.content).toBe([
      '[hiddenAction_治疗友军]',
      '[action_手榴弹]',
      '[turret_投掷手雷]',
      '[projectile_高爆手雷]',
      '[effect_爆炸]',
      '[action_AK74]',
      'projectile:高爆手雷',
    ].join('\n'))
    expect(result.changes).toHaveLength(5)
    expect(result.changes.every((change) => change.kind === 'section')).toBe(true)
  })

  it('修复截图中的混合键：只回译已知中文片段', () => {
    const mixedDict: TranslationRepairDictionary = {
      ...dict,
      codes: [
        ...dict.codes,
        { code: 'addWaypoint', translate: '添加路径点', type: 'action' },
        { code: 'type', translate: '类型', type: 'string' },
        { code: 'nearestUnit', translate: '接近单位', type: 'string' },
        { code: 'takeResources', translate: '提取资源', type: 'action' },
        { code: 'includeUnitsWithinRange', translate: '范围', type: 'float' },
        { code: 'excludeUnitsWithoutTags', translate: '排除标签', type: 'tags' },
      ],
    }
    const source = [
      'addWaypoint_类型:move',
      'addWaypoint_target_接近单位_tagged:伤员',
      '提取资源_includeUnitsWithinRange:150',
      '提取资源_excludeUnitsWithoutTags:弹药补给',
    ].join('\n')
    const result = repairIniContent(source, mixedDict)
    expect(result.content).toBe([
      'addWaypoint_type:move',
      'addWaypoint_target_nearestUnit_tagged:伤员',
      'takeResources_includeUnitsWithinRange:150',
      'takeResources_excludeUnitsWithoutTags:弹药补给',
    ].join('\n'))
    expect(result.changes.map((change) => change.kind)).toEqual(['key', 'key', 'key', 'key'])
  })

  it('恢复唯一字段译名和明确布尔值，普通中文内容保持不变', () => {
    const source = [
      '隐藏图像:真',
      '可攻击空中单位:假',
      '名称:亚洲分部医疗兵',
      'description:攻击力强',
      'text:真',
    ].join('\r\n')
    const result = repairIniContent(source, dict)
    expect(result.content).toBe([
      'invisible:true',
      'canAttackFlyingUnits:false',
      'name:亚洲分部医疗兵',
      'description:攻击力强',
      'text:真',
    ].join('\r\n'))
    expect(result.changes.map((change) => change.line)).toEqual([1, 2, 3])
    expect(result.changes.map((change) => change.kind)).toEqual(['boolean', 'boolean', 'key'])
  })

  it('保留 BOM 和不确定的中文节、键和值', () => {
    const source = '\uFEFF[自定义中文节]\r\n自定义键:真\r\nname:中文名'
    const result = repairIniContent(source, dict)
    expect(result.content).toBe(source)
    expect(result.changes).toEqual([])
  })
})

describe('真实问题单位回归（亚洲分部医疗兵）', () => {
  it('只恢复 23 处节名前缀，不触碰值区和注释中的中文', () => {
    const source = [
      '[隐藏行动_治疗友军]',
      'autoTrigger:true',
      'addWaypoint_type:repair',
      'addWaypoint_target_nearestUnit_tagged:伤员',
      '[隐藏行动_治疗友军2]',
      '[隐藏行动_我受伤了]',
      'autoTrigger:if self.血量(lessThan=120)',
      '[隐藏行动_我很好]',
      '[graphics]',
      '[attack]',
      'canAttackFlyingUnits:true',
      '[movement]',
      '[行动_弹药]',
      'text_zh:剩余弹匣 1弹药=1弹匣',
      'price:弹药=1',
      '[行动_空弹药]',
      '[行动_手榴弹]',
      '[行动_空手榴弹]',
      '[隐藏行动_人机补给弹药]',
      '[行动_装填2]',
      '[action_AK74]',
      '[炮塔_枪]',
      'canAttackFlyingUnits:true',
      '[炮塔_投掷手雷]',
      'invisible:true',
      'canAttackFlyingUnits:false',
      '[projectile_子弹]',
      '[projectile_高爆手雷]',
      '[炮塔_近战打击]',
      '[projectile_近击]',
      '[效果_闪光]',
      '[效果_开火]',
      '[效果_抛壳]',
      '[效果_冲击波]',
      '[效果_爆炸]',
      '[效果_烟雾]',
      '[action_cz]',
      '#淡出',
    ].join('\n')
    const result = repairIniContent(source, dict)
    // 19 个中文节名前缀（[graphics]/[attack]/[movement]/[action_AK74]/[action_cz] 已是英文不改）
    expect(result.changes.filter((c) => c.kind === 'section')).toHaveLength(19)
    // 值区的中文保留
    expect(result.content).toContain('addWaypoint_target_nearestUnit_tagged:伤员')
    expect(result.content).toContain('text_zh:剩余弹匣 1弹药=1弹匣')
    expect(result.content).toContain('price:弹药=1')
    expect(result.content).toContain('autoTrigger:if self.hp(lessThan=120)')
    // 注释保留
    expect(result.content).toContain('#淡出')
    // 英文混合节不变
    expect(result.content).toContain('[action_AK74]')
    expect(result.content).toContain('[action_cz]')
    // 截图中的字段已恢复
    expect(result.content).toContain('[turret_投掷手雷]')
    expect(result.content).toContain('invisible:true')
    expect(result.content).toContain('canAttackFlyingUnits:false')
  })

  it('只恢复已知 self 中文逻辑函数，未知 self 函数与普通中文值保持原样', () => {
    const source = [
      '[隐藏行动_测试]',
      'autoTrigger:if self.血量(lessThan=120)',
      'autoTrigger:if self.自定义函数(tag=伤员)',
      'description:血量不足时治疗伤员',
    ].join('\n')
    const result = repairIniContent(source, dict)
    expect(result.content).toContain('autoTrigger:if self.hp(lessThan=120)')
    expect(result.content).toContain('autoTrigger:if self.自定义函数(tag=伤员)')
    expect(result.content).toContain('description:血量不足时治疗伤员')
  })

  it('保留 CRLF 换行', () => {
    const source = '[隐藏行动_治疗友军]\r\nautoTrigger:true\r\n'
    const result = repairIniContent(source, dict)
    expect(result.content).toContain('\r\n')
    expect(result.content).not.toContain('[隐藏行动_')
    expect(result.content).toContain('[hiddenAction_治疗友军]')
  })
})
