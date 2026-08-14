/**
 * AI 修改后自动质检（任务 3 + M10 语义升级）：
 * writeFile 成功后，读取刚写入的文件跑一遍现有 rustLint + M10 语义检查器，
 * 把诊断转成「文件 + 行号 + 原因 + 修复建议 + 证据」的可操作清单，
 * 展示在对话工具卡片里。
 *
 * 设计：lint 数据层（代码表/值类型/词典）只在渲染层加载过，质检也放在渲染层
 * （工具结束事件到达时触发）；lint 与撤销/历史完全独立——质检发现问题不影响撤销。
 * 性能：行号用单趟预计算的起始偏移表 O(1) 查（诊断可能数千条，逐条重扫是 O(n²)）；
 * 清单上限 200 条，其余折叠为一条汇总（UI 一次性渲染数万条会卡死）。
 */
import type { AiLintItem } from '../../types/ai'
import { lintIniText } from '../editor/rustLint'
import { findCodeByCode, findValueType, getAllCodes, getZhToEnDict, loadCodeData } from '../../services/codeData'
import { runSemanticChecks } from '../editor/semanticChecks'
import { defaultSemanticCheckerConfig, enabledRuleIds } from '../editor/semanticChecks/registry'

/** 清单上限：超出后折叠为汇总条目（防大文件产生数万条诊断拖垮渲染） */
const MAX_LINT_ITEMS = 200
/** 超过此体积的文件跳过质检（lint 是单趟 O(n)，超大文件在渲染线程跑会卡界面） */
const MAX_LINT_FILE_CHARS = 5 * 1024 * 1024

/**
 * 项目内绝对路径拼接（渲染层无 node:path）：
 * AI 工具给的 relPath 是相对写法（units/rifle.ini），而 bridge 的 fs 通道要求
 * 绝对路径（按主进程 CWD 解析相对路径会与项目根无关，必然「超出项目目录范围」）。
 * Windows-only 应用：统一正斜杠拼接（Node fs 兼容），与主进程 requireRealInsideRoot 一致。
 */
export function joinProjectPath(rootPath: string, relPath: string): string {
  const root = rootPath.replace(/[\\/]+$/, '')
  const rel = relPath.replace(/^\/+/, '').replace(/\\/g, '/').replace(/^\.\//, '')
  // 拒绝盘符写法（C:/x）：拼接后词法上会落在根内但物理上不存在（Windows 文件名
  // 不允许 :），只读通道靠 ENOENT 兜底；显式拒绝更干净，防未来被复用于写通道
  if (rel.includes(':')) throw new Error('无效的文件路径')
  return `${root}/${rel}`
}

/** 每行起始偏移表（单趟构建，行号查询 O(1)） */
export function lineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 偏移量 → 行号（从 1 起；二分查找起始偏移表） */
export function lineNumberAt(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 按诊断类型给出可执行的修复建议（纯函数，供测试） */
export function suggestionFor(message: string): string {
  if (message.includes('不符合类型')) {
    return '对照编辑器右上角「代码表」修正该键的值，或让 AI 按值类型规则重写这一行'
  }
  if (message.includes('不在任何')) {
    return '把该行移入 [节] 内，或删除此行'
  }
  return '检查该行格式是否符合铁锈战争 .ini 规范'
}

/** lint 诊断 → 可操作清单（纯函数，供测试）；超过上限时折叠为汇总条目（line=0，UI 不显示行号/定位） */
export function toLintItems(
  content: string,
  diagnostics: Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' }>,
): AiLintItem[] {
  const starts = lineStarts(content)
  const items: AiLintItem[] = diagnostics.slice(0, MAX_LINT_ITEMS).map((d) => ({
    line: lineNumberAt(starts, d.from),
    message: d.message,
    severity: d.severity,
    suggestion: suggestionFor(d.message),
  }))
  if (diagnostics.length > MAX_LINT_ITEMS) {
    const rest = diagnostics.length - MAX_LINT_ITEMS
    const errors = diagnostics.slice(MAX_LINT_ITEMS).filter((d) => d.severity === 'error').length
    items.push({
      line: 0,
      message: `…其余 ${rest} 条问题未列出${errors > 0 ? `（其中 ${errors} 个错误）` : ''}，建议先修复上面的问题后重新让 AI 检查`,
      severity: 'warning',
      suggestion: '',
    })
  }
  return items
}

/** 质检选项：语义检查器配置与项目单位名（引用完整性检查用） */
export interface QualityCheckOptions {
  semanticCheckers?: Record<string, boolean>
  unitNames?: ReadonlySet<string>
}

/**
 * 质检核心（纯函数，供测试与 checkAiWrittenFile 共用）：
 * 基础 lint + M10 语义检查器合并为统一清单。
 */
export async function qualityCheckContent(content: string, options: QualityCheckOptions = {}): Promise<AiLintItem[]> {
  if (content.length > MAX_LINT_FILE_CHARS) return []
  await loadCodeData()
  const zhToEnDict = getZhToEnDict()
  const data = {
    findCode: (k: string) => findCodeByCode(k),
    findType: (t: string) => findValueType(t),
    zhToEn: (k: string) => zhToEnDict.get(k),
  }
  const diagnostics = lintIniText(content, data)
  const items = toLintItems(content, diagnostics)

  // M10：语义检查器（与编辑器波浪线同一套规则；info 降级为 warning 展示）。
  // 语义条目与基础 lint 合并后统一截断（基础 lint 已按 200 上限折叠，
  // 语义条目直接追加会让大文件绕过上限 → UI 渲染数万条卡死）
  const ruleIds = enabledRuleIds(options.semanticCheckers ?? defaultSemanticCheckerConfig())
  const issues = runSemanticChecks(content, {
    ruleIds,
    ctx: { ...data, codes: getAllCodes().map((c) => c.code), unitNames: options.unitNames },
  })
  const semanticItems: AiLintItem[] = issues.map((it) => ({
    line: it.line,
    message: it.message,
    severity: it.severity === 'error' ? 'error' : 'warning',
    suggestion: it.suggestion,
    ruleId: it.ruleId,
    evidence: it.evidence,
  }))
  const merged = [...items, ...semanticItems]
  if (merged.length > MAX_LINT_ITEMS) {
    const rest = merged.length - MAX_LINT_ITEMS
    const errors = merged.slice(MAX_LINT_ITEMS).filter((i) => i.severity === 'error').length
    merged.length = MAX_LINT_ITEMS
    merged.push({
      line: 0,
      message: `…其余 ${rest} 条问题未列出${errors > 0 ? `（其中 ${errors} 个错误）` : ''}，建议先修复上面的问题后重新让 AI 检查`,
      severity: 'warning',
      suggestion: '',
    })
  }
  return merged
}

/**
 * AI 写文件后自动质检：读取刚写入的文件并跑一遍 rustLint + 语义检查器。
 * 返回 null 表示无法检查（非 ini/读取失败/文件过大）；空数组表示无问题。
 */
export async function checkAiWrittenFile(
  rootPath: string,
  relPath: string,
  options: QualityCheckOptions = {},
): Promise<AiLintItem[] | null> {
  if (!/\.(ini|template)$/i.test(relPath)) return null
  try {
    const { getBridge } = await import('../../services/bridge')
    // relPath 是 AI 的相对写法：必须拼成项目内绝对路径再走 fs 通道（见 joinProjectPath）
    const { content } = await getBridge().project.readFile(rootPath, joinProjectPath(rootPath, relPath))
    return qualityCheckContent(content, options)
  } catch {
    // 文件被删/读取失败等：跳过质检，不影响对话与撤销
    return null
  }
}
