/**
 * 官方数据版本差异可视化（M17，P2 任务 1）：
 * 两个游戏版本之间代码表字段差异（新增/弃用/改版替代）+ 迁移建议
 * + 项目级「升级到目标版本的改动清单」。
 *
 * 数据模型：code.json 每条字段带 addVersion（加入版本号）/removeVersion
 * （≥0 表示在该版本移除；-1 = 未移除）。「修改」无独立标记，但官方描述
 * 里常见「代替X/替代X/取代X」——解析为「改版替代」关系（旧名 → 现名）。
 * 人工核对过的迁移映射放 MIGRATE_MAP（数据更新后可补充）。
 *
 * 与版本兼容检查（checkVersionCompatibility）同源数据：
 * - 字段 addVersion > 目标版本 → 旧游戏不识别（过新）；
 * - 字段 removeVersion ≥ 0 且 ≤ 目标版本 → 已失效。
 *
 * 可测试性：diff 与报告都接受可选的 codes 参数（缺省 = 全局代码表），
 * 测试可注入受控数据覆盖「弃用字段/迁移建议」分支（真实数据目前没有
 * removeVersion ≥ 0 的字段）。
 */
import type { CodeInfo } from './codeData'
import { findCodeByCode, getAllCodes, getKeyZhToEnDict, getZhToEnDict, loadCodeData, versionNameToNumber, versionNumberToName } from './codeData'
import { parseIni, toEnKey } from '../features/editor/semanticChecks/helpers'
import { joinProjectPath } from '../utils/projectPath'

/** 单条字段差异 */
export interface FieldChange {
  code: string
  translate: string
  section: string
  type: string
  description?: string
  /** 触发本差异的版本号（新增 = 加入版本；弃用 = 移除版本） */
  version: number
  /** 迁移建议：替代字段 code（可空） */
  migrateTo?: string
  /** 迁移建议说明（替代字段译名/人工映射来源） */
  migrateHint?: string
}

/** 改版替代关系：旧名被现名取代（现名条目的官方描述声明「代替旧名」） */
export interface ReplacedPair {
  oldCode: string
  newCode: string
  oldTranslate?: string
  newTranslate?: string
  /** 现名条目的加入版本（信息性展示） */
  newVersion?: number
}

/** 两个版本之间的差异结果 */
export interface VersionDiff {
  from: { versionName: string; versionNumber: number }
  to: { versionName: string; versionNumber: number }
  /** 新增字段（加入版本在 (from, to] 区间） */
  added: FieldChange[]
  /** 弃用字段（from 时存在、to 时已移除：removeVersion ≥ 0 且 ≤ to） */
  removed: FieldChange[]
  /** 改版替代关系（代码表描述声明旧名被现名取代） */
  replaced: ReplacedPair[]
}

/** 升级报告条目（file 为相对项目根的 posix 路径，脱敏可分享） */
export interface UpgradeReportItem {
  file: string
  line: number
  code: string
  /** must_migrate = 目标版本已弃用，必须处理；new_field = 目标版本新增，可选用 */
  kind: 'must_migrate' | 'new_field'
  message: string
  suggestion: string
}

export interface UpgradeReport {
  meta: {
    projectName: string
    generatedAt: number
    fileCount: number
    fromVersion: string
    toVersion: string
  }
  /** 必须处理的弃用字段使用次数（全量计数，不受条目上限影响） */
  mustFixCount: number
  /** 新增字段使用次数（信息性） */
  newFieldCount: number
  items: UpgradeReportItem[]
}

/**
 * 人工核对的迁移映射（旧字段 → 新字段）。
 * 官方数据目前没有 removeVersion ≥ 0 的字段，此表先留空；
 * 后续版本数据更新后，在此补充人工核对过的替换关系（描述启发式之外的兜底）。
 * 方向约定：key = 用户可能写下的旧名，value = 应改用的现名。
 */
const MIGRATE_MAP: Record<string, string> = {}

/** 单文件检查上限（与质量报告一致，防超大文件拖慢扫描） */
const MAX_UPGRADE_FILE_CHARS = 2 * 1024 * 1024
/** 升级报告条目上限（超出折叠为汇总提示） */
const MAX_UPGRADE_ITEMS = 500

/** 解析描述里的替代声明：「代替X / 替代X / 取代X」；
 * X 允许字母数字下划线连字符（only-ignoreEnemy 这类旧名带连字符）。
 * 目标与字段自身同名视为脏数据跳过（大量条目是「代替true/代替NONE」自指说明）。 */
function parseReplacesTarget(description: string | undefined): string | undefined {
  if (!description) return undefined
  const m = /(?:代替|替代|取代)\s*([A-Za-z_][A-Za-z0-9_-]*)/.exec(description)
  return m?.[1]
}

/** 代码表 → 大小写不敏感查找表 */
function lookupCodes(codes: CodeInfo[]): Map<string, CodeInfo> {
  const m = new Map<string, CodeInfo>()
  for (const c of codes) m.set(c.code.toLowerCase(), c)
  return m
}

/** 从代码表派生「旧名 → 现名」替代映射：
 * 条目描述声明「代替X」且 X 存在、X ≠ 自身 → 该条目是 X 的现名。
 * 例：outpostT1 的描述「内置单位，代替laserDefence」→ old=outpostT1 → new=laserDefence。 */
export function buildReplaceMap(codes: CodeInfo[]): Map<string, CodeInfo> {
  const lookup = lookupCodes(codes)
  const map = new Map<string, CodeInfo>()
  for (const c of codes) {
    const target = parseReplacesTarget(c.description)
    if (!target) continue
    const lowerTarget = target.toLowerCase()
    if (lowerTarget === c.code.toLowerCase()) continue // 自指（代替true/代替NONE 等）
    const hit = lookup.get(lowerTarget)
    if (!hit) continue
    map.set(c.code.toLowerCase(), hit)
  }
  return map
}

/** 迁移建议（旧名 → 现名）：代码表派生映射优先，其次人工映射表 */
export function getMigrateSuggestion(code: string, codes: CodeInfo[] = getAllCodes()): { migrateTo?: string; migrateHint?: string } {
  const derived = buildReplaceMap(codes).get(code.toLowerCase())
  if (derived) {
    return { migrateTo: derived.code, migrateHint: `官方描述声明由「${derived.translate}」取代` }
  }
  const manual = MIGRATE_MAP[code]
  if (manual) {
    const target = findCodeByCode(manual)
    return { migrateTo: manual, migrateHint: target ? `替代字段「${target.translate}」（人工核对）` : `替代字段 ${manual}` }
  }
  return {}
}

/** 版本号 → 版本号（未知版本名抛错：调用方应先用版本表校验） */
function requireVersionNumber(name: string): number {
  const n = versionNameToNumber(name)
  if (n === undefined) throw new Error(`未知的游戏版本：${name}`)
  return n
}

/** 字段版本号清洗：数据里出现过字符串 "4" 的脏值；数字/数字字符串 → 数字，其余 undefined */
function versionOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** 计算两个版本之间的字段差异（from 必须早于 to；codes 缺省 = 全局代码表） */
export function getVersionDiff(fromName: string, toName: string, codes: CodeInfo[] = getAllCodes()): VersionDiff {
  const fromNumber = requireVersionNumber(fromName)
  const toNumber = requireVersionNumber(toName)
  if (fromNumber >= toNumber) throw new Error('起始版本必须早于目标版本')

  const added: FieldChange[] = []
  const removed: FieldChange[] = []
  const replaced: ReplacedPair[] = []

  for (const c of codes) {
    const add = versionOf(c.addVersion)
    const remove = versionOf(c.removeVersion)
    // 新增：加入版本落在 (from, to] 区间
    if (add !== undefined && add > fromNumber && add <= toNumber) {
      added.push(fieldChange(c, add))
    }
    // 弃用：升级窗口 (from, to] 内移除（移除版本 ≤ from 的旧债不归本次升级，
    // 用户当前版本已受影响，不在升级清单里重复提醒）
    if (remove !== undefined && remove >= 0 && remove > fromNumber && remove <= toNumber && add !== undefined && add <= fromNumber) {
      removed.push(fieldChange(c, remove, codes))
    }
  }

  // 改版替代：全部派生映射（旧名在代码表内）。历史替代关系不按版本窗口过滤——
  // 窗口过滤会让真实数据（替代对双方都是 addVersion 1）永远为空；UI 已标注
  // 「历史全量，不限窗口」避免误解
  const replaceMap = buildReplaceMap(codes)
  for (const [oldLower, newer] of replaceMap) {
    const old = codes.find((c) => c.code.toLowerCase() === oldLower)
    if (!old) continue
    replaced.push({
      oldCode: old.code,
      oldTranslate: old.translate,
      newCode: newer.code,
      newTranslate: newer.translate,
      newVersion: newer.addVersion,
    })
  }
  replaced.sort((a, b) => a.oldCode.localeCompare(b.oldCode))

  // 排序：按版本号升序、再按 code 升序（展示稳定）
  const byVersionThenCode = (a: FieldChange, b: FieldChange) => a.version - b.version || a.code.localeCompare(b.code)
  added.sort(byVersionThenCode)
  removed.sort(byVersionThenCode)

  return {
    from: { versionName: fromName, versionNumber: fromNumber },
    to: { versionName: toName, versionNumber: toNumber },
    added,
    removed,
    replaced,
  }
}

/** 字段差异条目（弃用条目顺带迁移建议） */
function fieldChange(c: CodeInfo, version: number, codes?: CodeInfo[]): FieldChange {
  const out: FieldChange = {
    code: c.code,
    translate: c.translate,
    section: c.section,
    type: c.type,
    description: c.description,
    version,
  }
  if (c.removeVersion !== undefined && c.removeVersion >= 0) {
    const sug = getMigrateSuggestion(c.code, codes)
    out.migrateTo = sug.migrateTo
    out.migrateHint = sug.migrateHint
  }
  return out
}

export interface UpgradeReportOptions {
  projectName: string
  /** 进度回调（已检查文件数/需检查文件数） */
  onProgress?: (done: number, total: number) => void
  /** 代码表注入（测试用；缺省 = 全局代码表） */
  codes?: CodeInfo[]
}

/** 生成项目「升级到 toVersion 的改动清单」：
 * 扫描项目 ini/template 文件，找出用到「目标版本已弃用字段」与
 * 「目标版本新增字段」的位置。bridge 参数为依赖注入（测试用）。 */
export async function buildUpgradeReport(
  rootPath: string,
  fromVersion: string,
  toVersion: string,
  options: UpgradeReportOptions,
  bridgeOverride?: { mod: { scanResources(root: string): Promise<{ files: string[]; unitNames: string[] }> }; project: { readFile(root: string, file: string): Promise<{ content: string }> } },
): Promise<UpgradeReport> {
  const bridge = bridgeOverride ?? (await import('./bridge')).getBridge()
  const scan = await bridge.mod.scanResources(rootPath)
  const files = (scan.files ?? []).filter((f) => /\.(ini|template)$/i.test(f))

  await loadCodeData()
  const toNumber = requireVersionNumber(toVersion)
  const fromNumber = requireVersionNumber(fromVersion)
  const zhToEnDict = getZhToEnDict()
  const keyZhToEnDict = getKeyZhToEnDict()
  const codes = options.codes ?? getAllCodes()
  const lookup = lookupCodes(codes)

  const items: UpgradeReportItem[] = []
  let mustFixCount = 0
  let newFieldCount = 0

  async function checkOne(file: string): Promise<void> {
    // bridge fs 通道要求项目内绝对路径（相对路径会被主进程拒绝）
    const content = await bridge.project.readFile(rootPath, joinProjectPath(rootPath, file)).then((r) => r.content).catch(() => '')
    if (!content) return
    if (content.length > MAX_UPGRADE_FILE_CHARS) return
    const { keyValues } = parseIni(content)
    for (const kv of keyValues) {
      const enKey = toEnKey(kv.key, (k) => keyZhToEnDict.get(k) ?? zhToEnDict.get(k))
      const code = lookup.get(enKey.toLowerCase())
      if (!code) continue
      const add = versionOf(code.addVersion)
      const remove = versionOf(code.removeVersion)
      // 目标版本已弃用且 from 时存在 → 必须处理
      if (remove !== undefined && remove >= 0 && remove > fromNumber && remove <= toNumber && add !== undefined && add <= fromNumber) {
        mustFixCount++
        const removedName = versionNumberToName(remove)
        const sug = getMigrateSuggestion(code.code, codes)
        items.push({
          file,
          line: kv.line,
          code: code.code,
          kind: 'must_migrate',
          message: `「${kv.key}」在版本 ${removedName ?? remove} 已弃用，升级到 ${toVersion} 后不再生效`,
          suggestion: sug.migrateTo ? `改用替代字段「${sug.migrateTo}」` : '查找替代字段或移除该键',
        })
      } else if (add !== undefined && add > fromNumber && add <= toNumber) {
        // 目标版本新增字段 → 信息性提示（可选用）
        newFieldCount++
        const addedName = versionNumberToName(add)
        items.push({
          file,
          line: kv.line,
          code: code.code,
          kind: 'new_field',
          message: `「${kv.key}」是版本 ${addedName ?? add} 新增的字段（升级后可用）`,
          suggestion: '按需使用；旧版本游戏会忽略该字段',
        })
      }
    }
  }

  const BATCH = 6
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(
      files.slice(i, i + BATCH).map((f) => checkOne(f).catch(() => undefined)),
    )
    options.onProgress?.(Math.min(i + BATCH, files.length), files.length)
  }
  if (items.length >= MAX_UPGRADE_ITEMS) {
    items.push({
      file: '',
      line: 0,
      code: '',
      kind: 'must_migrate',
      message: `…条目过多，仅列出前 ${MAX_UPGRADE_ITEMS} 条，请先处理后再重新生成`,
      suggestion: '',
    })
  }

  return {
    meta: {
      projectName: options.projectName,
      generatedAt: Date.now(),
      fileCount: files.length,
      fromVersion,
      toVersion,
    },
    mustFixCount,
    newFieldCount,
    items,
  }
}

/** 升级报告 → 纯文本（导出/分享；全部相对路径，脱敏） */
export function upgradeReportToText(r: UpgradeReport): string {
  const lines: string[] = []
  lines.push(`铁锈助手 · 版本升级改动清单`)
  lines.push(`项目：${r.meta.projectName}`)
  lines.push(`生成时间：${new Date(r.meta.generatedAt).toLocaleString()}`)
  lines.push(`升级方向：${r.meta.fromVersion} → ${r.meta.toVersion}`)
  lines.push(`扫描 ${r.meta.fileCount} 个 ini/template 文件 · 必须处理 ${r.mustFixCount} 处弃用字段 · 新增字段引用 ${r.newFieldCount} 处`)
  lines.push('')
  if (r.items.length === 0) {
    lines.push('未发现需要处理的版本差异 ✓')
    return lines.join('\n')
  }
  lines.push('── 改动清单 ──')
  for (const it of r.items) {
    const loc = it.file ? `${it.file}:${it.line}` : ''
    const tag = it.kind === 'must_migrate' ? '必须处理' : '可选用'
    lines.push(`[${tag}] ${loc} ${it.message}（建议：${it.suggestion}）`)
  }
  return lines.join('\n')
}
