/**
 * 模组质量报告（M13，P1 任务 7）：一键生成模组健康报告——
 * 文件清单统计、语义检查器全量结果汇总、版本兼容结论。
 * 脱敏：所有路径一律相对项目根（绝不含本机绝对路径），导出文本/JSON 可安全分享。
 *
 * 数据来源：scanResources（文件清单/单位名）+ 逐文件读取跑 runSemanticChecks
 * （与编辑器波浪线、AI 写后质检同一套规则）。
 */
import type { AiLintItem } from '../../types/ai'
import { runSemanticChecks, type SemanticIssue } from '../editor/semanticChecks'
import { defaultSemanticCheckerConfig, enabledRuleIds } from '../editor/semanticChecks/registry'
import { findCodeByCode, findValueType, getAllCodes, getZhToEnDict, loadCodeData, versionNameToNumber } from '../../services/codeData'

/** 报告中的单条问题（file 为相对项目根的 posix 路径，脱敏） */
export interface ModReportIssue {
  file: string
  line: number
  ruleId: string
  severity: 'error' | 'warning'
  message: string
  suggestion: string
}

/** 检查器汇总（按规则聚合） */
export interface ModReportCheckerSummary {
  ruleId: string
  title: string
  errors: number
  warnings: number
}

export interface ModReport {
  meta: {
    projectName: string
    generatedAt: number
    fileCount: number
    unitCount: number
    imageCount: number
    audioCount: number
    targetVersion: string
  }
  checkerSummary: ModReportCheckerSummary[]
  issues: ModReportIssue[]
  versionConclusion: string
  ok: boolean
}

/** 单文件检查上限（防超大文件拖慢报告生成） */
const MAX_REPORT_FILE_CHARS = 2 * 1024 * 1024
/** 报告问题清单上限（超出折叠为汇总条目，UI 渲染数万条会卡） */
const MAX_REPORT_ISSUES = 500

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const AUDIO_EXTS = new Set(['.ogg', '.wav', '.mp3', '.flac'])

export interface ModReportOptions {
  projectName: string
  semanticCheckers?: Record<string, boolean>
  targetVersionName?: string
}

/** 语义问题 → 报告条目（info 降级 warning） */
function toReportIssue(file: string, it: SemanticIssue): ModReportIssue {
  return {
    file,
    line: it.line,
    ruleId: it.ruleId,
    severity: it.severity === 'error' ? 'error' : 'warning',
    message: it.message,
    suggestion: it.suggestion,
  }
}

/** 生成模组质量报告（纯数据；渲染层调用，bridge 提供 fs 能力） */
export async function generateModReport(rootPath: string, options: ModReportOptions): Promise<ModReport> {
  const { getBridge } = await import('../../services/bridge')
  const scan = await getBridge().mod.scanResources(rootPath)
  const files = scan.files ?? []
  const unitNames = new Set(scan.unitNames ?? [])

  await loadCodeData()
  const zhToEnDict = getZhToEnDict()
  const data = {
    findCode: (k: string) => findCodeByCode(k),
    findType: (t: string) => findValueType(t),
    zhToEn: (k: string) => zhToEnDict.get(k),
  }
  const ruleIds = enabledRuleIds(options.semanticCheckers ?? defaultSemanticCheckerConfig())
  const targetVersionNumber = options.targetVersionName ? versionNameToNumber(options.targetVersionName) : undefined

  const issues: ModReportIssue[] = []
  const checkerCount = new Map<string, { errors: number; warnings: number }>()
  let unitCount = 0
  let imageCount = 0
  let audioCount = 0

  // 逐文件全量检查（.ini/.template）；图片/音频只统计不检查
  for (const file of files) {
    const lower = file.toLowerCase()
    if (IMAGE_EXTS.has(lower.slice(lower.lastIndexOf('.')))) {
      imageCount++
      continue
    }
    if (AUDIO_EXTS.has(lower.slice(lower.lastIndexOf('.')))) {
      audioCount++
      continue
    }
    if (!/\.(ini|template)$/i.test(file)) continue
    const content = await getBridge().project.readFile(rootPath, file).then((r) => r.content).catch(() => '')
    if (!content || content.length > MAX_REPORT_FILE_CHARS) continue
    // 基础 lint + 语义检查器（与质检一致）
    const { lintIniText } = await import('../editor/rustLint')
    const { lineNumberAt, lineStarts } = await import('../ai/aiQualityCheck')
    const diagnostics = lintIniText(content, data)
    const starts = lineStarts(content)
    const issuesAll: ModReportIssue[] = []
    for (const d of diagnostics) {
      issuesAll.push({
        file,
        line: lineNumberAt(starts, d.from),
        ruleId: '基础lint',
        severity: d.severity,
        message: d.message,
        suggestion: '',
      })
    }
    const semantic = runSemanticChecks(content, {
      ruleIds,
      ctx: { ...data, codes: getAllCodes().map((c) => c.code), unitNames, targetVersionNumber },
    })
    for (const it of semantic) issuesAll.push(toReportIssue(file, it))

    // 是否单位文件（有 [core] 节）
    if (/^\s*\[core\]\s*$/im.test(content)) unitCount++

    for (const it of issuesAll) {
      const c = checkerCount.get(it.ruleId) ?? { errors: 0, warnings: 0 }
      if (it.severity === 'error') c.errors++
      else c.warnings++
      checkerCount.set(it.ruleId, c)
      if (issues.length < MAX_REPORT_ISSUES) issues.push(it)
    }
  }
  if (issues.length >= MAX_REPORT_ISSUES) {
    issues.push({
      file: '',
      line: 0,
      ruleId: '汇总',
      severity: 'warning',
      message: `…问题过多，仅列出前 ${MAX_REPORT_ISSUES} 条，请先修复后重新生成报告`,
      suggestion: '',
    })
  }

  // 检查器汇总（按错误数降序）
  const checkerSummary: ModReportCheckerSummary[] = [...checkerCount.entries()]
    .map(([ruleId, c]) => ({ ruleId, title: ruleId, errors: c.errors, warnings: c.warnings }))
    .sort((a, b) => b.errors - a.errors || b.warnings - a.warnings)

  const totalErrors = issues.filter((i) => i.severity === 'error').length
  const versionIssues = issues.filter((i) => i.ruleId === 'checkVersionCompatibility')
  const versionConclusion = versionIssues.length === 0
    ? `目标版本 ${options.targetVersionName || '跟随最新'}：未发现版本兼容问题`
    : `目标版本 ${options.targetVersionName || '跟随最新'}：发现 ${versionIssues.length} 条版本兼容提示（写入的字段与目标版本不完全兼容）`

  return {
    meta: {
      projectName: options.projectName,
      generatedAt: Date.now(),
      fileCount: files.length,
      unitCount,
      imageCount,
      audioCount,
      targetVersion: options.targetVersionName || '跟随最新',
    },
    checkerSummary,
    issues,
    versionConclusion,
    ok: totalErrors === 0,
  }
}

/** 报告 → 纯文本（分享用；全部相对路径） */
export function reportToText(r: ModReport): string {
  const lines: string[] = []
  lines.push(`铁锈助手 · 模组质量报告`)
  lines.push(`项目：${r.meta.projectName}`)
  lines.push(`生成时间：${new Date(r.meta.generatedAt).toLocaleString()}`)
  lines.push(`文件 ${r.meta.fileCount} · 单位 ${r.meta.unitCount} · 图片 ${r.meta.imageCount} · 音频 ${r.meta.audioCount} · 目标版本 ${r.meta.targetVersion}`)
  lines.push(`总体：${r.ok ? '通过' : `发现 ${r.issues.filter((i) => i.severity === 'error').length} 个错误`}`)
  lines.push(`版本兼容：${r.versionConclusion}`)
  lines.push('')
  if (r.checkerSummary.length > 0) {
    lines.push('── 检查器汇总 ──')
    for (const c of r.checkerSummary) {
      lines.push(`${c.title}: ${c.errors} 错误 / ${c.warnings} 警告`)
    }
    lines.push('')
  }
  if (r.issues.length > 0) {
    lines.push('── 问题清单 ──')
    for (const it of r.issues) {
      const loc = it.file ? `${it.file}${it.line > 0 ? `:${it.line}` : ''}` : ''
      lines.push(`[${it.severity === 'error' ? '错误' : '警告'}] ${loc} ${it.message}${it.suggestion ? `（建议：${it.suggestion}）` : ''}`)
    }
  } else {
    lines.push('未发现问题 ✓')
  }
  return lines.join('\n')
}

/** 报告 → JSON 字符串（分享用；不含本机绝对路径） */
export function reportToJson(r: ModReport): string {
  return JSON.stringify(r, null, 2)
}

export type { AiLintItem }
