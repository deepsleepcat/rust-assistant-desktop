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

/** 逻辑布尔函数（VSCode 插件 logicboolean.json：138 条 self.xxx() 方法/关键字） */
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
/** M27-2：dialect 逻辑语法 token 独立列表（编辑器逻辑值补全用；重载时重建） */
let dialectWords: VocabularyItem[] = []
let logicBooleans: LogicBooleanInfo[] = []
let officialUnits: OfficialUnitInfo[] = []
let gameVersions: GameVersionInfo[] = []
const enToZhDict = new Map<string, string>()
const zhToEnDict = new Map<string, string>()
/** 键名回译表（code.json 译名 → 键名）：键位置回译优先查。
 * 键译名可能被节名/旧词条译名撞车覆盖（曾出现虚构节 prices 把「价格」→price
 * 覆盖成 prices，导致中文键「价格」被 checkKeyTypos 误报「不在代码表中」；
 * 知识包旧数据同样可能带坏数据）。键位置回译（lint/补全/质检/版本差异）
 * 需要得到代码表里存在的键，先查本表保证命中；查不到再回落通用词典。 */
const keyZhToEnDict = new Map<string, string>()
/** 节名回译表（section.json 译名 → 节名）：节名位置回译（sectionEnName）优先查。
 * 节名译名与代码表键译名可能撞车（炮塔→节 turret vs 键 c_turret_t1）——
 * 节位置必须得到节名，与键位置的 keyZhToEnDict 分开，互不覆盖。 */
const sectionZhToEnDict = new Map<string, string>()

/** 已初始化的数据（未加载前为空） */
export function dataReady(): boolean {
  return loaded !== null
}

async function fetchJson<T>(name: string): Promise<T> {
  // M18：Electron 环境优先读「知识包」数据（已更新 → 更新版，否则内置 public/data）；
  // 浏览器预览/测试环境没有 knowledge 桥 → 回退 fetch 内置资源
  try {
    const { getBridge } = await import('./bridge')
    const kp = getBridge().knowledge
    if (kp) {
      const res = await kp.readDataFile(name)
      return JSON.parse(res.content) as T
    }
  } catch {
    // 读失败（更新包损坏等）回退内置 fetch，不阻塞编辑器
  }
  const base = import.meta.env.BASE_URL || '/'
  const res = await fetch(`${base}data/${name}`)
  if (!res.ok) throw new Error(`加载数据失败：${name} (${res.status})`)
  return (await res.json()) as T
}

/** 重载全部数据（值类型管理保存自定义类型后调用：清缓存重新加载，补全/lint 立即生效）。
 * 旧索引一并清空：重载失败时不残留「新旧混合」的半加载状态（下次成功加载前查询返回空）。 */
export function reloadCodeData(): void {
  loaded = null
  codes = []
  sections = []
  valueTypes = []
  enToZhDict.clear()
  zhToEnDict.clear()
  keyZhToEnDict.clear()
  sectionZhToEnDict.clear()
  vocabulary = []
  dialectWords = []
  logicBooleans = []
  officialUnits = []
  gameVersions = []
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
        const [codeRaw, sectionRaw, valueRaw, transRaw, vocabRaw, logicRaw, unitsRaw, versionRaw, dialectRaw] = await Promise.all([
          fetchJson<RawDataset>('code.json'),
          fetchJson<RawDataset>('section.json'),
          fetchJson<RawDataset>('value_type.json'),
          fetchJson<RawDataset>('translations.json'),
          fetchJson<RawDataset>('vocabulary.json'),
          fetchJson<RawDataset>('logicboolean.json').catch(() => ({ data: [] })),
          fetchJson<RawDataset>('units.json').catch(() => ({ data: [] })),
          fetchJson<RawDataset>('game_version.json').catch(() => ({ data: [] })),
          fetchJson<RawDataset>('dialect.json').catch(() => ({ words: [] }) as RawDataset),
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

        // M18：知识包更新/回滚后重载时，旧数据独有的词条必须清掉——
        // 只 set 不 clear 会让已删除字段的翻译/回译残留，造成「数据说没有这个
        // 字段，翻译却认得它」的不一致
        enToZhDict.clear()
        zhToEnDict.clear()
        keyZhToEnDict.clear()
        sectionZhToEnDict.clear()
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
            keyZhToEnDict.set(c.translate, c.code.toLowerCase())
          }
        }
        // 节名（[core]→[核心] 等）必须进词典，否则中文模式下节头不翻译。
        // 节名译名无条件覆盖（节头回译需要节名优先：炮塔→turret 而非代码表键
        // c_turret_t1）；键位置回译先查 keyZhToEnDict（键名表，见上），查不到才
        // 回落通用词典（此时得到节名/旧词条译名，如「核心」当键用→core）。
        for (const s of sections) {
          if (s.code && s.translate) {
            enToZhDict.set(s.code.toLowerCase(), s.translate)
            zhToEnDict.set(s.translate, s.code.toLowerCase())
            sectionZhToEnDict.set(s.translate, s.code.toLowerCase())
          }
        }
        vocabulary = vocab
        // M26-2：dialect 逻辑语法 token（独立数据文件，防知识包更新整文件覆盖）并入词库；
        // 带 zh 的条目同时进翻译词典——enToZh 与 zhToEn 双侧 has 守卫：
        // 不覆盖既有翻译（曾发现 zhToEn 单侧覆盖把 withTag→「有标签」改写成 hasTags、
        // self.timeAlive→「存活时间」改写成 timeAlive，破坏补全/lint 回译）。
        // 通用单字母/数学函数/高碰撞普通词（z/cos/ground/kills…）只有说明没有 zh，
        // 不进词典防污染显示层
        const dialectWordsRaw = (dialectRaw.words ?? dialectRaw.data ?? []) as Array<{ word?: string; zh?: string; explanation?: string }>
        // 重载（知识包更新/回滚）时重建独立列表，避免旧数据残留。
        // 大小写去重（teamId/teamid 同词）：保留带 zh 的条目（翻译不丢）
        const seenDialect = new Map<string, { word: string; zh?: string; explanation?: string }>()
        for (const d of dialectWordsRaw) {
          if (!d.word) continue
          const key = d.word.toLowerCase()
          const prev = seenDialect.get(key)
          if (!prev || (!prev.zh && d.zh)) seenDialect.set(key, { word: d.word, zh: d.zh, explanation: d.explanation })
        }
        dialectWords = []
        for (const d of seenDialect.values()) {
          const item = { word: d.word, explanation: d.explanation ?? d.word }
          vocabulary = [...vocabulary, item]
          dialectWords = [...dialectWords, item]
          if (d.zh && !enToZhDict.has(d.word.toLowerCase()) && !zhToEnDict.has(d.zh)) {
            enToZhDict.set(d.word.toLowerCase(), d.zh)
            zhToEnDict.set(d.zh, d.word.toLowerCase())
          }
        }
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

/** 获取键名回译表快照（键位置回译优先查：见 keyZhToEnDict 注释） */
export function getKeyZhToEnDict(): Map<string, string> {
  return keyZhToEnDict
}

/** 获取节名回译表快照（节名位置回译优先查：见 sectionZhToEnDict 注释） */
export function getSectionZhToEnDict(): Map<string, string> {
  return sectionZhToEnDict
}

/** 中文键分段回译（建造自_1_名称 → builtFrom_1_name）：
 * 中文显示层的宏字段键是分段翻译结果，查代码表/值类型前先按 _ 分段回译。 */
export function zhToEnKeySegments(key: string): string {
  return key
    .split('_')
    .map((seg) => zhToEnDict.get(seg) ?? seg)
    .join('_')
}

/** 节名归一化（补全/lint 查当前节键用）：
 * 中文段经节名词典优先回译（[炮塔_1] → turret_1），编号节去掉 _N 后缀；
 * 已知 needName 节允许用户命名后缀（[turret_main] → turret），未知节不猜测归类。 */
export function normalizeSectionName(section: string): string {
  const en = section
    .split('_')
    .map((seg) => sectionZhToEnDict.get(seg) ?? zhToEnDict.get(seg) ?? seg)
    .join('_')
    .toLowerCase()
  const namedBase = sections.find((s) => s.needName && en.startsWith(`${s.code.toLowerCase()}_`))
  return namedBase?.code.toLowerCase() ?? en
}

/** 按节查询代码（节为 all 时全局适用；英文 code 或中文 translate 匹配）。
 * 中文显示层传入的中文节名（如「核心」）与编号节（[turret_1]）都会先归一化。 */
export function findCodesBySection(section: string, query: string, limit = 40): CodeInfo[] {
  const q = query.trim().toLowerCase()
  const enSection = normalizeSectionName(section)
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

/** 按节英文 code 或中文译名模糊查节。
 * 用户手写编号/命名节前缀（[turret_1] / [炮塔_主炮]）时按已知基础节兜底，
 * 让 needName 节候选仍能出现；未知节名不强行归类。 */
export function findSectionsByQuery(query: string, limit = 40): SectionInfo[] {
  const raw = query.trim()
  const q = raw.toLowerCase()
  const normalized = normalizeSectionName(raw)
  const base = normalized !== q ? normalized : q.replace(/_\d+$/, '')
  const list = sections.filter((s) => {
    const code = s.code.toLowerCase()
    return (
      code.includes(q) ||
      s.translate.includes(raw) ||
      (base !== q && (code.includes(base) || (s.needName && base === code)))
    )
  })
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
  return findValueTypes(type)[0]
}

/** 多值类型合并查询（float,logicBoolean → 全部命中段的值类型）：
 * 补全按 lint 的 OR 语义合并所有命中的 list/directives，而不是只取第一段
 * （否则 float,logicBoolean 字段会丢掉 true/false/@type(...) 候选）。 */
export function findValueTypes(type: string): ValueTypeInfo[] {
  const direct = valueTypes.find((v) => v.type === type)
  if (direct) return [direct]
  const lower = type.toLowerCase()
  const ci = valueTypes.find((v) => v.type.toLowerCase() === lower)
  if (ci) return [ci]
  const hits: ValueTypeInfo[] = []
  for (const seg of type.split(',')) {
    const t = seg.trim()
    if (!t) continue
    const hit = valueTypes.find((v) => v.type === t) ?? valueTypes.find((v) => v.type.toLowerCase() === t.toLowerCase())
    if (hit && !hits.includes(hit)) hits.push(hit)
  }
  return hits
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

/** M27-2：dialect 逻辑语法 token（谓词/调试函数/记忆关键词等）。
 * 编辑器逻辑值补全专用——与 searchVocabulary 不同：无词条时返回空（降级），
 * 不做全词库兜底（逻辑值位置不该出现普通词库词）。 */
export function getDialectWords(query = '', limit = 30): VocabularyItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return dialectWords.slice(0, limit)
  return dialectWords
    .filter((v) => v.word.toLowerCase().includes(q) || v.explanation.toLowerCase().includes(q))
    .slice(0, limit)
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
