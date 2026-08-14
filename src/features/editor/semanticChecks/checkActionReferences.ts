/**
 * action 引用完整性（checkActionReferences）：
 * 1) [action_xxx] / [hiddenAction_xxx] 节（技能/动作定义）的 convertTo 引用键
 *    指向的单位必须存在（同 checkRiskyUnitReferenceSemantics 依赖 ctx.unitNames）；
 * 2) [core] 节如果出现 action_N_xxx 宏字段（内联 action 定义），检查其
 *    convertTo 引用同样存在。
 * 3) 纯文件内检查：action 节名不允许为空/非法字符。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { BUILTIN_UNITS, issue, lowerUnitNames, getIni, sectionEnName, toEnKey } from './helpers'

const SPECIAL_VALUES = new Set(['none', 'ignore', 'auto', 'this', 'self'])

/** 节名是否 action 类（action_ / hiddenAction_ 前缀，官方 hiddenAction_autoSwitchBack 等） */
function isActionSection(lower: string): boolean {
  return lower.startsWith('action') || lower.startsWith('hiddenaction')
}

export const checkActionReferences: SemanticChecker = {
  id: 'checkActionReferences',
  title: 'action 引用完整性',
  description: 'action 的 convertTo 引用必须存在；action 节名必须合法',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    const { sections, keyValues } = getIni(ctx, content)
    const zhToEn = ctx?.zhToEn
    const unitNames = ctx?.unitNames

    // 1) action 节名合法性（[action_xxx] / [hiddenAction_xxx]：节名不能为空）
    for (const sec of sections) {
      const lower = sectionEnName(sec, zhToEn)
      if (!isActionSection(lower)) continue
      const name = lower.replace(/^(?:action|hiddenaction)/, '')
      // 数字后缀（官方 [action_1]）与普通命名均合法；只有空名/非法字符报错
      if (!name || (!/^[a-z_][a-z0-9_]*$/i.test(name) && !/^_\d+$/.test(name))) {
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
        const isPlainConvert =
          lower === 'convertto' && sections.some((s) => kv.line >= s.startLine && kv.line < s.endLine && isActionSection(sectionEnName(s, zhToEn)))
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
