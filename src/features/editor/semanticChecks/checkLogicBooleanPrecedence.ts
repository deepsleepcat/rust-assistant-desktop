/**
 * 逻辑布尔表达式优先级（checkLogicBooleanPrecedence）：
 * 逻辑布尔字段（logicBoolean 类型）的值中：
 * 1) 括号必须配对（不配对会导致表达式解析错误或优先级异常）；
 * 2) and/or 混用且无括号时提示用括号明确优先级（经典优先级陷阱）。
 */
import type { SemanticChecker, SemanticIssue } from './types'
import { issue, keyValuesInSection, parseIni, toEnKey } from './helpers'

/** 已知的逻辑布尔字段类型（代码表 type 含 logicBoolean / boolean 的键） */
function isLogicBooleanField(ctx: { findCode?: (k: string) => { type: string } | undefined } | undefined, enKey: string): boolean {
  const code = ctx?.findCode?.(enKey)
  if (!code) return false
  return code.type.split(',').some((t) => t.trim().toLowerCase() === 'logicboolean' || t.trim().toLowerCase() === 'boolean')
}

/** 括号计数（忽略字符串内的括号不做特殊处理——铁锈逻辑表达式无字符串字面量） */
function bracketDelta(value: string): number {
  let delta = 0
  for (const ch of value) {
    if (ch === '(') delta++
    else if (ch === ')') delta--
  }
  return delta
}

/** 剥离最外层 if(...) 括号（若有）：括号内再混用 and/or 才算歧义 */
function stripOuterParens(value: string): string {
  const trimmed = value.trim()
  const m = /^(?:if|如果)?\s*\((.*)\)\s*$/i.exec(trimmed)
  if (m) return m[1]
  return trimmed
}

export const checkLogicBooleanPrecedence: SemanticChecker = {
  id: 'checkLogicBooleanPrecedence',
  title: '逻辑布尔表达式优先级',
  description: '逻辑表达式括号必须配对；and/or 混用建议加括号明确优先级',
  defaultOn: true,
  check(content, ctx) {
    const issues: SemanticIssue[] = []
    if (!ctx?.findCode) return issues
    const { sections, keyValues } = parseIni(content)
    const zhToEn = ctx?.zhToEn
    for (const sec of sections) {
      for (const kv of keyValuesInSection(keyValues, sec)) {
        const enKey = toEnKey(kv.key, zhToEn)
        if (!isLogicBooleanField(ctx, enKey)) continue
        const value = kv.value
        if (!value) continue
        if (value.includes('${')) continue // 变量表达式，不检查
        const delta = bracketDelta(value)
        if (delta !== 0) {
          issues.push(
            issue(
              kv.line,
              `逻辑表达式括号不配对（${delta > 0 ? `多 ${delta} 个左括号` : `多 ${-delta} 个右括号`}），可能导致优先级错误`,
              `补齐括号（如 if( a and (b or c) )）`,
              'checkLogicBooleanPrecedence',
              'error',
              value,
            ),
          )
        } else {
          const inner = stripOuterParens(value)
          if (inner.includes(' and ') && inner.includes(' or ') && !inner.includes('(')) {
            issues.push(
              issue(
                kv.line,
                `逻辑表达式同时使用 and 与 or 且没有括号，优先级可能不符合预期`,
                `用括号明确优先级（如 if( a and (b or c) )）`,
                'checkLogicBooleanPrecedence',
                'warning',
                value,
              ),
            )
          }
        }
      }
    }
    return issues
  },
}
