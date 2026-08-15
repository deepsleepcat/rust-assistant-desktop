/**
 * 声明式自定义规则（M19 AI 用例 + M21 插件接口）测试：
 * - validateRuleSet：schema 校验（类型/边界/重复 id/正则可编译）
 * - runCustomRules：五种检查类型 + 节/键匹配 + 开关过滤 + 严重度
 * - runSemanticChecks 集成：自定义规则与内置规则同管线、可单独关闭
 * - loadProjectRuleSets：项目 rules/ 目录加载、错误收集、无目录降级
 */
import { describe, expect, it } from 'vitest'
import { validateRuleSet, runCustomRules, runCustomRulesOnText, type CustomRuleSet } from '../src/features/editor/semanticChecks/customRules'
import { runSemanticChecks } from '../src/features/editor/semanticChecks'
import { defaultSemanticCheckerConfig, enabledRuleIds, sanitizeCheckerConfig } from '../src/features/editor/semanticChecks/registry'
import { loadProjectRuleSets } from '../src/features/editor/semanticChecks/customRules'

const VALID_SET: CustomRuleSet = {
  formatVersion: 1,
  name: '测试规则集',
  rules: [
    {
      id: 'hp-range',
      title: '血量范围',
      description: 'maxHp 1~1000',
      section: 'core',
      key: 'maxHp',
      severity: 'error',
      check: { type: 'numeric-range', min: 1, max: 1000 },
    },
  ],
}

describe('validateRuleSet（schema 校验）', () => {
  it('合法规则集通过', () => {
    const v = validateRuleSet(VALID_SET)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.set.rules[0].severity).toBe('error')
      expect(v.set.rules[0].check.min).toBe(1)
    }
  })

  it('formatVersion/name/rules 缺失报错', () => {
    expect(validateRuleSet({ formatVersion: 2, name: 'x', rules: [] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: '', rules: [] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x' }).ok).toBe(false)
    expect(validateRuleSet(null).ok).toBe(false)
  })

  it('id 非法/重复报错', () => {
    const bad = validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a b', title: 't', check: { type: 'numeric-range', min: 1 } }] })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toContain('id')
    const dup = validateRuleSet({
      formatVersion: 1,
      name: 'x',
      rules: [
        { id: 'a', title: 't1', check: { type: 'numeric-range', min: 1 } },
        { id: 'a', title: 't2', check: { type: 'numeric-range', min: 1 } },
      ],
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.errors.some((e) => e.includes('重复'))).toBe(true)
  })

  it('severity/check.type 非法报错', () => {
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', severity: 'fatal', check: { type: 'numeric-range', min: 1 } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'run-script' } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't' }] }).ok).toBe(false)
  })

  it('numeric-range：min>max / 无边界 / 非数字报错', () => {
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'numeric-range', min: 5, max: 1 } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'numeric-range' } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'numeric-range', min: '1' } }] }).ok).toBe(false)
    // 只给一侧是合法的
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'numeric-range', min: 1 } }] }).ok).toBe(true)
  })

  it('required-key 必须带 key；values/pattern 校验', () => {
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'required-key' } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', key: 'name', check: { type: 'required-key' } }] }).ok).toBe(true)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'enum-value', values: [] } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'enum-value', values: ['a', 1] } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'regex-match', pattern: '[' } }] }).ok).toBe(false)
    expect(validateRuleSet({ formatVersion: 1, name: 'x', rules: [{ id: 'a', title: 't', check: { type: 'regex-match', pattern: '^\\d+$' } }] }).ok).toBe(true)
  })
})

const SAMPLE = '[core]\nname: 步枪兵\nmaxHp: 200\nprice: -5\n[attack]\nrange: 300\nmaxHp: 99999\n'
const SAMPLE_RULES = [
  {
    id: 'hp-range',
    title: '血量范围',
    key: 'maxHp',
    severity: 'error',
    check: { type: 'numeric-range', min: 1, max: 1000 },
  },
  {
    id: 'price-positive',
    title: '价格不能为负',
    section: 'core',
    key: 'price',
    severity: 'warning',
    check: { type: 'numeric-range', min: 0 },
  },
  {
    id: 'no-self',
    title: '禁用值测试',
    key: 'name',
    check: { type: 'forbidden-value', values: ['NONE', 'self'] },
  },
  {
    id: 'move-type',
    title: '移动类型枚举',
    key: 'moveType',
    check: { type: 'enum-value', values: ['land', 'hover', 'amphibious'] },
  },
  {
    id: 'suffix',
    title: '时间后缀',
    key: 'reloadTime',
    check: { type: 'regex-match', pattern: '\\d+(\\.\\d+)?s?' },
  },
  {
    id: 'need-name',
    title: '必须有名',
    section: 'core',
    key: 'name',
    check: { type: 'required-key' },
  },
]

describe('runCustomRules（执行）', () => {
  it('numeric-range：越界报错（不限节时全节判定）、负数下限、非数字跳过', () => {
    const issues = runCustomRules(SAMPLE, SAMPLE_RULES as never, undefined)
    // 不限节：core.maxHp=200 合法；attack.maxHp=99999 越上限 → 1 条（第 7 行）
    const hp = issues.filter((i) => i.ruleId === 'custom:hp-range')
    expect(hp.length).toBe(1)
    expect(hp[0].line).toBe(7)
    expect(hp[0].severity).toBe('error')
    expect(hp[0].evidence).toBe('99999')
    // price=-5 越下限 → 1 条（warning，节限 core，第 4 行）
    const price = issues.filter((i) => i.ruleId === 'custom:price-positive')
    expect(price.length).toBe(1)
    expect(price[0].severity).toBe('warning')
    expect(price[0].line).toBe(4)
  })

  it('forbidden-value / enum-value / regex-match', () => {
    const issues = runCustomRules(SAMPLE, SAMPLE_RULES as never, undefined)
    // name=步枪兵 不在禁用列表 → 0 条
    expect(issues.some((i) => i.ruleId === 'custom:no-self')).toBe(false)
    // 文件里没有 moveType/reloadTime 键 → 0 条
    expect(issues.some((i) => i.ruleId === 'custom:move-type')).toBe(false)
    expect(issues.some((i) => i.ruleId === 'custom:suffix')).toBe(false)
    // required-key：core 有 name → 通过
    expect(issues.some((i) => i.ruleId === 'custom:need-name')).toBe(false)

    const hit = runCustomRules('[core]\nname: NONE\nmoveType: flying\nreloadTime: 5x\n', SAMPLE_RULES as never, undefined)
    expect(hit.filter((i) => i.ruleId === 'custom:no-self').length).toBe(1)
    expect(hit.filter((i) => i.ruleId === 'custom:move-type').length).toBe(1)
    expect(hit.filter((i) => i.ruleId === 'custom:suffix').length).toBe(1)
  })

  it('required-key：缺键报错，错误行号为节起始行', () => {
    const issues = runCustomRules('[core]\nmaxHp: 10\n', SAMPLE_RULES as never, undefined)
    const need = issues.filter((i) => i.ruleId === 'custom:need-name')
    expect(need.length).toBe(1)
    expect(need[0].line).toBe(1)
    expect(need[0].message).toContain('缺少必需键')
  })

  it('节过滤：规则限 core 时只检查 core', () => {
    const issues = runCustomRules('[core]\nprice: -5\n[attack]\nprice: -5\n', SAMPLE_RULES as never, undefined)
    const price = issues.filter((i) => i.ruleId === 'custom:price-positive')
    expect(price.length).toBe(1)
    expect(price[0].line).toBe(2) // 只命中 core 的 price
  })

  it('中文键/中文节经词典回译匹配', () => {
    const zhToEn = (s: string) => ({ 血量: 'maxHp', 核心: 'core' })[s]
    const issues = runCustomRules('[核心]\n血量: 99999\n', SAMPLE_RULES as never, { zhToEn })
    const hp = issues.filter((i) => i.ruleId === 'custom:hp-range')
    expect(hp.length).toBe(1)
    expect(hp[0].line).toBe(2)
  })

  it('配置过滤：custom: 前缀显式 false 的规则不执行（默认全部执行）', () => {
    const issues = runCustomRules(SAMPLE, SAMPLE_RULES as never, undefined, { 'custom:price-positive': false })
    expect(issues.some((i) => i.ruleId === 'custom:price-positive')).toBe(false)
    expect(issues.some((i) => i.ruleId === 'custom:hp-range')).toBe(true)
    // 未提供配置 → 全部执行
    const all = runCustomRules(SAMPLE, SAMPLE_RULES as never, undefined)
    expect(all.some((i) => i.ruleId === 'custom:price-positive')).toBe(true)
  })

  it('无节内容时直接返回空（不误报）', () => {
    expect(runCustomRules('name: 无节内容\n', SAMPLE_RULES as never, undefined)).toEqual([])
  })
})

describe('runCustomRulesOnText / runSemanticChecks 集成', () => {
  it('试运行入口：独立文本直接出结果', () => {
    const set = { formatVersion: 1, name: 'x', rules: VALID_SET.rules }
    const issues = runCustomRulesOnText('[core]\nmaxHp: 9999\n', set)
    expect(issues.length).toBe(1)
  })

  it('runSemanticChecks 与内置检查器同管线执行自定义规则（默认开启）', () => {
    const issues = runSemanticChecks('[core]\nmaxHp: 99999\n', {
      customRules: VALID_SET.rules as never,
    })
    expect(issues.some((i) => i.ruleId === 'custom:hp-range')).toBe(true)
    // 显式关闭后不再执行
    const off = runSemanticChecks('[core]\nmaxHp: 99999\n', {
      customRules: VALID_SET.rules as never,
      customRuleConfig: { 'custom:hp-range': false },
    })
    expect(off.some((i) => i.ruleId === 'custom:hp-range')).toBe(false)
  })

  it('注册表：custom: 前缀开关保留且可关闭', () => {
    const config = sanitizeCheckerConfig({ 'custom:hp-range': false, 'custom:other': true, bogus: true })
    expect(config['custom:hp-range']).toBe(false)
    expect(config['custom:other']).toBe(true)
    expect(config.bogus).toBeUndefined()
    const ids = enabledRuleIds({ ...defaultSemanticCheckerConfig(), 'custom:hp-range': false, 'custom:on': true })
    expect(ids.has('custom:hp-range')).toBe(false)
    expect(ids.has('custom:on')).toBe(true)
    // 默认（未配置）→ custom 规则不自动启用
    expect(enabledRuleIds(defaultSemanticCheckerConfig()).has('custom:x')).toBe(false)
  })
})

describe('loadProjectRuleSets（项目 rules/ 目录加载）', () => {
  function fakeBridge(files: Record<string, string>) {
    return {
      project: {
        readDir: async (_root: string, dir: string) => {
          if (dir !== 'rules') throw new Error('目录不存在')
          return Object.keys(files).map((name) => ({ name, isDirectory: false }))
        },
        readFile: async (_root: string, file: string) => ({ content: files[file.replace(/^rules\//, '')] ?? '' }),
      },
    }
  }

  it('加载合法规则文件；损坏文件收集错误不影响其它文件', async () => {
    const bridge = fakeBridge({
      'good.json': JSON.stringify(VALID_SET),
      'bad.json': '{ "formatVersion": 1, "name": "x", "rules": [{ "id": "a b", "title": "t", "check": { "type": "numeric-range", "min": 1 } }] }',
      'broken.json': 'not json at all',
      'readme.md': '不是规则文件',
    })
    const r = await loadProjectRuleSets('/fake/root', bridge)
    expect(r.sets.length).toBe(1)
    expect(r.sets[0].file).toBe('rules/good.json')
    expect(r.sets[0].rules[0].id).toBe('hp-range')
    expect(r.errors.length).toBe(2)
    expect(r.errors.some((e) => e.file === 'rules/bad.json' && e.errors[0].includes('id'))).toBe(true)
    expect(r.errors.some((e) => e.file === 'rules/broken.json')).toBe(true)
    // readme.md 不是 .json → 忽略
    expect(r.errors.some((e) => e.file.includes('readme'))).toBe(false)
  })

  it('没有 rules/ 目录 → 空结果（不抛错）', async () => {
    const bridge = {
      project: {
        readDir: async () => {
          throw new Error('ENOENT')
        },
        readFile: async () => ({ content: '' }),
      },
    }
    const r = await loadProjectRuleSets('/fake/root', bridge)
    expect(r.sets).toEqual([])
    expect(r.errors).toEqual([])
  })
})
