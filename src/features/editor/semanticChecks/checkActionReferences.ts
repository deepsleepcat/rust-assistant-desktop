/**
 * action 引用完整性（checkActionReferences）：
 * 1) 文件内 [action_xxx] 节（技能/动作定义）的 convertTo 等引用键指向的
 *    单位必须存在（同 checkRiskyUnitReferenceSemantics 依赖 ctx.unitNames）；
 * 2) [core] 节如果出现 action_N_xxx 宏字段（内联 action 定义），检查其
 *    convertTo 引用同样存在。
 * 3) 纯文件内检查：action 节名（[action_xxx]）不允许为空/非法字符。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { BUILTIN_UNITS, issue, lowerUnitNames, parseIni, sectionEnName, toEnKey } from './helpers'

const SPECIAL_VALUES = new Set(['none', 'ignore', 'auto', 'this', 'self'])

export const checkActionReferences: SemanticChecker = {
  id: 'checkActionReferences',
  title: 'action 引用完整性',
  description: 'action 的 convertTo 引用必须存在；action 节名必须合法',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections, keyValues } = parseIni(content)
    const zhToEn = ctx?.zhToEn
    const unitNames = ctx?.unitNames

    // 1) action 节名合法性（[action_xxx]：节名不能为空、不能以数字结尾的无意义名）
    for (const sec of sections) {
      const lower = sectionEnName(sec, zhToEn)
      if (!lower.startsWith('action')) continue
      const name = lower.slice('action'.length)
      if (!name || !/^[a-z_][a-z0-9_]*$/i.test(name)) {
        issues.push(
          issue(
            sec.startLine,
            `action 节名「[${sec.name}]」不合法`,
            `用字母/数字/下划线命名（如 [action_upgradeT2]）`,
            'checkActionReferences',
            'error',
            `[${sec.name}]`,
          ),
        )
      }
    }

    // 2) convertTo 引用存在性（action 节内 + core 宏字段 action_N_convertTo）
    if (unitNames) {
      const known = lowerUnitNames(unitNames)
      for (const kv of keyValues) {
        const enKey = toEnKey(kv.key, zhToEn)
        const lower = enKey.toLowerCase()
        const isActionMacro = /^action_\d+_convertto$/.test(lower)
        const isPlainConvert = lower === 'convertto' && sections.some((s) => kv.line >= s.startLine && kv.line < s.endLine && sectionEnName(s, zhToEn).startsWith('action'))
        if (!isActionMacro && !isPlainConvert) continue
        for (const raw of kv.value.split(',')) {
          const ref = raw.trim()
          const lref = ref.toLowerCase()
          if (!ref || SPECIAL_VALUES.has(lref) || lref.startsWith('custom:')) continue
          if (!known.has(lref) && !BUILTIN_UNITS.has(lref)) {
            issues.push(
              issue(
                kv.line,
                `convertTo 引用的单位「${ref}」不在当前项目里`,
                `确认单位名拼写；引用的目标单位必须存在（缺失时升级静默失败）`,
                'checkActionReferences',
                'warning',
                ref,
              ),
            )
          }
        }
      }
    }
    return issues
  },
}
