/**
 * 代码数据查询层（M40 巨型文件拆分：自 codeData.ts 迁出）：
 * 代码/节/值类型/词库的查询函数与枚举值规范化，经 codeDataState 的
 * getter/访问器读取索引，不持有索引状态。
 */
import type { Completion } from '@codemirror/autocomplete'
import { splitTopLevelConfigValue } from './configSyntax'
import {
  codeTemplateRegex,
  getAliasDict,
  getSectionZhToEnDict,
  getValueZhToEnCandidates,
  getZhToEnDict,
  isDataLoaded,
  stateCodes,
  stateDialectWords,
  stateGameVersions,
  stateLogicBooleans,
  stateOfficialUnits,
  stateSections,
  stateValueTypes,
  stateVocabulary,
  type CodeInfo,
  type GameVersionInfo,
  type LogicBooleanInfo,
  type OfficialUnitInfo,
  type SectionInfo,
  type ValueTypeInfo,
  type VocabularyItem,
} from './codeDataState'

export type { CodeInfo, SectionInfo, ValueTypeInfo, VocabularyItem, LogicBooleanInfo, OfficialUnitInfo, GameVersionInfo } from './codeDataState'

/** 在当前字段允许列表中把中文枚举值解析成唯一英文值。 */
export function resolveValueZhToEn(value: string, list?: string | string[]): string | undefined {
  const key = value.trim()
  if (!key) return undefined
  const candidates = getValueZhToEnCandidates().get(key)
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

/** 字段 code 是否有别名命中查询词（搜索过滤用：code/translate/别名 任一命中）。
 * 大小写不敏感；别名以子串方式匹配（与 code 匹配语义一致）。 */
export function aliasMatches(code: string, query: string): boolean {
  if (!query) return false
  const q = query.toLowerCase()
  const target = code.toLowerCase()
  for (const [alias, resolved] of getAliasDict()) {
    if (resolved.toLowerCase() === target && alias.includes(q)) return true
  }
  return false
}

/** 中文键分段回译（建造自_1_名称 → builtFrom_1_name）：
 * 中文显示层的宏字段键是分段翻译结果，查代码表/值类型前先按 _ 分段回译。 */
export function zhToEnKeySegments(key: string): string {
  return key
    .split('_')
    .map((seg) => getZhToEnDict().get(seg) ?? seg)
    .join('_')
}

/** 节名归一化（补全/lint 查当前节键用）：
 * 中文段经节名词典优先回译（[炮塔_1] → turret_1），编号节去掉 _N 后缀；
 * 已知 needName 节允许用户命名后缀（[turret_main] → turret），未知节不猜测归类。 */
export function normalizeSectionName(section: string): string {
  const en = section
    .split('_')
    .map((seg) => getSectionZhToEnDict().get(seg) ?? getZhToEnDict().get(seg) ?? seg)
    .join('_')
    .toLowerCase()
  const namedBase = stateSections().find((s) => s.needName && en.startsWith(`${s.code.toLowerCase()}_`))
  return namedBase?.code.toLowerCase() ?? en
}

/** 按节查询代码（节为 all 时全局适用；英文 code 或中文 translate 匹配）。
 * 中文显示层传入的中文节名（如「核心」）与编号节（[turret_1]）都会先归一化。 */
export function findCodesBySection(section: string, query: string, limit = 40): CodeInfo[] {
  const q = query.trim().toLowerCase()
  const enSection = normalizeSectionName(section)
  const matchSection = (c: CodeInfo) => c.section === 'all' || (c.section ?? '').split(',').some((token) => token.trim().toLowerCase() === enSection)
  const list = stateCodes().filter(
    (c) => matchSection(c) && (c.code.toLowerCase().includes(q) || c.translate.includes(query.trim()) || aliasMatches(c.code, q)),
  )
  return list.slice(0, limit)
}

/** 按英文键或中文译名模糊查代码（M35：别名旧名同样命中） */
export function findCodesByQuery(query: string, limit = 40): CodeInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...stateCodes()].slice(0, limit)
  const list = stateCodes().filter((c) => c.code.toLowerCase().includes(q) || c.translate.includes(query.trim()) || aliasMatches(c.code, q))
  return list.slice(0, limit)
}

/** 按 code 精确查（用于值类型解析；M35：查不到时解析旧名别名/模板键） */
export function findCodeByCode(code: string): CodeInfo | undefined {
  const lower = code.toLowerCase()
  const codes = stateCodes()
  const hit = codes.find((c) => c.code.toLowerCase() === lower)
  if (hit) return hit
  const resolved = getAliasDict().get(lower)
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
  const list = stateCodes().filter((c) => {
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
  const list = stateSections().filter((s) => {
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
  return [...stateSections()].sort((a, b) => a.code.localeCompare(b.code))
}

/** 全部代码（按 code 排序），供代码表浏览 */
export function getAllCodes(): CodeInfo[] {
  return [...stateCodes()].sort((a, b) => a.code.localeCompare(b.code))
}

/** 全部值类型（内置 + 用户自定义，按 type 排序），供值类型管理浏览 */
export function getAllValueTypes(): ValueTypeInfo[] {
  return [...stateValueTypes()].sort((a, b) => a.type.localeCompare(b.type))
}

/** 全部官方单位（scripts/extract-game-data.mjs 从游戏提取，按 name 排序） */
export function getAllOfficialUnits(): OfficialUnitInfo[] {
  return [...stateOfficialUnits()]
}

/** 全部游戏版本（按 versionNumber 升序），供版本兼容设置/悬停展示 */
export function getGameVersions(): GameVersionInfo[] {
  return [...stateGameVersions()]
}

/** 版本名 → versionNumber（未知/空返回 undefined；空字符串视为「跟随最新」） */
export function versionNameToNumber(name: string | undefined): number | undefined {
  if (!name) return undefined
  const hit = stateGameVersions().find((v) => v.versionName.toLowerCase() === name.trim().toLowerCase())
  return hit?.versionNumber
}

/** versionNumber → 版本名（未知返回 undefined） */
export function versionNumberToName(number: number): string | undefined {
  return stateGameVersions().find((v) => v.versionNumber === number)?.versionName
}

/** 最新版本号（版本检查器的默认目标；数据缺失时返回 undefined → 检查跳过） */
export function latestVersionNumber(): number | undefined {
  const versions = stateGameVersions()
  if (versions.length === 0) return undefined
  return versions[versions.length - 1].versionNumber
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
  for (const c of stateCodes()) {
    if (typeof c.addVersion === 'number' && (maxAddVersion === undefined || c.addVersion > maxAddVersion)) {
      maxAddVersion = c.addVersion
    }
  }
  const latest = latestVersionNumber()
  return {
    loaded: isDataLoaded(),
    codeCount: stateCodes().length,
    versionCount: stateGameVersions().length,
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
  const valueTypes = stateValueTypes()
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
  return stateLogicBooleans().find((l) => {
    const candidate = l.name.trim().replace(/^self\./i, '').replace(/\(\)$/, '').toLowerCase()
    return candidate === normalized
  })
}

/** 逻辑布尔函数：前缀模糊查（self. 补全候选） */
export function searchLogicBooleans(query: string, limit = 30): LogicBooleanInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return stateLogicBooleans().slice(0, limit)
  return stateLogicBooleans().filter((l) => l.name.toLowerCase().includes(q)).slice(0, limit)
}

/** 词库：按 word 模糊匹配（旧版 fuzzy 思路：位置越靠前、长度差越小分越高） */
export function searchVocabulary(query: string, limit = 20): VocabularyItem[] {  const q = query.trim().toLowerCase()
  if (!q) return stateVocabulary().slice(0, limit)
  const scored: Array<{ item: VocabularyItem; score: number }> = []
  for (const item of stateVocabulary()) {
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
  if (!q) return stateDialectWords().slice(0, limit)
  return stateDialectWords()
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
