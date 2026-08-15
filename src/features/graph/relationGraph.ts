/**
 * 模组关系图数据（M20，P2 任务 4）：单位 → 图片/音效/弹体/炮塔引用关系。
 *
 * - 每个单位文件（含 [core] 节）提取引用边：图片/音效按扩展名（与质量报告统计
 *   同一套扩展名），弹体单位引用按 builtFrom_N_name/requiredUnit/convertTo 等
 *   （与 checkRiskyUnitReferenceSemantics 同一套键）；
 * - 缺失标记：图片/音效路径不在项目文件清单 → 悬空引用（红色）；
 *   ROOT:/CUSTOM:/SHARED: 前缀 = 跨模组引用（存在性无法在本项目验证，标橙不标红）；
 * - 与质量报告数据同源（scanResources），保证统计一致。
 */
import { parseIni, sectionEnName, toEnKey } from '../editor/semanticChecks/helpers'
import { BUILTIN_UNITS } from '../editor/semanticChecks/helpers'
import { joinProjectPath } from '../../utils/projectPath'

export type RefKind = 'image' | 'audio' | 'unit' | 'turret'

/** 单条引用边（同一引用出现在多行时合并，lines 全部保留供跳转） */
export interface RefEdge {
  kind: RefKind
  /** 引用目标：资源相对路径 / 单位名 / turret_N */
  target: string
  /** 引用行号（1 基；跳转取第一个） */
  lines: number[]
  /** 目标不存在（悬空引用，图上红色） */
  missing: boolean
  /** 跨模组引用（ROOT:/CUSTOM:/SHARED: 前缀；存在性无法验证，橙色） */
  crossMod: boolean
}

export interface UnitNode {
  /** 相对项目根的 posix 路径（脱敏） */
  file: string
  /** [core] name（缺失时回退文件名） */
  name: string
  refs: RefEdge[]
}

export interface MissingRef {
  file: string
  line: number
  kind: RefKind
  ref: string
}

export interface CrossModRef {
  ref: string
  kind: RefKind
  count: number
  /** 引用样例（文件:行） */
  samples: string[]
}

export interface RelationGraphData {
  units: UnitNode[]
  missingRefs: MissingRef[]
  crossModRefs: CrossModRef[]
  /** 全部引用边数（含缺失/跨模组） */
  totalRefs: number
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const AUDIO_EXTS = new Set(['.ogg', '.wav', '.mp3', '.flac'])
/** 引用单位的键（小写；与 checkRiskyUnitReferenceSemantics 一致） */
const UNIT_REF_KEYS = new Set(['requiredunit', 'convertto', 'spawnunit', 'spawnunits'])
/** 游戏特殊值（单位引用不检查存在性） */
const SPECIAL_UNIT_VALUES = new Set(['none', 'ignore', 'auto', 'this', 'self'])
/** 跨模组前缀（值以这些前缀开头 = 引用其他模组/游戏内置资源） */
const CROSS_MOD_PREFIXES = ['root:', 'custom:', 'shared:']
/** 单文件检查上限（防超大文件拖慢） */
const MAX_FILE_CHARS = 2 * 1024 * 1024

/** 从值里提取资源路径 token（多帧 a.png;b.png、逗号/空格分隔都拆开） */
function extractPathTokens(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith('${') && !s.includes('${')) // 变量引用跳过
}

/** 按扩展名分类资源路径（非资源路径返回 null） */
function classifyPath(token: string): RefKind | null {
  const dot = token.lastIndexOf('.')
  if (dot < 0) return null
  const ext = token.slice(dot).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return null
}

export interface RelationGraphOptions {
  /** 进度回调（已扫描文件数/总数） */
  onProgress?: (done: number, total: number) => void
}

/** 构建关系图（bridge 依赖注入；缺省从桥服务读取） */
export async function buildRelationGraph(
  rootPath: string,
  options: RelationGraphOptions = {},
  bridgeOverride?: { mod: { scanResources(root: string): Promise<{ files: string[]; unitNames: string[] }> }; project: { readFile(root: string, file: string): Promise<{ content: string }> } },
): Promise<RelationGraphData> {
  const bridge = bridgeOverride ?? (await import('../../services/bridge')).getBridge()
  const scan = await bridge.mod.scanResources(rootPath)
  const files = scan.files ?? []
  const iniFiles = files.filter((f) => /\.(ini|template)$/i.test(f))
  const fileSet = new Set(files.map((f) => f.toLowerCase()))
  const unitNames = new Set((scan.unitNames ?? []).map((n) => n.toLowerCase()))

  const units: UnitNode[] = []
  const missingRefs: MissingRef[] = []
  const crossModMap = new Map<string, CrossModRef>()

  async function scanOne(file: string): Promise<void> {
    // bridge fs 通道要求项目内绝对路径（相对路径会被主进程拒绝）
    const content = await bridge.project.readFile(rootPath, joinProjectPath(rootPath, file)).then((r) => r.content).catch(() => '')
    if (!content || content.length > MAX_FILE_CHARS) return
    const ini = parseIni(content)
    // 单位判定：存在 [core] 节（名称缺失回退文件名——名称缺失本身由检查器报）
    const core = ini.sections.find((s) => sectionEnName(s, undefined) === 'core')
    if (!core) return
    const name = core.kvs.find((kv) => toEnKey(kv.key, undefined).toLowerCase() === 'name')?.value.trim() || file.replace(/\\/g, '/').split('/').pop() || file
    const refs = new Map<string, RefEdge>()

    const addRef = (kind: RefKind, target: string, line: number) => {
      const key = `${kind}\u0000${target.toLowerCase()}`
      const existing = refs.get(key)
      if (existing) {
        if (!existing.lines.includes(line)) existing.lines.push(line)
        return
      }
      const crossMod = CROSS_MOD_PREFIXES.some((p) => target.toLowerCase().startsWith(p))
      const cleanTarget = crossMod ? target : target
      let missing = false
      if (!crossMod) {
        if (kind === 'image' || kind === 'audio') {
          // 资源路径：文件清单里存在才算存在（大小写不敏感 + 反斜杠归一化——
          // Windows 用户可能写 images\rifle.png，scanResources 返回正斜杠）
          missing = !fileSet.has(target.replace(/\\/g, '/').toLowerCase())
        } else if (kind === 'unit') {
          const lref = target.toLowerCase()
          missing = !(unitNames.has(lref) || BUILTIN_UNITS.has(lref) || SPECIAL_UNIT_VALUES.has(lref) || lref.startsWith('custom:'))
        } else {
          missing = false // turret 引用自身文件内，不标缺失
        }
      }
      refs.set(key, { kind, target: cleanTarget, lines: [line], missing, crossMod })
      if (missing) missingRefs.push({ file, line, kind, ref: cleanTarget })
      if (crossMod) {
        const ckey = `${kind}\u0000${cleanTarget.toLowerCase()}`
        const agg = crossModMap.get(ckey) ?? { ref: cleanTarget, kind, count: 0, samples: [] }
        agg.count++
        if (agg.samples.length < 5) agg.samples.push(`${file}:${line}`)
        crossModMap.set(ckey, agg)
      }
    }

    for (const section of ini.sections) {
      const secLower = sectionEnName(section, undefined)
      // 炮塔节：引用边（turret_N → 该节）
      const turretMatch = /^turret_(\d+)$/.exec(secLower)
      if (turretMatch) {
        addRef('turret', `turret_${turretMatch[1]}`, section.startLine)
      }
      for (const kv of section.kvs) {
        const enKey = toEnKey(kv.key, undefined)
        const lower = enKey.toLowerCase()
        // 图片/音效：值里的资源路径（按扩展名分类；NONE/AUTO 无扩展名自然跳过）
        for (const token of extractPathTokens(kv.value)) {
          const kind = classifyPath(token)
          if (kind) addRef(kind, token, kv.line)
        }
        // 单位引用：builtFrom_N_name + requiredUnit/convertTo/spawnUnit/spawnUnits
        const isBuiltFrom = /^builtfrom_\d+_name$/.test(lower)
        if (isBuiltFrom || UNIT_REF_KEYS.has(lower)) {
          for (const raw of kv.value.split(',')) {
            const ref = raw.trim()
            if (ref) addRef('unit', ref, kv.line)
          }
        }
      }
    }
    if (refs.size > 0) {
      units.push({ file, name, refs: [...refs.values()].map((r) => ({ ...r, lines: [...r.lines].sort((a, b) => a - b) })) })
    }
  }

  const BATCH = 6
  for (let i = 0; i < iniFiles.length; i += BATCH) {
    await Promise.all(iniFiles.slice(i, i + BATCH).map((f) => scanOne(f).catch(() => undefined)))
    options.onProgress?.(Math.min(i + BATCH, iniFiles.length), iniFiles.length)
  }

  units.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  missingRefs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const crossModRefs = [...crossModMap.values()].sort((a, b) => b.count - a.count)
  const totalRefs = units.reduce((sum, u) => sum + u.refs.length, 0)

  return { units, missingRefs, crossModRefs, totalRefs }
}
