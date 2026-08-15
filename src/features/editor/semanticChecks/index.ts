/**
 * 语义检查器统一入口（runSemanticChecks）：
 * 按配置过滤后的规则串行执行，输出统一格式 SemanticIssue
 * （文件 + 行号 + 原因 + 修复建议 + 证据）。
 * 单个检查器抛异常时跳过该检查器，不影响其它规则（检查器之间隔离）。
 *
 * 用途：
 * - 编辑器波浪线（转成 CodeMirror 诊断）；
 * - AI 写文件后自动质检（转成 AiLintItem 清单展示在对话区）；
 * - 手动全量检查（项目质量报告）。
 */
import type { SemanticCheckContext, SemanticIssue, SemanticCheckOptions } from './types'
import { ALL_SEMANTIC_CHECKERS, enabledRuleIds } from './registry'
import { parseIni } from './helpers'
import { runCustomRules } from './customRules'

export type { SemanticChecker, SemanticCheckContext, SemanticIssue, SemanticCheckOptions } from './types'
export type { CustomRule, CustomRuleSet, ProjectRuleSet, ProjectRuleLoadResult, CustomCheckType } from './customRules'
export { validateRuleSet, runCustomRules, runCustomRulesOnText, loadProjectRuleSets } from './customRules'

/** 运行启用的语义检查器（ruleIds 缺省 = 全部启用；异常检查器隔离）。
 * dont_load: true 的文件（官方模板/槽位文件标记不加载）跳过全部检查。
 * 解析只做一次，经 ctx.parsed 共享给全部检查器（15 个检查器 × 全文扫描
 * 是 O(16n)，共享后是 O(n) + 各检查器 O(n)）。 */
export function runSemanticChecks(content: string, options: SemanticCheckOptions = {}): SemanticIssue[] {
  const ruleIds = options.ruleIds ?? enabledRuleIds({})
  const issues: SemanticIssue[] = []
  // 官方「不加载」标记（模板/槽位文件）：检查结果无意义，整体跳过
  // （i 标志 + 容忍行尾注释：DONT_LOAD: TRUE #模板 同样命中）
  if (/^\s*dont_load\s*:\s*(?:true|1|真)\s*(?:[ \t]+#.*)?$/im.test(content)) return issues
  // 共享解析结果（检查器用 getIni(ctx, content) 取，不再各自重扫全文）
  const ctx: SemanticCheckContext = { ...options.ctx, parsed: parseIni(content) }
  for (const checker of ALL_SEMANTIC_CHECKERS) {
    if (!ruleIds.has(checker.id)) continue
    try {
      issues.push(...checker.check(content, ctx))
    } catch (err) {
      // 检查器内部异常不中断整体检查（数据边界防御：畸形内容不应让所有检查失效）
      console.warn(`[semanticChecks] 检查器 ${checker.id} 执行失败，已跳过`, err)
    }
  }
  // M19/M21：项目自定义规则（声明式；单个规则异常同样隔离，不中断其它规则。
  // 自定义规则默认开启，设置里显式关闭后跳过）
  if (options.customRules && options.customRules.length > 0) {
    try {
      issues.push(...runCustomRules(content, options.customRules, ctx, options.customRuleConfig))
    } catch (err) {
      console.warn('[semanticChecks] 自定义规则执行失败，已跳过', err)
    }
  }
  return issues
}

/** 行起始偏移表（CodeMirror 诊断与质检清单共用；单趟 O(n)） */
export function semanticLineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 偏移量 → 行号（1 基；二分查找） */
export function lineNumberAtOffset(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** SemanticIssue → CodeMirror 诊断（整行范围，波浪线标在行上） */
export function semanticIssuesToDiagnostics(
  content: string,
  issues: SemanticIssue[],
): Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' | 'info' }> {
  const starts = semanticLineStarts(content)
  return issues.map((it) => {
    const lineIdx = it.line - 1
    const from = lineIdx >= 0 && lineIdx < starts.length ? starts[lineIdx] : 0
    const lineEnd = lineIdx + 1 < starts.length ? starts[lineIdx + 1] - 1 : content.length
    return { from, to: Math.max(from, lineEnd), message: it.message, severity: it.severity }
  })
}
