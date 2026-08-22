/**
 * 代码数据服务：加载 public/data/ 下的数据库与旧版词库，
 * 构建内存索引（键/节/值类型/翻译词典/词库），供补全、翻译、高亮使用。
 *
 * 数据来源：
 * - code.json       1238 条代码键（英文键/中文译名/说明/值类型/所属节）
 * - section.json    32 个节
 * - value_type.json 87 种值类型（补全规则、合法值列表）
 * - value_zh.json   枚举值中文词典（补全/悬浮时给英文枚举值配中文解释）
 * - aliases.json    字段别名（M35：旧字段名 → 现行字段名，按旧名也能搜到/悬停）
 * - translations.json 旧版 832 条 en↔zh 翻译对
 * - vocabulary.json 旧版 1759 条 词库（word+explanation）
 */
import type { Completion } from '@codemirror/autocomplete'
import { splitTopLevelConfigValue } from './configSyntax'

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

/** 枚举值中文词典（value_zh.json）：引擎枚举值 → 中文解释（补全 detail / 悬浮提示） */
interface RawValueZh {
  name?: string
  /** data 顶层是「值 → 中文」映射对象（区别于其它文件的数组） */
  data?: Record<string, string>
}

/** 字段别名（aliases.json）：旧字段名 → 现行字段名（搜索/悬停按旧名也能命中） */
interface AliasInfo {
  alias: string
  code: string
}

interface RawDataset {
  name?: string
  data?: unknown[]
  /** translations.json / vocabulary.json 用的是 words 顶层键 */
  words?: unknown[]
}

let loaded: Promise<void> | null = null
let loadGeneration = 0
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
/** M34：枚举值中文词典（value_zh.json：own→己方、BUILDING→建筑…）：
 * 补全值候选与悬浮提示给英文枚举值配中文解释（引擎值本身不可改） */
const valueZhDict = new Map<string, string>()
/** 枚举值反向词典（M38：中文值 → 英文枚举值）：己方→own、任意→any，
 * lint 校验时把中文枚举值回译成英文再匹配 value_type list。仅保留无歧义项。 */
const valueZhToEnDict = new Map<string, string>()
/** 枚举值反向候选（同一中文解释可能对应 any/X 等多个引擎值）。 */
const valueZhToEnCandidates = new Map<string, Set<string>>()
/** 逻辑 self 标识符中文别名 → 规范英文标识符。只收录唯一映射。 */
const logicIdentifierZhToEnDict = new Map<string, string>()
/** 逻辑 self 标识符英文 → 中文显示别名。 */
const logicIdentifierEnToZhDict = new Map<string, string>()
/** 值区不应走通用中文回译的字段（标签、名称、路径等自由值）。 */
const preserveValueKeys = new Set<string>()
/** 值区允许回译 self.xxx 的逻辑字段。 */
const logicValueKeys = new Set<string>()
/** 动态模板键（builtFrom_{NUM}_name、displayText_{LANG} 等）对应的自由值保护规则。 */
const preserveValueKeyPatterns: RegExp[] = []
/** M35：字段别名表（aliases.json：alias 小写 → 现行 code）。
 * 官方数据用 limitingAngle，旧代码表/教程用 turretlimitingAngle——
 * 按旧名搜索、悬停、补全都能解析到现行字段。 */
const aliasDict = new Map<string, string>()

function addUniqueReverse(
  map: Map<string, string>,
  ambiguous: Set<string>,
  owners: Map<string, number>,
  translated: string,
  english: string,
  priority: number,
): void {
  const alias = translated.trim()
  const canonical = english.trim()
  if (!alias || !canonical) return
  const previous = map.get(alias)
  const previousPriority = owners.get(alias) ?? 0
  if (ambiguous.has(alias)) {
    if (priority > previousPriority) {
      map.set(alias, canonical)
      ambiguous.delete(alias)
      owners.set(alias, priority)
    }
    return
  }
  if (!previous || previous === canonical) {
    map.set(alias, canonical)
    owners.set(alias, Math.max(previousPriority, priority))
    return
  }
  if (priority > previousPriority) {
    map.set(alias, canonical)
    owners.set(alias, priority)
    return
  }
  if (priority === previousPriority) {
    map.delete(alias)
    ambiguous.add(alias)
    owners.set(alias, priority)
  }
}

/** 已初始化的数据（未加载前为空） */
export function dataReady(): boolean {
  return loaded !== null
}

const CORE_CODE_KEYS = new Set([
  'autotrigger',
  'allowmultipleinqueue',
  'addwaypoint_type',
  'addwaypoint_target_nearestunit_tagged',
  'addwaypoint_target_nearestunit_team',
  'addwaypoint_target_nearestunit_maxrange',
])
const CORE_SECTION_KEYS = new Set(['hiddenaction', 'action', 'turret', 'projectile', 'effect'])
const CORE_VALUE_TYPES = new Set(['addwaypoint_type', 'addwaypoint_target_nearestunit_team'])
const CORE_VALUE_ZH = new Set(['move', 'attackmove', 'guard', 'loadinto', 'setpassivetarget'])

function parsedData(content: unknown): unknown[] | null {
  if (!content || typeof content !== 'object') return null
  const data = (content as { data?: unknown }).data
  return Array.isArray(data) ? data : null
}

function hasCoreCodeData(content: unknown, keys: Set<string>, field: 'code' | 'type'): boolean {
  const data = parsedData(content)
  if (!data) return false
  const label = field === 'code' ? 'translate' : 'name'
  const found = new Set(
    data
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
      .filter((item) => typeof item[field] === 'string' && typeof item[label] === 'string' && item[label].trim())
      .map((item) => (item[field] as string).toLowerCase()),
  )
  return [...keys].every((key) => found.has(key))
}

function hasCoreValueZh(content: unknown): boolean {
  if (!content || typeof content !== 'object') return false
  const data = (content as { data?: unknown }).data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const found = new Set(Object.keys(data as Record<string, unknown>).map((key) => key.toLowerCase()))
  return [...CORE_VALUE_ZH].every((key) => found.has(key))
}

function usableData(name: string, parsed: unknown): boolean {
  if (name === 'code.json') return hasCoreCodeData(parsed, CORE_CODE_KEYS, 'code')
  if (name === 'section.json') return hasCoreCodeData(parsed, CORE_SECTION_KEYS, 'code')
  if (name === 'value_type.json') return hasCoreCodeData(parsed, CORE_VALUE_TYPES, 'type')
  if (name === 'value_zh.json') return hasCoreValueZh(parsed)
  return true
}

async function fetchJson<T>(name: string): Promise<T> {
  // M18：Electron 环境优先读「知识包」数据；知识包已在主进程做核心字段门禁，
  // 这里再做一次 schema 门禁，防 mock/旧 preload 直接返回裁剪数据。
  try {
    const { getBridge } = await import('./bridge')
    const kp = getBridge().knowledge
    if (kp) {
      const res = await kp.readDataFile(name)
      const parsed = JSON.parse(res.content) as unknown
      if (usableData(name, parsed)) return parsed as T
    }
  } catch {
    // 读失败或数据不完整，回退内置 fetch
  }
  const base = import.meta.env.BASE_URL || '/'
  const res = await fetch(`${base}data/${name}`)
  if (!res.ok) throw new Error(`加载数据失败：${name} (${res.status})`)
  const parsed = (await res.json()) as unknown
  if (!usableData(name, parsed)) throw new Error(`数据文件不完整：${name}`)
  return parsed as T
}

/** 重载全部数据（值类型管理保存自定义类型后调用：清缓存重新加载，补全/lint 立即生效）。
 * 旧索引一并清空：重载失败时不残留「新旧混合」的半加载状态（下次成功加载前查询返回空）。 */
export function reloadCodeData(): void {
  loadGeneration++
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
  valueZhDict.clear()
  valueZhToEnDict.clear()
  valueZhToEnCandidates.clear()
  logicIdentifierZhToEnDict.clear()
  logicIdentifierEnToZhDict.clear()
  preserveValueKeys.clear()
  logicValueKeys.clear()
  preserveValueKeyPatterns.length = 0
  aliasDict.clear()
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
    const generation = loadGeneration
    loaded = (async () => {
      try {
        const [codeRaw, sectionRaw, valueRaw, valueZhRaw, transRaw, vocabRaw, logicRaw, unitsRaw, versionRaw, dialectRaw, aliasesRaw] = await Promise.all([
          fetchJson<RawDataset>('code.json'),
          fetchJson<RawDataset>('section.json'),
          fetchJson<RawDataset>('value_type.json'),
          fetchJson<RawValueZh>('value_zh.json').catch(() => ({ data: {} } as RawValueZh)),
          fetchJson<RawDataset>('translations.json'),
          fetchJson<RawDataset>('vocabulary.json'),
          fetchJson<RawDataset>('logicboolean.json').catch(() => ({ data: [] })),
          fetchJson<RawDataset>('units.json').catch(() => ({ data: [] })),
          fetchJson<RawDataset>('game_version.json').catch(() => ({ data: [] })),
          fetchJson<RawDataset>('dialect.json').catch(() => ({ words: [] }) as RawDataset),
          fetchJson<RawDataset>('aliases.json').catch(() => ({ data: [] })),
        ])
        // reloadCodeData() 可能在请求期间发生；旧代次不得再写入全局索引。
        if (generation !== loadGeneration) return

        const nextCodes = (codeRaw.data ?? []) as CodeInfo[]
        const nextSections = (sectionRaw.data ?? []) as SectionInfo[]
        const nextValueTypes = (valueRaw.data ?? []) as ValueTypeInfo[]
        // M8：合并用户自定义值类型（内置优先；自定义类型驱动补全/lint 规则）
        const customTypes = await loadCustomValueTypes()
        if (generation !== loadGeneration) return
        codes = nextCodes
        sections = nextSections
        valueTypes = customTypes.length > 0 ? [...nextValueTypes, ...customTypes] : nextValueTypes
        // translations/vocabulary 的顶层键是 words（不是 data），两边都兼容
        const translations = (transRaw.words ?? transRaw.data ?? []) as Array<{ en?: string; zh?: string }>
        const vocab = (vocabRaw.words ?? vocabRaw.data ?? []) as VocabularyItem[]
        // 枚举值中文词典（M34）：值 → 中文解释；重载时先清空再重建（知识包更新回滚同理）。
        // 反向侧保留全部候选，any/X 同译「任意」时由当前字段的 list 再消歧，
        // 不能静默固定为第一次读取到的值。
        valueZhDict.clear()
        valueZhToEnDict.clear()
        valueZhToEnCandidates.clear()
        const addValueAlias = (translated: string, english: string) => {
          const alias = translated.trim()
          if (!alias || !english) return
          const candidates = valueZhToEnCandidates.get(alias) ?? new Set<string>()
          candidates.add(english)
          valueZhToEnCandidates.set(alias, candidates)
        }
        for (const [val, zh] of Object.entries(valueZhRaw.data ?? {})) {
          if (!val || !zh) continue
          valueZhDict.set(val.toLowerCase(), zh)
          addValueAlias(String(zh), val)
          // 中文显示层主词典优先使用 code.json 的正式译名，例如 any →「任何」。
          // 将它也登记为枚举别名，让用户看到和手输的中文都能通过同一字段校验。
          const codeAlias = codes.find((code) => code.code.toLowerCase() === val.toLowerCase())
          if (codeAlias?.translate) addValueAlias(codeAlias.translate, val)
        }
        for (const [alias, candidates] of valueZhToEnCandidates) {
          if (candidates.size === 1) valueZhToEnDict.set(alias, [...candidates][0])
        }

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
        // 英文索引统一小写，但反向词典输出必须保留数据里的规范拼写。
        // 同一中文译名对应多个英文候选时删除映射，避免无 tracker 时随机选一个。
        const reverseAmbiguous = new Set<string>()
        const reverseOwners = new Map<string, number>()
        const keyReverseAmbiguous = new Set<string>()
        const keyReverseOwners = new Map<string, number>()
        for (const t of translations) {
          if (t.en && t.zh) {
            enToZhDict.set(t.en.toLowerCase(), t.zh)
            addUniqueReverse(zhToEnDict, reverseAmbiguous, reverseOwners, t.zh, t.en, 1)
          }
        }
        for (const c of codes) {
          if (c.code && c.translate) {
            enToZhDict.set(c.code.toLowerCase(), c.translate)
            addUniqueReverse(zhToEnDict, reverseAmbiguous, reverseOwners, c.translate, c.code, 2)
            addUniqueReverse(keyZhToEnDict, keyReverseAmbiguous, keyReverseOwners, c.translate, c.code, 2)
          }
        }
        // 节名（[core]→[核心] 等）必须进词典，否则中文模式下节头不翻译。
        // 节名译名无条件覆盖（节头回译需要节名优先：炮塔→turret 而非代码表键
        // c_turret_t1）；键位置回译先查 keyZhToEnDict（键名表，见上），查不到才
        // 回落通用词典（此时得到节名/旧词条译名，如「核心」当键用→core）。
        for (const s of sections) {
          if (s.code && s.translate) {
            enToZhDict.set(s.code.toLowerCase(), s.translate)
            addUniqueReverse(zhToEnDict, reverseAmbiguous, reverseOwners, s.translate, s.code, 3)
            sectionZhToEnDict.set(s.translate, s.code)
            // 中文损坏文件可能未经过 enToZh tracker：节头回译需要识别
            // 「隐藏行动_用户自定义名」这类已知前缀，并保留后缀。
            if (s.needName) sectionZhToEnDict.set(`${s.translate}_`, `${s.code}_`)
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
            addUniqueReverse(zhToEnDict, reverseAmbiguous, reverseOwners, d.zh, d.word, 0)
          }
        }
        logicBooleans = (logicRaw.data ?? []) as LogicBooleanInfo[]
        // self.xxx 只能按真实逻辑函数表回译。code.json 的完整 self 条目给出
        // 中文别名和规范大小写；短别名（自身血量 → 血量）仅在没有歧义时收录。
        const logicNames = new Set(
          logicBooleans
            .map((item) => item.name.trim().replace(/^self\./i, '').replace(/\(\)$/, '').toLowerCase())
            .filter(Boolean),
        )
        const logicAliases = new Map<string, string>()
        const ambiguousLogic = new Set<string>()
        const addLogicAlias = (translated: string, english: string) => {
          const alias = translated.trim()
          // self. 后只能接合法标识符；带前导短横线、点号或完整句子的旧译名
          // 保留英文显示，避免生成无法回译的非法表达式。
          if (!/^[\u4e00-\u9fffA-Za-z_][\u4e00-\u9fffA-Za-z0-9_]*$/.test(alias) || !english) return
          const previous = logicAliases.get(alias)
          if (previous && previous !== english) ambiguousLogic.add(alias)
          else if (!ambiguousLogic.has(alias)) logicAliases.set(alias, english)
        }
        for (const code of codes) {
          const rawCode = code.code.trim()
          const identifier = rawCode.replace(/^self\./i, '').replace(/\(\)$/, '')
          if (!logicNames.has(identifier.toLowerCase())) continue
          // self.xxx 条目提供完整显示名；同名短字段（hp/maxHp）提供中文模式
          // 实际出现的「血量/生命值」短别名。
          if (rawCode.startsWith('self.')) {
            if (code.translate.startsWith('自身')) addLogicAlias(code.translate.slice(2), identifier)
            addLogicAlias(code.translate, identifier)
          } else {
            addLogicAlias(code.translate, identifier)
          }
        }
        for (const translation of translations) {
          if (!translation.en || !translation.zh || !translation.en.startsWith('self.')) continue
          const identifier = translation.en.replace(/^self\./i, '').replace(/\(\)$/, '')
          if (!logicNames.has(identifier.toLowerCase())) continue
          addLogicAlias(translation.zh, identifier)
          if (translation.zh.startsWith('自身')) addLogicAlias(translation.zh.slice(2), identifier)
        }
        for (const alias of ambiguousLogic) logicAliases.delete(alias)
        logicIdentifierZhToEnDict.clear()
        logicIdentifierEnToZhDict.clear()
        for (const [alias, english] of logicAliases) {
          logicIdentifierZhToEnDict.set(alias, english)
          const current = logicIdentifierEnToZhDict.get(english)
          // 显示层优先短别名（self.血量），完整「自身血量」仍保留在反向表，
          // 这样代码更接近用户原文件且保存仍由 tracker 保真。
          if (!current || alias.length < current.length) logicIdentifierEnToZhDict.set(english, alias)
        }

        // 标签、名称与资源路径是用户定义的自由值。保存时这些字段的值不使用
        // 通用 tracker 回译，避免用户标签「攻击」「任意」被擅自换成英文。
        preserveValueKeys.clear()
        logicValueKeys.clear()
        preserveValueKeyPatterns.length = 0
        const freeValueTypes = new Set([
          'tags', 'string', 'strings', 'string(s)', 'image', 'audio', 'unit', 'projectile',
          'resource', 'effect', 'marker', 'memory', 'defineunitmemory', 'localestring',
          'language', 'unit ref', 'resource ref', 'copyfrom', 'copydexunit',
        ])
        for (const code of codes) {
          const typesForCode = code.type.split(',').map((type) => type.trim().toLowerCase())
          const isFree = typesForCode.some((type) => freeValueTypes.has(type) || type.includes('ref') || type.includes('locale'))
          if (code.code && isFree) {
            const lowerCode = code.code.toLowerCase()
            preserveValueKeys.add(lowerCode)
            if (/[{#]/.test(code.code)) {
              const pattern = codeTemplateRegex(code.code)
              if (pattern) preserveValueKeyPatterns.push(pattern)
            }
          }
          if (code.code && typesForCode.some((type) => type.includes('logic'))) {
            logicValueKeys.add(code.code.toLowerCase())
          }
        }
        officialUnits = (unitsRaw.data ?? []) as OfficialUnitInfo[]
        gameVersions = ((versionRaw.data ?? []) as GameVersionInfo[]).sort((a, b) => a.versionNumber - b.versionNumber)
        // 字段别名表（M35）：重载时重建（知识包更新/回滚同理清旧数据）
        aliasDict.clear()
        for (const a of (aliasesRaw.data ?? []) as AliasInfo[]) {
          if (a.alias && a.code) aliasDict.set(a.alias.toLowerCase(), a.code)
        }
      } catch (err) {
        // 数据不可用（如离线/测试环境）时降级：编辑器仍可用，只是没有补全和翻译。
        // 旧代次失败不能清掉新代次的 Promise，否则会让新加载被错误地重复发起。
        if (generation === loadGeneration) {
          loaded = null
          console.warn('[codeData] 数据加载失败，补全与翻译不可用（下次调用会重试）', err)
        }
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

/** 获取枚举值中文词典快照（M34：own→己方 等；键为小写英文枚举值） */
export function getValueZhDict(): Map<string, string> {
  return valueZhDict
}

/** 获取枚举值反向词典快照（M38：己方→own 等；键为中文枚举值） */
export function getValueZhToEnDict(): Map<string, string> {
  return valueZhToEnDict
}

/** 获取枚举值中文别名候选（当前字段 list 可用于消歧）。 */
export function getValueZhToEnCandidates(): Map<string, ReadonlySet<string>> {
  return valueZhToEnCandidates
}

/** 获取已验证的 self 中文标识符回译表。 */
export function getLogicIdentifierZhToEnDict(): Map<string, string> {
  return logicIdentifierZhToEnDict
}

/** 获取 self 标识符的英文→中文显示表。 */
export function getLogicIdentifierEnToZhDict(): Map<string, string> {
  return logicIdentifierEnToZhDict
}

/** 获取允许 self.xxx 翻译的逻辑字段集合。 */
export function getLogicValueKeys(): ReadonlySet<string> {
  return logicValueKeys
}

/** 获取值区自由字段集合，翻译保存时保护用户自定义内容。 */
export function getPreserveValueKeys(): ReadonlySet<string> {
  return preserveValueKeys
}

/** 判断动态模板键是否属于自由值字段。 */
export function isPreserveValueKey(key: string): boolean {
  const lower = key.trim().toLowerCase()
  return preserveValueKeys.has(lower) || preserveValueKeyPatterns.some((pattern) => pattern.test(key.trim()))
}

/** 在当前字段允许列表中把中文枚举值解析成唯一英文值。 */
export function resolveValueZhToEn(value: string, list?: string | string[]): string | undefined {
  const key = value.trim()
  if (!key) return undefined
  const candidates = valueZhToEnCandidates.get(key)
  if (!candidates || candidates.size === 0) return undefined
  if (!list) return candidates.size === 1 ? [...candidates][0] : undefined
  const items = Array.isArray(list) ? list : parseValueList(list)
  const allowed = new Set(items.map((item) => {
    const open = item.indexOf('(')
    return (open > 0 ? item.slice(0, open) : item).trim().toLowerCase()
  }))
  const matched = [...candidates].filter((candidate) => allowed.has(candidate.toLowerCase()))
  return matched.length === 1 ? matched[0] : undefined
}

const splitTopLevelValue = splitTopLevelConfigValue

/** 保存前把中文手输的受限值规范化为引擎值；自由文本和未知字段原样返回。 */
export function normalizeValueForEngine(key: string, value: string): string {
  const code = findCodeByCode(key)
  if (!code) return value
  const types = code.type.split(',').map((type) => type.trim().toLowerCase())
  const vts = findValueTypes(code.type)
  const boolField = types.some((type) => type === 'boolean' || type === 'bool' || type === 'logicboolean')
  const booleanMap = new Map([['是', 'true'], ['真', 'true'], ['否', 'false'], ['假', 'false']])
  const normalizePart = (part: string, list?: string): string => {
    const open = part.indexOf('(')
    const base = (open >= 0 ? part.slice(0, open) : part).trim()
    const suffix = open >= 0 ? part.slice(open) : ''
    const boolean = boolField ? booleanMap.get(base) : undefined
    const translated = boolean ?? resolveValueZhToEn(base, list)
    return translated ? `${translated}${suffix}` : part.trim()
  }
  const finiteList = vts.find((type) => type.list && isFiniteValueList(type.list, type.rule))
  if (!boolField && !finiteList) return value
  const leading = value.match(/^\s*/)?.[0] ?? ''
  const trailing = value.match(/\s*$/)?.[0] ?? ''
  const core = value.slice(leading.length, value.length - trailing.length)
  const normalized = splitTopLevelValue(core).map((part) => normalizePart(part, finiteList?.list)).join(',')
  return leading + normalized + trailing
}

function isFiniteValueList(list: string, rule?: string): boolean {
  const items = parseValueList(list)
  if (items.length === 0 || items.some((item) => item.startsWith('@'))) return false
  return !rule || rule.split('|').every((part) => /^[A-Za-z0-9_:-]+$/.test(part.trim()))
}

/** 获取字段别名表快照（M35：旧字段名小写 → 现行 code） */
export function getAliasDict(): Map<string, string> {
  return aliasDict
}

/** 字段 code 是否有别名命中查询词（搜索过滤用：code/translate/别名 任一命中）。
 * 大小写不敏感；别名以子串方式匹配（与 code 匹配语义一致）。 */
export function aliasMatches(code: string, query: string): boolean {
  if (!query) return false
  const q = query.toLowerCase()
  const target = code.toLowerCase()
  for (const [alias, resolved] of aliasDict) {
    if (resolved.toLowerCase() === target && alias.includes(q)) return true
  }
  return false
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
  const matchSection = (c: CodeInfo) => c.section === 'all' || (c.section ?? '').split(',').some((token) => token.trim().toLowerCase() === enSection)
  const list = codes.filter(
    (c) => matchSection(c) && (c.code.toLowerCase().includes(q) || c.translate.includes(query.trim()) || aliasMatches(c.code, q)),
  )
  return list.slice(0, limit)
}

/** 按英文键或中文译名模糊查代码（M35：别名旧名同样命中） */
export function findCodesByQuery(query: string, limit = 40): CodeInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return codes.slice(0, limit)
  const list = codes.filter((c) => c.code.toLowerCase().includes(q) || c.translate.includes(query.trim()) || aliasMatches(c.code, q))
  return list.slice(0, limit)
}

/** 把代码表模板键（{NUM}/{LANG}/#）编译为实际键匹配器。 */
function codeTemplateRegex(template: string): RegExp | undefined {
  let pattern = '^'
  for (let i = 0; i < template.length; i++) {
    const ch = template[i]
    if (ch === '{') {
      const end = template.indexOf('}', i + 1)
      if (end > i) {
        const token = template.slice(i + 1, end).toUpperCase()
        pattern += token === 'NUM' ? '\\d+' : '[^:=_]+'
        i = end
        continue
      }
    }
    if (ch === '#') {
      pattern += '[^:=_]+'
      continue
    }
    pattern += /[A-Za-z0-9_]/.test(ch) ? ch : `\\${ch}`
  }
  try { return new RegExp(`${pattern}$`, 'i') } catch { return undefined }
}

/** 按 code 精确查（用于值类型解析；M35：查不到时解析旧名别名/模板键） */
export function findCodeByCode(code: string): CodeInfo | undefined {
  const lower = code.toLowerCase()
  const hit = codes.find((c) => c.code.toLowerCase() === lower)
  if (hit) return hit
  const resolved = aliasDict.get(lower)
  if (resolved) {
    const aliasHit = codes.find((c) => c.code.toLowerCase() === resolved.toLowerCase())
    if (aliasHit) return aliasHit
  }
  return codes.find((candidate) => candidate.code.includes('{') || candidate.code.includes('#') ? codeTemplateRegex(candidate.code)?.test(code) : false)
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

/** 值类型合法值列表（解析顶层逗号分隔，含特殊指令 @xxx）。 */
export function parseValueList(list: string | undefined): string[] {
  if (!list) return []
  return splitTopLevelConfigValue(list)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.startsWith('@'))
}

/** 逻辑布尔函数：按名精确查（兼容 self.xxx() 数据与 xxx 调用形式）。 */
export function findLogicBoolean(name: string): LogicBooleanInfo | undefined {
  const raw = name.trim()
  const normalized = raw.replace(/^self\./i, '').replace(/\(\)$/, '').toLowerCase()
  return logicBooleans.find((l) => {
    const candidate = l.name.trim().replace(/^self\./i, '').replace(/\(\)$/, '').toLowerCase()
    return candidate === normalized
  })
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
