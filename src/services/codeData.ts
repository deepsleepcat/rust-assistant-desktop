/**
 * 代码数据服务：加载 public/data/ 下的手机版数据库与旧版词库，
 * 构建内存索引（键/节/值类型/翻译词典/词库），供补全、翻译、高亮使用。
 *
 * 数据来源：
 * - code.json       手机版 1130 条代码键（英文键/中文译名/说明/值类型/所属节）
 * - section.json    手机版 30 个节
 * - value_type.json 手机版 66 种值类型（补全规则、合法值列表）
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

/** 加载全部数据并构建索引（幂等，内存缓存；失败时降级为空词典，不阻塞编辑器） */
export function loadCodeData(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const base = import.meta.env.BASE_URL || '/'
        const [codeRaw, sectionRaw, valueRaw, transRaw, vocabRaw] = await Promise.all([
          fetchJson<RawDataset>(`${base}data/code.json`),
          fetchJson<RawDataset>(`${base}data/section.json`),
          fetchJson<RawDataset>(`${base}data/value_type.json`),
          fetchJson<RawDataset>(`${base}data/translations.json`),
          fetchJson<RawDataset>(`${base}data/vocabulary.json`),
        ])

        codes = (codeRaw.data ?? []) as CodeInfo[]
        sections = (sectionRaw.data ?? []) as SectionInfo[]
        valueTypes = (valueRaw.data ?? []) as ValueTypeInfo[]
        // translations/vocabulary 的顶层键是 words（不是 data），两边都兼容
        const translations = (transRaw.words ?? transRaw.data ?? []) as Array<{ en?: string; zh?: string }>
        const vocab = (vocabRaw.words ?? vocabRaw.data ?? []) as VocabularyItem[]

        // 翻译词典构建顺序：先并入补充词条（translations.json），
        // 再并入主数据（code.json / section.json）——主数据优先，
        // 防止补充词条里的垃圾值覆盖正确翻译。
        for (const t of translations) {
          if (t.en && t.zh) {
            enToZhDict.set(t.en.toLowerCase(), t.zh)
            zhToEnDict.set(t.zh, t.en)
          }
        }
        for (const c of codes) {
          if (c.code && c.translate) {
            enToZhDict.set(c.code.toLowerCase(), c.translate)
            zhToEnDict.set(c.translate, c.code)
          }
        }
        // 节名（[core]→[核心] 等）必须进词典，否则中文模式下节头不翻译
        for (const s of sections) {
          if (s.code && s.translate) {
            enToZhDict.set(s.code.toLowerCase(), s.translate)
            zhToEnDict.set(s.translate, s.code)
          }
        }
        vocabulary = vocab
      } catch (err) {
        // 数据不可用（如离线/测试环境）时降级：编辑器仍可用，只是没有补全和翻译
        console.warn('[codeData] 数据加载失败，补全与翻译不可用', err)
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

/** 当前行所属节（向上扫描最近的 [xxx]） */
export function getSectionOfLine(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const m = /^\s*\[(.+?)\]\s*$/.exec(lines[i])
    if (m) return m[1]
  }
  return ''
}

/** 按节查询代码（节为 all 时全局适用；英文 code 或中文 translate 匹配） */
export function findCodesBySection(section: string, query: string, limit = 40): CodeInfo[] {
  const q = query.trim().toLowerCase()
  const matchSection = (c: CodeInfo) => c.section === 'all' || c.section.split(',').includes(section)
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

/** 按节英文 code 或中文译名模糊查节 */
export function findSectionsByQuery(query: string, limit = 40): SectionInfo[] {
  const q = query.trim().toLowerCase()
  const list = sections.filter((s) => s.code.toLowerCase().includes(q) || s.translate.includes(query.trim()))
  return list.slice(0, limit)
}

/** 按中文节名查节（翻译用） */
export function findSectionByTranslate(translate: string): SectionInfo | undefined {
  return sections.find((s) => s.translate === translate || s.code === translate)
}

/** 按值类型 type 查 */
export function findValueType(type: string): ValueTypeInfo | undefined {
  return valueTypes.find((v) => v.type === type)
}

/** 值类型合法值列表（解析逗号分隔，含特殊指令 @xxx） */
export function parseValueList(list: string | undefined): string[] {
  if (!list) return []
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('@'))
}

/** 词库：按 word 模糊匹配（旧版 fuzzy 思路：位置越靠前、长度差越小分越高） */
export function searchVocabulary(query: string, limit = 20): VocabularyItem[] {
  const q = query.trim().toLowerCase()
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
