/**
 * 危险单位引用（checkRiskyUnitReferenceSemantics）：
 * builtFrom_N_name / convertTo / spawnUnit 等引用其他单位的键，
 * 值必须在本项目（ctx.unitNames）或游戏内置特殊值（None/IGNORE/AUTO）中存在。
 * 引用不存在的单位 → 该单位永远无法被建造/升级，属于静默失效。
 * 仅在 ctx.unitNames 提供时生效（编辑器波浪线无项目数据时跳过，写后质检/全量检查会传入）。
 * 注：引擎没有 requiredUnit 键（原版单位未用），不纳入引用检查。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { BUILTIN_UNITS, issue, lowerUnitNames, getIni, parseUnitListValue, sectionEnName, toEnKey } from './helpers'

/** 引用单位的键（小写；宏字段 builtFrom_N_name 单独匹配） */
const UNIT_REF_KEYS = new Set(['convertto', 'spawnunit', 'spawnunits'])
/** 游戏特殊值：不检查存在性 */
const SPECIAL_VALUES = new Set(['none', 'ignore', 'auto', 'this', 'self'])

export const checkRiskyUnitReferenceSemantics: SemanticChecker = {
  id: 'checkRiskyUnitReferenceSemantics',
  title: '危险单位引用',
  description: 'builtFrom/convertTo 等引用的单位必须存在（项目内或游戏内置），否则静默失效',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const unitNames = ctx?.unitNames
    if (!unitNames) return issues // 无项目数据：跳过引用检查
    const known = lowerUnitNames(unitNames)
    const { sections, keyValues } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    for (const kv of keyValues) {
      const enKey = toEnKey(kv.key, zhToEn)
      const lower = enKey.toLowerCase()
      const isBuiltFrom = /^builtfrom_\d+_name$/.test(lower)
      if (!isBuiltFrom && !UNIT_REF_KEYS.has(lower)) continue
      // action 节内的 convertTo 由 checkActionReferences 检查，这里跳过避免重复报
      // （行动节判定与 checkActionReferences 对齐：引擎 ag.java:1903/1912 只认
      // action_/hiddenAction_ 前缀，[action1]/[action回收] 不是行动节）
      if (lower === 'convertto') {
        const inAction = sections.some(
          (s) =>
            kv.line >= s.startLine &&
            kv.line < s.endLine &&
            (sectionEnName(s, zhToEn).startsWith('action_') || sectionEnName(s, zhToEn).startsWith('hiddenaction_')),
        )
        if (inAction) continue
      }
      // 值支持引擎单位列表语法（spawnUnits: 单位名*数量(参数=值,...)，
      // ci.java:59/78 的 * 与括号参数段），剥语法后逐个匹配
      for (const ref of parseUnitListValue(kv.value)) {
        const lref = ref.toLowerCase()
        if (SPECIAL_VALUES.has(lref) || lref.startsWith('custom:')) continue
        // 项目内单位或游戏内置单位（大小写不敏感）→ 放行
        if (known.has(lref) || BUILTIN_UNITS.has(lref)) continue
        issues.push(
          issue(
            kv.line,
            `引用的单位「${ref}」不在当前项目里`,
            `确认单位名拼写；若引用其他模组/游戏内置单位，打包到游戏后需保证该单位存在`,
            'checkRiskyUnitReferenceSemantics',
            'warning',
            ref,
          ),
        )
      }
    }
    return issues
  },
}
