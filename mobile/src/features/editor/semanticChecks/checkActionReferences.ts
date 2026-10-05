/**
 * action 引用完整性（checkActionReferences）：
 * 1) [action_xxx] / [hiddenAction_xxx] 节（技能/动作定义）的 convertTo 引用键
 *    指向的单位必须存在（同 checkRiskyUnitReferenceSemantics 依赖 ctx.unitNames）；
 * 2) [core] 节如果出现 action_N_xxx 宏字段（内联 action 定义），检查其
 *    convertTo 引用同样存在。
 * 3) 节名规则与引擎对齐（ae.java/ag.java：节名 = \s*\[([^]]*)\]\s*，无字符集
 *    限制；action_/hiddenAction_ 前缀节即行动，startsWith 判断、后缀任意——
 *    中文/数字开头/小数点/空格全合法，社区模组有 [hiddenAction_获取资金1.5]、
 *    [action_0.1] 等先例）。「[action]」缺下划线前缀不是行动节（引擎按未知节
 *    处理），报疑似拼写警告。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { BUILTIN_UNITS, issue, lowerUnitNames, getIni, parseUnitListValue, sectionEnName, toEnKey } from './helpers'

const SPECIAL_VALUES = new Set(['none', 'ignore', 'auto', 'this', 'self'])

/** 节名是否行动节（引擎 ag.java:1903/1912：前缀 action_ / hiddenAction_ 精确 startsWith） */
function isActionSection(lower: string): boolean {
  return lower.startsWith('action_') || lower.startsWith('hiddenaction_')
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

    // 1) 疑似行动节名（[action] / [hiddenAction]，缺 _ 前缀）：
    //    引擎里这不是行动节（startsWith "action_" 不匹配），节内键会全部成为
    //    未使用键（引擎报错）——提示用户补 _ 前缀。空节（无键）不打扰。
    for (const sec of sections) {
      const lower = sectionEnName(sec, zhToEn)
      if (lower !== 'action' && lower !== 'hiddenaction') continue
      if (sec.kvs.length === 0) continue
      issues.push(
        issue(
          sec.startLine,
          `「[${sec.name}]」疑似行动节但缺少 _ 前缀（引擎不会把它当行动）`,
          `改名加下划线（如 [action_xxx]、[hiddenAction_xxx]），否则节内键不被引擎读取`,
          'checkActionReferences',
          'warning',
          `[${sec.name}]`,
        ),
      )
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
        // 值支持引擎单位列表语法（单位名*数量 / 单位名(参数)），剥参数后匹配
        for (const ref of parseUnitListValue(kv.value)) {
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
