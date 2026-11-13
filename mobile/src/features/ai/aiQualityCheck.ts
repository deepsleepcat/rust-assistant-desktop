/**
 * AI 修改后自动质检（移植桌面端任务 3 + M10 语义升级）：
 * writeFile/applyDiff 成功后，读取刚写入的文件跑一遍 rustLint + 语义检查器，
 * 把诊断转成「文件 + 行号 + 原因 + 修复建议 + 证据」的可操作清单，
 * 展示在对话工具卡片里；问题清单再回传给模型做自纠（aiClient 消费）。
 *
 * 设计（与桌面版一致）：
 * - lint 数据层（代码表/值类型/词典）只在渲染层加载过，质检也放在渲染层；
 *   lint 与撤销/历史完全独立——质检发现问题不影响撤销；
 * - 行号用单趟预计算的起始偏移表 O(1) 查（诊断可能数千条，逐条重扫是 O(n²)）；
 * - 清单上限 200 条，其余折叠为一条汇总（UI 一次性渲染数万条会卡死）。
 * 手机版差异：WebView 无 Buffer（字节长度用 TextEncoder）；lint 数据形状与
 * mobile rustLint 对齐（无 valueZhToEn），测试可注入 data 绕过数据层 fetch。
 */
import type { AiLintItem } from '../../types/ai'
import { lintIniText } from '../editor/rustLint'
import {
  findCodeByCode,
  findValueType,
  getAllCodes,
  getKeyZhToEnDict,
  getZhToEnDict,
  loadCodeData,
  versionNameToNumber,
} from '../../services/codeData'
import { runSemanticChecks, type CustomRule } from '../editor/semanticChecks'
import { defaultSemanticCheckerConfig, enabledRuleIds } from '../editor/semanticChecks/registry'
import { loadProjectRuleSets } from '../editor/semanticChecks/customRules'
import { joinProjectPath } from '../../utils/projectPath'

/** 清单上限：超出后折叠为汇总条目（防大文件产生数万条诊断拖垮渲染） */
const MAX_LINT_ITEMS = 200
/** 超过此体积的文件跳过质检（lint 是单趟 O(n)，超大文件在渲染线程跑会卡界面）。
 * 质检是一次性动作（非每次输入），覆盖「AI 写大文件后的完整检查」场景，保留 5MB 上限 */
const MAX_LINT_FILE_CHARS = 5 * 1024 * 1024

/** lint 数据（与 mobile rustLint/语义检查器的 ctx 形状对齐；测试可注入） */
export interface QualityCheckData {
  findCode: (k: string) => { type: string } | undefined
  findType: (t: string) => ReturnType<typeof findValueType>
  zhToEn: (k: string) => string | undefined
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
    return '对照检查页/代码表修正该键的值，或让 AI 按值类型规则重写这一行'
  }
  if (message.includes('不在任何')) {
    return '把该行移入 [节] 内，或删除此行'
  }
  return '检查该行格式是否符合铁锈战争 .ini 规范'
}

/** lint 诊断 → 可操作清单（纯函数，供测试）；超过上限时折叠为汇总条目（line=0，UI 不显示行号/定位）。
 * fold=false 时不折叠（由调用方合并多个来源后统一折叠一次，避免汇总计数二次失真） */
export function toLintItems(
  content: string,
  diagnostics: Array<{ from: number; to: number; message: string; severity: 'error' | 'warning' }>,
  fold = true,
): AiLintItem[] {
  const starts = lineStarts(content)
  const items: AiLintItem[] = diagnostics.slice(0, MAX_LINT_ITEMS).map((d) => ({
    line: lineNumberAt(starts, d.from),
    message: d.message,
    severity: d.severity,
    suggestion: suggestionFor(d.message),
  }))
  if (fold && diagnostics.length > MAX_LINT_ITEMS) {
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

/** 质检选项：语义检查器配置、项目单位名与目标版本（引用/版本兼容检查用） */
export interface QualityCheckOptions {
  semanticCheckers?: Record<string, boolean>
  unitNames?: ReadonlySet<string>
  /** 当前项目目标游戏版本名（空 = 跟随最新） */
  targetVersionName?: string
  /** 项目自定义规则（声明式；缺省自动从项目 rules/ 目录加载） */
  customRules?: CustomRule[]
  /** 当前文件相对路径（checkFile 区分 .template 模板文件；缺省按单位文件处理） */
  file?: string
  /** 测试注入：绕过 loadCodeData（node 测试环境无内置资源可 fetch） */
  data?: QualityCheckData
}

/** 从数据层构建 lint 数据（词典只在渲染层加载过，质检复用同一套） */
export async function buildQualityCheckData(): Promise<QualityCheckData> {
  await loadCodeData()
  const zhToEnDict = getZhToEnDict()
  const keyZhToEnDict = getKeyZhToEnDict()
  return {
    findCode: (k: string) => findCodeByCode(k),
    findType: (t: string) => findValueType(t),
    // 键位置回译先查键名表（键译名不被节名覆盖，如「价格」→price）
    zhToEn: (k: string) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k),
  }
}

/**
 * 质检核心（纯函数 + 可注入数据，供测试与 checkAiWrittenFile 共用）：
 * 基础 lint + 语义检查器合并为统一清单。
 */
export async function qualityCheckContent(content: string, options: QualityCheckOptions = {}): Promise<AiLintItem[]> {
  if (content.length > MAX_LINT_FILE_CHARS) return []
  const data = options.data ?? (await buildQualityCheckData())
  const diagnostics = lintIniText(content, data)
  const items = toLintItems(content, diagnostics, false)

  // 语义检查器（与编辑器波浪线同一套规则；info 降级为 warning 展示）
  const ruleIds = enabledRuleIds(options.semanticCheckers ?? defaultSemanticCheckerConfig())
  const targetVersionNumber = options.targetVersionName ? versionNameToNumber(options.targetVersionName) : undefined
  const issues = runSemanticChecks(content, {
    ruleIds,
    ctx: {
      ...data,
      codes: getAllCodes().map((c) => c.code),
      unitNames: options.unitNames,
      targetVersionNumber,
      file: options.file,
    },
    customRules: options.customRules,
    customRuleConfig: options.semanticCheckers,
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
  // 统一折叠一次：被隐藏数 = 基础诊断超出部分 + 语义条目超出剩余槽位的部分
  const hiddenBase = Math.max(0, diagnostics.length - MAX_LINT_ITEMS)
  const hiddenSemantic = Math.max(0, semanticItems.length - Math.max(0, MAX_LINT_ITEMS - items.length))
  const hidden = hiddenBase + hiddenSemantic
  if (hidden > 0) {
    const baseErrors = diagnostics.slice(MAX_LINT_ITEMS).filter((d) => d.severity === 'error').length
    const semErrors = semanticItems.slice(Math.max(0, MAX_LINT_ITEMS - items.length)).filter((i) => i.severity === 'error').length
    merged.length = Math.min(merged.length, MAX_LINT_ITEMS)
    merged.push({
      line: 0,
      message: `…其余 ${hidden} 条问题未列出${baseErrors + semErrors > 0 ? `（其中 ${baseErrors + semErrors} 个错误）` : ''}，建议先修复上面的问题后重新让 AI 检查`,
      severity: 'warning',
      suggestion: '',
    })
  }
  return merged
}

/** 项目单位名扫描缓存：AI 一个流连续写 N 个文件只扫一次（同项目 2s 窗口内共享）。
 * 每次扫描都在 writeFile 完成后触发，已包含此前全部写入，共享结果安全 */
let unitNamesScanCache: { root: string; names: ReadonlySet<string>; at: number } | null = null

/** 质检必须用最新单位名（AI 刚写的单位要在引用检查中立即可见）。
 * 扫描失败/空项目时返回 undefined → 引用检查整体跳过，
 * 避免「扫描失败被当作空项目」导致 builtFrom/convertTo 全部误报 */
export async function getFreshUnitNames(rootPath: string): Promise<ReadonlySet<string> | undefined> {
  const now = Date.now()
  if (unitNamesScanCache && unitNamesScanCache.root === rootPath && now - unitNamesScanCache.at < 2000) {
    return unitNamesScanCache.names
  }
  const { getBridge } = await import('../../services/bridge')
  const scan = await getBridge().mod.scanResources(rootPath).catch(() => null)
  if (!scan) return undefined
  const names: ReadonlySet<string> = new Set(scan.unitNames)
  unitNamesScanCache = { root: rootPath, at: now, names }
  return names.size > 0 ? names : undefined
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
    // 项目自定义规则（读取失败不影响质检）
    let customRules = options.customRules
    if (!customRules) {
      const loaded = await loadProjectRuleSets(rootPath).catch(() => ({ sets: [], errors: [] }))
      customRules = loaded.sets.flatMap((s) => s.rules)
    }
    return qualityCheckContent(content, { ...options, customRules, file: relPath })
  } catch {
    // 文件被删/读取失败等：跳过质检，不影响对话与撤销
    return null
  }
}

/** UTF-8 字节长度（WebView 无 Buffer，用 TextEncoder 计算，与 applyDiff 同口径） */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** 自纠闭环：质检清单 → 回传给 AI 的精简修正指令（纯函数，供测试）。
 * 只取前 30 条并按总长度预算截断（极端长消息/建议也不超限）。 */
export function lintItemsToFeedback(items: AiLintItem[]): string {
  const MAX_BYTES = 7 * 1024
  const head = '（自动质检反馈）你刚才写入的文件存在以下问题，请直接修复后重新写入：\n'
  const tail = '\n修复完成后用 writeFile（整文件）或 applyDiff（局部修改）重新写入修复后的内容。'
  const lines: string[] = []
  let bytes = utf8ByteLength(head) + utf8ByteLength(tail)
  for (const it of items) {
    if (lines.length >= 30) break
    const line = `- 第${it.line}行：${it.message}${it.suggestion ? `（建议：${it.suggestion}）` : ''}`
    bytes += utf8ByteLength(line) + 1
    if (bytes > MAX_BYTES) break
    lines.push(line)
  }
  const skipped = items.length - lines.length
  const skippedNote = skipped > 0 ? `\n（其余 ${skipped} 条未列出，请先修复列出的问题）` : ''
  return `${head}${lines.join('\n')}${skippedNote}${tail}`
}
