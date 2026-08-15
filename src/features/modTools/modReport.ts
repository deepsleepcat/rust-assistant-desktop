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
import { loadProjectRuleSets } from '../editor/semanticChecks/customRules'
import { findCodeByCode, findValueType, getAllCodes, getKeyZhToEnDict, getZhToEnDict, loadCodeData, versionNameToNumber } from '../../services/codeData'
import { joinProjectPath } from '../../utils/projectPath'

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
    /** 因超过单文件上限（2MB）未检查的文件数 */
    skippedLargeFiles: number
    /** 检查中异常被跳过的文件数 */
    checkFailedFiles: number
  }
  /** 全量统计（不受问题清单 500 条上限影响——ok/结论必须基于全量计数） */
  errorCount: number
  warningCount: number
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
  /** 进度回调（已检查文件数/需检查文件数；用于 UI 显示进度） */
  onProgress?: (done: number, total: number) => void
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

/** 生成模组质量报告（纯数据；渲染层调用，bridge 提供 fs 能力）。
 * bridge 参数为依赖注入（测试用）；缺省从桥服务获取 */
export async function generateModReport(
  rootPath: string,
  options: ModReportOptions,
  bridgeOverride?: { mod: { scanResources(root: string): Promise<{ files: string[]; unitNames: string[] }> }; project: { readFile(root: string, file: string): Promise<{ content: string }>; readDir?(root: string, dir: string, showHidden?: boolean): Promise<Array<{ name: string; isDirectory: boolean }>> } },
): Promise<ModReport> {
  const bridge = bridgeOverride ?? (await import('../../services/bridge')).getBridge()
  const scan = await bridge.mod.scanResources(rootPath)
  const files = scan.files ?? []
  const unitNames = new Set(scan.unitNames ?? [])

  await loadCodeData()
  const zhToEnDict = getZhToEnDict()
  const keyZhToEnDict = getKeyZhToEnDict()
  const data = {
    findCode: (k: string) => findCodeByCode(k),
    findType: (t: string) => findValueType(t),
    // 键位置回译先查键名表（键译名不被节名覆盖，如「价格」→price）
    zhToEn: (k: string) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k),
  }
  const ruleIds = enabledRuleIds(options.semanticCheckers ?? defaultSemanticCheckerConfig())
  const targetVersionNumber = options.targetVersionName ? versionNameToNumber(options.targetVersionName) : undefined
  // M21：项目自定义规则（rules/*.json；测试注入的桥没有 readDir 时跳过）
  const customRules = bridge.project.readDir
    ? (await loadProjectRuleSets(rootPath, bridge as never)).sets.flatMap((s) => s.rules)
    : []

  const issues: ModReportIssue[] = []
  const checkerCount = new Map<string, { errors: number; warnings: number }>()
  let unitCount = 0
  let imageCount = 0
  let audioCount = 0
  let skippedLargeFiles = 0
  // 全量计数器（不受问题清单 500 条上限影响：ok/版本结论必须基于全量）
  let totalErrorCount = 0
  let totalWarningCount = 0
  let versionIssueCount = 0
  const codes = getAllCodes().map((c) => c.code)

  // 依赖提升到循环外（避免每个文件一次动态 import 解析）
  const { lintIniText } = await import('../editor/rustLint')
  const { lineNumberAt, lineStarts } = await import('../ai/aiQualityCheck')

  /** 单文件检查（供并发批次调用；只处理 ini/template——图片/音频已在 checkFiles 构建时统计） */
  let checkFailedFiles = 0
  async function checkOne(file: string): Promise<void> {
    // bridge fs 通道要求项目内绝对路径（相对路径会被主进程拒绝）
    const content = await bridge.project.readFile(rootPath, joinProjectPath(rootPath, file)).then((r) => r.content).catch(() => '')
    if (!content) return
    if (content.length > MAX_REPORT_FILE_CHARS) {
      skippedLargeFiles++
      return
    }
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
      ctx: { ...data, codes, unitNames, targetVersionNumber, file, projectProjectiles },
      customRules,
      customRuleConfig: options.semanticCheckers,
    })
    for (const it of semantic) issuesAll.push(toReportIssue(file, it))

    // 是否单位文件（[core]/[CORE]/[核心] 节，容忍行尾注释——
    // 与 scanResources/checkMod 判定一致，节名大小写不敏感）
    if (/^\s*\[(?:core|核心)\]\s*(?:#.*)?$/im.test(content)) unitCount++

    for (const it of issuesAll) {
      const c = checkerCount.get(it.ruleId) ?? { errors: 0, warnings: 0 }
      if (it.severity === 'error') {
        c.errors++
        totalErrorCount++
      } else {
        c.warnings++
        totalWarningCount++
      }
      checkerCount.set(it.ruleId, c)
      if (it.ruleId === 'checkVersionCompatibility') versionIssueCount++
      if (issues.length < MAX_REPORT_ISSUES) issues.push(it)
    }
  }

  // 需要检查的 ini/template 文件（顺带统计图片/音频——checkOne 只处理 ini）
  const checkFiles: string[] = []
  for (const f of files) {
    const ext = f.slice(f.lastIndexOf('.')).toLowerCase()
    if (IMAGE_EXTS.has(ext)) {
      imageCount++
    } else if (AUDIO_EXTS.has(ext)) {
      audioCount++
    } else if (/\.(ini|template)$/i.test(f)) {
      checkFiles.push(f)
    }
  }
  // 项目级弹体节名集合（[projectile_xxx]，跨文件弹体引用检查用——
  // 引擎弹体是全局资源，可在任意单位文件定义）。只读 ini/template。
  const projectProjectiles = new Set<string>()
  for (const f of checkFiles) {
    const content = await bridge.project
      .readFile(rootPath, joinProjectPath(rootPath, f))
      .then((r) => r.content)
      .catch(() => '')
    for (const m of content.matchAll(/^\s*\[projectile_([^\]]+)\]\s*(?:#.*)?$/gm)) {
      projectProjectiles.add(m[1].trim().toLowerCase())
    }
  }
  // 分批并发（每批 6 个），每批之间让出事件循环；进度回调
  const BATCH = 6
  for (let i = 0; i < checkFiles.length; i += BATCH) {
    await Promise.all(
      checkFiles.slice(i, i + BATCH).map((f) =>
        checkOne(f).catch((err) => {
          checkFailedFiles++
          console.warn('[modReport] 单文件检查失败，已跳过：', f, err)
        }),
      ),
    )
    options.onProgress?.(Math.min(i + BATCH, checkFiles.length), checkFiles.length)
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

  const versionConclusion = versionIssueCount === 0
    ? `目标版本 ${options.targetVersionName || '跟随最新'}：未发现版本兼容问题`
    : `目标版本 ${options.targetVersionName || '跟随最新'}：发现 ${versionIssueCount} 条版本兼容提示（写入的字段与目标版本不完全兼容）`

  return {
    meta: {
      projectName: options.projectName,
      generatedAt: Date.now(),
      fileCount: files.length,
      unitCount,
      imageCount,
      audioCount,
      targetVersion: options.targetVersionName || '跟随最新',
      skippedLargeFiles,
      checkFailedFiles,
    },
    errorCount: totalErrorCount,
    warningCount: totalWarningCount,
    checkerSummary,
    issues,
    versionConclusion,
    ok: totalErrorCount === 0,
  }
}

/** 报告 → 纯文本（分享用；全部相对路径） */
export function reportToText(r: ModReport): string {
  const lines: string[] = []
  lines.push(`铁锈助手 · 模组质量报告`)
  lines.push(`项目：${r.meta.projectName}`)
  lines.push(`生成时间：${new Date(r.meta.generatedAt).toLocaleString()}`)
  lines.push(`文件 ${r.meta.fileCount} · 单位 ${r.meta.unitCount} · 图片 ${r.meta.imageCount} · 音频 ${r.meta.audioCount} · 目标版本 ${r.meta.targetVersion}${r.meta.skippedLargeFiles > 0 ? ` · 跳过 ${r.meta.skippedLargeFiles} 个超大文件` : ''}${r.meta.checkFailedFiles > 0 ? ` · ${r.meta.checkFailedFiles} 个文件检查异常` : ''}`)
  lines.push(`总体：${r.ok ? '通过' : `发现 ${r.errorCount} 个错误`}`)
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
