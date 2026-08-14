/**
 * 代码数据服务：加载 public/data/ 下的数据库与旧版词库，
 * 构建内存索引（键/节/值类型/翻译词典/词库），供补全、翻译、高亮使用。
 *
 * 数据来源：
 * - code.json       1130 条代码键（英文键/中文译名/说明/值类型/所属节）
 * - section.json    30 个节
 * - value_type.json 66 种值类型（补全规则、合法值列表）
 * - translations.json 旧版 758 条 en↔zh 翻译对
 * - vocabulary.json 旧版 1759 条 词库（word+explanation）
 */
import type { Completion } from '@codemirror/autocomplete'

export interface CodeInfo {
  code: string
  translate: string
  description: string
  type: string
  addVersion?: number
  removeVersion?: number
  section: string
  demo?: string
}

export interface SectionInfo {
  code: string
  translate: string
  needName?: boolean
}

export interface ValueTypeInfo {
  name: string
  type: string
  rule?: string
  external?: string
  offset?: string
  list?: string
  tag?: string
  describe?: string
}

export interface VocabularyItem {
  word: string
  explanation: string
}

/** 逻辑布尔函数（VSCode 插件 logicboolean.json：139 条 self.xxx() 方法/关键字） */
export interface LogicBooleanInfo {
  name: string
  type: string
  description?: string
  example?: string
}

/** 官方单位（scripts/extract-game-data.mjs 从游戏 assets/units 提取） */
export interface OfficialUnitInfo {
  name: string
  displayKey: string
  zhName?: string
  zhDesc?: string
  icon?: string
}

/** 游戏版本（game_version.json）：versionNumber 是 code.json addVersion/removeVersion 的取值 */
export interface GameVersionInfo {
  versionName: string
  versionNumber: number
}

interface RawDataset {
  name?: string
  data?: unknown[]
  /** translations.json / vocabulary.json 用的是 words 顶层键 */
  words?: unknown[]
}

let loaded: Promise<void> | null = null
let codes: CodeInfo[] = []
let sections: SectionInfo[] = []
let valueTypes: ValueTypeInfo[] = []
let vocabulary: VocabularyItem[] = []
let logicBooleans: LogicBooleanInfo[] = []
let officialUnits: OfficialUnitInfo[] = []
let gameVersions: GameVersionInfo[] = []
const enToZhDict = new Map<string, string>()
const zhToEnDict = new Map<string, string>()

/** 已初始化的数据（未加载前为空） */
export function dataReady(): boolean {
  return loaded !== null
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`加载数据失败：${url} (${res.status})`)
  return (await res.json()) as T
}

/** 重载全部数据（值类型管理保存自定义类型后调用：清缓存重新加载，补全/lint 立即生效） */
export function reloadCodeData(): void {
  loaded = null
}

/** 从本地存储读取用户自定义值类型（M8 值类型管理 UI 保存，store key: customValueTypes） */
async function loadCustomValueTypes(): Promise<ValueTypeInfo[]> {
  try {
    const { getBridge } = await import('./bridge')
    const raw = await getBridge().store.get('customValueTypes')
    if (!Array.isArray(raw)) return []
    const out: ValueTypeInfo[] = []
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const v = item as Partial<ValueTypeInfo>
        if (typeof v.type === 'string' && v.type.trim()) {
          out.push({
            name: v.type.trim(),
            type: v.type.trim(),
            rule: typeof v.rule === 'string' ? v.rule : undefined,
            list: typeof v.list === 'string' ? v.list : undefined,
            external: typeof v.external === 'string' ? v.external : undefined,
            describe: typeof v.describe === 'string' ? v.describe : undefined,
          })
        }
      }
    }
    return out
  } catch {
    return []
  }
}

/** 加载全部数据并构建索引（幂等，内存缓存；失败时降级为空词典，不阻塞编辑器） */
export function loadCodeData(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const base = import.meta.env.BASE_URL || '/'
        const [codeRaw, sectionRaw, valueRaw, transRaw, vocabRaw, logicRaw, unitsRaw, versionRaw] = await Promise.all([
          fetchJson<RawDataset>(`${base}data/code.json`),
          fetchJson<RawDataset>(`${base}data/section.json`),
          fetchJson<RawDataset>(`${base}data/value_type.json`),
          fetchJson<RawDataset>(`${base}data/translations.json`),
          fetchJson<RawDataset>(`${base}data/vocabulary.json`),
          fetchJson<RawDataset>(`${base}data/logicboolean.json`).catch(() => ({ data: [] })),
          fetchJson<RawDataset>(`${base}data/units.json`).catch(() => ({ data: [] })),
          fetchJson<RawDataset>(`${base}data/game_version.json`).catch(() => ({ data: [] })),
        ])

        codes = (codeRaw.data ?? []) as CodeInfo[]
        sections = (sectionRaw.data ?? []) as SectionInfo[]
        valueTypes = (valueRaw.data ?? []) as ValueTypeInfo[]
        // M8：合并用户自定义值类型（内置优先；自定义类型驱动补全/lint 规则）
        const customTypes = await loadCustomValueTypes()
        if (customTypes.length > 0) valueTypes = [...valueTypes, ...customTypes]
        // translations/vocabulary 的顶层键是 words（不是 data），两边都兼容
        const translations = (transRaw.words ?? transRaw.data ?? []) as Array<{ en?: string; zh?: string }>
        const vocab = (vocabRaw.words ?? vocabRaw.data ?? []) as VocabularyItem[]

        // 翻译词典构建顺序：先并入补充词条（translations.json），
        // 再并入主数据（code.json / section.json）——主数据优先，
        // 防止补充词条里的垃圾值覆盖正确翻译。
        // zhToEn 值统一小写：回译落盘时不带词典原文大小写（避免保存把文件里的
        // Image ↔ image 悄悄改掉，与 enToZh 的小写索引对称）。
        for (const t of translations) {
          if (t.en && t.zh) {
            enToZhDict.set(t.en.toLowerCase(), t.zh)
            zhToEnDict.set(t.zh, t.en.toLowerCase())
          }
        }
        for (const c of codes) {
          if (c.code && c.translate) {
            enToZhDict.set(c.code.toLowerCase(), c.translate)
            zhToEnDict.set(c.translate, c.code.toLowerCase())
          }
        }
        // 节名（[core]→[核心] 等）必须进词典，否则中文模式下节头不翻译
        for (const s of sections) {
          if (s.code && s.translate) {
            enToZhDict.set(s.code.toLowerCase(), s.translate)
            zhToEnDict.set(s.translate, s.code.toLowerCase())
          }
        }
        vocabulary = vocab
        logicBooleans = (logicRaw.data ?? []) as LogicBooleanInfo[]
        officialUnits = (unitsRaw.data ?? []) as OfficialUnitInfo[]
        gameVersions = ((versionRaw.data ?? []) as GameVersionInfo[]).sort((a, b) => a.versionNumber - b.versionNumber)
      } catch (err) {
        // 数据不可用（如离线/测试环境）时降级：编辑器仍可用，只是没有补全和翻译。
        // 失败后置回 null，允许下次 loadCodeData 重试（避免一次抖动导致整个会话失去补全/翻译）
        loaded = null
        console.warn('[codeData] 数据加载失败，补全与翻译不可用（下次调用会重试）', err)
      }
    })()
  }
  return loaded
}

/** 获取英文→中文词典快照（供纯函数翻译使用） */
export function getEnToZhDict(): Map<string, string> {
  return enToZhDict
}

/** 获取中文→英文词典快照 */
export function getZhToEnDict(): Map<string, string> {
  return zhToEnDict
}

/** 中文键分段回译（建造自_1_名称 → builtFrom_1_name）：
 * 中文显示层的宏字段键是分段翻译结果，查代码表/值类型前先按 _ 分段回译。 */
export function zhToEnKeySegments(key: string): string {
  return key
    .split('_')
    .map((seg) => zhToEnDict.get(seg) ?? seg)
    .join('_')
}

/** 当前行所属节（向上扫描最近的 [xxx]） */
export function getSectionOfLine(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const m = /^\s*\[(.+?)\]\s*$/.exec(lines[i])
    if (m) return m[1]
  }
  return ''
}

/** 按节查询代码（节为 all 时全局适用；英文 code 或中文 translate 匹配）。
 * 中文显示层传入的中文节名（如「核心」）先经词典回译成英文（core）再匹配。 */
export function findCodesBySection(section: string, query: string, limit = 40): CodeInfo[] {
  const q = query.trim().toLowerCase()
  const enSection = zhToEnDict.get(section) ?? section
  const matchSection = (c: CodeInfo) => c.section === 'all' || (c.section ?? '').split(',').includes(enSection)
  const list = codes.filter((c) => matchSection(c) && (c.code.toLowerCase().includes(q) || c.translate.includes(query.trim())))
  return list.slice(0, limit)
}

/** 按英文键或中文译名模糊查代码 */
export function findCodesByQuery(query: string, limit = 40): CodeInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return codes.slice(0, limit)
  const list = codes.filter((c) => c.code.toLowerCase().includes(q) || c.translate.includes(query.trim()))
  return list.slice(0, limit)
}

/** 按 code 精确查（用于值类型解析） */
export function findCodeByCode(code: string): CodeInfo | undefined {
  const lower = code.toLowerCase()
  return codes.find((c) => c.code.toLowerCase() === lower)
}

/** 按值类型查代码（@type(x) 关联联想用，对齐手机版 findCodeByCodeInType）：
 * type 逗号分段含目标类型；code/translate 可按关键字模糊过滤。 */
export function findCodesByType(type: string, query = '', limit = 40): CodeInfo[] {
  const target = type.trim().toLowerCase()
  const q = query.trim().toLowerCase()
  const list = codes.filter((c) => {
    const types = (c.type ?? '').split(',').map((t) => t.trim().toLowerCase())
    if (!types.includes(target)) return false
    if (!q) return true
    return c.code.toLowerCase().includes(q) || c.translate.includes(query.trim())
  })
  return list.slice(0, limit)
}

/** 按节英文 code 或中文译名模糊查节 */
export function findSectionsByQuery(query: string, limit = 40): SectionInfo[] {
  const q = query.trim().toLowerCase()
  const list = sections.filter((s) => s.code.toLowerCase().includes(q) || s.translate.includes(query.trim()))
  return list.slice(0, limit)
}

/** 全部节（按 code 排序），供代码表浏览 */
export function getAllSections(): SectionInfo[] {
  return [...sections].sort((a, b) => a.code.localeCompare(b.code))
}

/** 全部代码（按 code 排序），供代码表浏览 */
export function getAllCodes(): CodeInfo[] {
  return [...codes].sort((a, b) => a.code.localeCompare(b.code))
}

/** 全部值类型（内置 + 用户自定义，按 type 排序），供值类型管理浏览 */
export function getAllValueTypes(): ValueTypeInfo[] {
  return [...valueTypes].sort((a, b) => a.type.localeCompare(b.type))
}

/** 读取用户自定义值类型（供值类型管理 UI 编辑；与加载时合并逻辑同源） */
export async function getCustomValueTypes(): Promise<ValueTypeInfo[]> {
  return loadCustomValueTypes()
}

/** 保存用户自定义值类型（整体覆盖写入本地存储） */
export async function saveCustomValueTypes(list: ValueTypeInfo[]): Promise<void> {
  const { getBridge } = await import('./bridge')
  await getBridge().store.set('customValueTypes', list)
  reloadCodeData()
}

/** 全部官方单位（scripts/extract-game-data.mjs 从游戏提取，按 name 排序） */
export function getAllOfficialUnits(): OfficialUnitInfo[] {
  return [...officialUnits]
}

/** 按中文节名查节（翻译用） */
export function findSectionByTranslate(translate: string): SectionInfo | undefined {
  return sections.find((s) => s.translate === translate || s.code === translate)
}

/** 全部游戏版本（按 versionNumber 升序），供版本兼容设置/悬停展示 */
export function getGameVersions(): GameVersionInfo[] {
  return [...gameVersions]
}

/** 版本名 → versionNumber（未知/空返回 undefined；空字符串视为「跟随最新」） */
export function versionNameToNumber(name: string | undefined): number | undefined {
  if (!name) return undefined
  const hit = gameVersions.find((v) => v.versionName.toLowerCase() === name.trim().toLowerCase())
  return hit?.versionNumber
}

/** versionNumber → 版本名（未知返回 undefined） */
export function versionNumberToName(number: number): string | undefined {
  return gameVersions.find((v) => v.versionNumber === number)?.versionName
}

/** 最新版本号（版本检查器的默认目标；数据缺失时返回 undefined → 检查跳过） */
export function latestVersionNumber(): number | undefined {
  if (gameVersions.length === 0) return undefined
  return gameVersions[gameVersions.length - 1].versionNumber
}

/** 离线知识包数据版本信息（M16，任务 6）：设置页「关于」展示 + 数据一致性校验 */
export interface DataVersionInfo {
  /** 代码表是否已加载（离线数据可用性） */
  loaded: boolean
  /** 代码表条数 */
  codeCount: number
  /** 游戏版本表条数 */
  versionCount: number
  /** 最新游戏版本名 */
  latestVersionName: string | undefined
  /** 最新游戏版本号 */
  latestVersionNumber: number | undefined
  /** 代码表字段的最大加入版本号 */
  maxAddVersion: number | undefined
  /** 一致性：所有字段的加入版本 ≤ 版本表最新版本（无「孤儿字段」）；
   * undefined = 无法判定（代码表或版本表缺失） */
  consistent: boolean | undefined
}

/** 数据版本信息（离线可用性 + 数据与游戏版本对应关系） */
export function getDataVersionInfo(): DataVersionInfo {
  let maxAddVersion: number | undefined
  for (const c of codes) {
    if (typeof c.addVersion === 'number' && (maxAddVersion === undefined || c.addVersion > maxAddVersion)) {
      maxAddVersion = c.addVersion
    }
  }
  const latest = latestVersionNumber()
  return {
    loaded: loaded !== null,
    codeCount: codes.length,
    versionCount: gameVersions.length,
    latestVersionName: latest !== undefined ? versionNumberToName(latest) : undefined,
    latestVersionNumber: latest,
    maxAddVersion,
    // 代码表或版本表缺失时无法判定（避免在无版本表时误报「一致」）
    consistent: maxAddVersion === undefined || latest === undefined ? undefined : maxAddVersion <= latest,
  }
}

/** 按值类型 type 查（大小写不敏感 + 逗号分段：数据里 LogicBoolean/bool 大小写不一致、
 * 'float,logicBoolean' 等多值 type 也能命中其中任一段） */
export function findValueType(type: string): ValueTypeInfo | undefined {
  const direct = valueTypes.find((v) => v.type === type)
  if (direct) return direct
  const lower = type.toLowerCase()
  const ci = valueTypes.find((v) => v.type.toLowerCase() === lower)
  if (ci) return ci
  // 多值 type（'float,logicBoolean'）：任一段匹配即用该段的值类型
  for (const seg of type.split(',')) {
    const t = seg.trim()
    if (!t) continue
    const hit = valueTypes.find((v) => v.type === t) ?? valueTypes.find((v) => v.type.toLowerCase() === t.toLowerCase())
    if (hit) return hit
  }
  return undefined
}

/** 值类型合法值列表（解析逗号分隔，含特殊指令 @xxx） */
export function parseValueList(list: string | undefined): string[] {
  if (!list) return []
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('@'))
}

/** 逻辑布尔函数：按名精确查（self.xxx() 悬停/补全用） */
export function findLogicBoolean(name: string): LogicBooleanInfo | undefined {
  return logicBooleans.find((l) => l.name === name)
}

/** 逻辑布尔函数：前缀模糊查（self. 补全候选） */
export function searchLogicBooleans(query: string, limit = 30): LogicBooleanInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return logicBooleans.slice(0, limit)
  return logicBooleans.filter((l) => l.name.toLowerCase().includes(q)).slice(0, limit)
}

/** 词库：按 word 模糊匹配（旧版 fuzzy 思路：位置越靠前、长度差越小分越高） */
export function searchVocabulary(query: string, limit = 20): VocabularyItem[] {  const q = query.trim().toLowerCase()
  if (!q) return vocabulary.slice(0, limit)
  const scored: Array<{ item: VocabularyItem; score: number }> = []
  for (const item of vocabulary) {
    const word = item.word.toLowerCase()
    const pos = word.indexOf(q)
    if (pos < 0) continue
    let score = 100 - pos * 2 - Math.abs(word.length - q.length) * 2
    if (word === q) score += 50
    scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.item)
}

/** 生成补全候选的通用描述 */
export function codeInfoToCompletion(c: CodeInfo, commitSuffix = ''): Completion {
  return {
    label: c.translate ? `${c.code} · ${c.translate}` : c.code,
    detail: c.description || undefined,
    type: 'property',
    apply: c.code + commitSuffix,
  }
}

/** 按值类型补全（自动追加 external 符号，如 name: ） */
export function valueTypeCompletion(c: CodeInfo): Completion {
  const vt = findValueType(c.type)
  return codeInfoToCompletion(c, vt?.external ?? '')
}
