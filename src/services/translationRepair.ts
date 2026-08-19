/** 已翻译 INI 的保守恢复规则。 */

export interface RepairSectionInfo {
  code: string
  translate: string
  needName?: boolean
}

export interface RepairCodeInfo {
  code: string
  translate: string
  type?: string
}

export interface TranslationRepairDictionary {
  sections: RepairSectionInfo[]
  codes: RepairCodeInfo[]
  /** 已验证的 self 中文标识符 → 英文标识符；缺省时不猜测逻辑函数。 */
  logicIdentifiers?: Map<string, string>
}

export type TranslationRepairChangeKind = 'section' | 'key' | 'boolean' | 'logic'

/** 从代码表与逻辑函数表构建唯一的 self 中文标识符映射。
 * 短字段（maxHp）和完整 self 条目都可提供别名；冲突项删除，不猜测。
 */
export function buildLogicIdentifierMap(codes: RepairCodeInfo[], logicNames: Iterable<string>, translations: Array<{ en: string; zh: string }> = []): Map<string, string> {
  const known = new Set([...logicNames].map((name) => name.trim().replace(/^self\./i, '').replace(/\(\)$/, '').toLowerCase()).filter(Boolean))
  const candidates = new Map<string, string>()
  const ambiguous = new Set<string>()
  const add = (alias: string, identifier: string) => {
    const key = alias.trim()
    if (!/^[\u4e00-\u9fffA-Za-z_][\u4e00-\u9fffA-Za-z0-9_]*$/.test(key) || !identifier || !known.has(identifier.toLowerCase())) return
    const previous = candidates.get(key)
    if (previous && previous !== identifier) ambiguous.add(key)
    else if (!ambiguous.has(key)) candidates.set(key, identifier)
  }
  for (const code of codes) {
    const raw = code.code.trim()
    const identifier = raw.replace(/^self\./i, '').replace(/\(\)$/, '')
    if (!known.has(identifier.toLowerCase())) continue
    if (raw.toLowerCase().startsWith('self.')) {
      add(code.translate, identifier)
      if (code.translate.startsWith('自身')) {
        const short = code.translate.slice(2).trim()
        if (short && !/^[.。]/.test(short)) add(short, identifier)
      }
    } else {
      add(code.translate, identifier)
    }
  }
  for (const translation of translations) {
    if (!translation.en.startsWith('self.') || !translation.zh) continue
    const identifier = translation.en.replace(/^self\./i, '').replace(/\(\)$/, '')
    add(translation.zh, identifier)
    if (translation.zh.startsWith('自身')) add(translation.zh.slice(2), identifier)
  }
  for (const alias of ambiguous) candidates.delete(alias)
  return candidates
}

export interface TranslationRepairChange {
  line: number
  kind: TranslationRepairChangeKind
  before: string
  after: string
}

export interface TranslationRepairResult {
  content: string
  changes: TranslationRepairChange[]
}

function uniqueTranslations(entries: Array<{ code: string; translate: string }>): Map<string, string> {
  const map = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const entry of entries) {
    const translated = entry.translate.trim()
    const code = entry.code.trim()
    if (!translated || !code) continue
    const previous = map.get(translated)
    if (previous && previous !== code) {
      ambiguous.add(translated)
    } else if (!ambiguous.has(translated)) {
      map.set(translated, code)
    }
  }
  for (const translated of ambiguous) map.delete(translated)
  return map
}

function replaceTrimmed(source: string, replacement: string): string {
  const trimmed = source.trim()
  const start = source.indexOf(trimmed)
  if (!trimmed || start < 0) return source
  return [source.slice(0, start), replacement, source.slice(start + trimmed.length)].join('')
}

function replaceRange(text: string, start: number, length: number, value: string): string {
  return [text.slice(0, start), value, text.slice(start + length)].join('')
}

function restoreSection(raw: string, dict: TranslationRepairDictionary): string {
  const trimmed = raw.trim()
  const exact = uniqueTranslations(dict.sections).get(trimmed)
  if (exact) return replaceTrimmed(raw, exact)
  const named = dict.sections
    .filter((section) => section.needName && section.code && section.translate)
    .sort((a, b) => b.translate.length - a.translate.length)
  for (const section of named) {
    const prefix = [section.translate.trim(), '_'].join('')
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
      return replaceTrimmed(raw, [section.code.trim(), '_', trimmed.slice(prefix.length)].join(''))
    }
  }
  return raw
}

function restoreKey(raw: string, keys: Map<string, string>): string {
  const trimmed = raw.trim()
  const direct = keys.get(trimmed)
  if (direct) return replaceTrimmed(raw, direct)
  if (!trimmed.includes('_')) return raw

  // 已损坏文件可能是「英文前缀_中文片段_英文后缀」：按下划线分段，
  // 只恢复完整的已知译名片段，不触碰用户自定义 ID 中包含的中文。
  let changed = false
  const restored = trimmed.split('_').map((part) => {
    const code = keys.get(part)
    if (!code) return part
    changed = true
    return code
  })
  return changed ? replaceTrimmed(raw, restored.join('_')) : raw
}

function restoreBoolean(raw: string, field: string, booleanFields: Set<string>): string {
  if (!booleanFields.has(field.toLowerCase())) return raw
  const values = new Map<string, string>([
    ['是', 'true'],
    ['否', 'false'],
    ['真', 'true'],
    ['假', 'false'],
  ])
  const restored = values.get(raw.trim())
  return restored ? replaceTrimmed(raw, restored) : raw
}

/**
 * 只恢复损坏逻辑表达式中的 self.中文标识符。映射必须是明确的引擎标识符；
 * 未知 self.中文函数、参数和值区普通中文一律保留，避免猜测用户数据。
 */
function restoreKnownLogicIdentifiers(raw: string, logicIdentifiers?: Map<string, string>): string {
  if (!logicIdentifiers || logicIdentifiers.size === 0) return raw
  return raw.replace(/self\.([一-鿿][一-鿿0-9_]*)/g, (full, name: string) => {
    const restored = logicIdentifiers.get(name)
    return restored ? `self.${restored}` : full
  })
}

/** 对单个 INI 文本生成恢复结果，保留 BOM、换行、空白和注释。 */
export function repairIniContent(source: string, dict: TranslationRepairDictionary): TranslationRepairResult {
  const bom = source.startsWith('\uFEFF')
  const body = bom ? source.slice(1) : source
  const newline = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  const keys = uniqueTranslations(dict.codes)
  const booleanFields = new Set(
    dict.codes
      .filter((entry) => entry.type?.toLowerCase() === 'boolean' || entry.type?.toLowerCase() === 'logicboolean')
      .map((entry) => entry.code.toLowerCase()),
  )
  const logicFields = new Set(
    dict.codes
      .filter((entry) => entry.type?.split(',').some((type) => type.trim().toLowerCase().includes('logic')))
      .map((entry) => entry.code.toLowerCase()),
  )
  const changes: TranslationRepairChange[] = []

  for (let index = 0; index < lines.length; index++) {
    const before = lines[index]
    const section = /^(\s*)\[([^\]]+)\](\s*(?:#.*)?)$/.exec(before)
    if (section) {
      const restored = restoreSection(section[2], dict)
      if (restored !== section[2]) {
        const after = replaceRange(before, section.index + section[1].length + 1, section[2].length, restored)
        lines[index] = after
        changes.push({ line: index + 1, kind: 'section', before, after })
      }
      continue
    }

    const keyValue = /^(\s*)([^:=]+?)(\s*)([:=])(.*)$/.exec(before)
    if (!keyValue) continue
    const key = restoreKey(keyValue[2], keys)
    const field = key.trim().toLowerCase()
    const booleanValue = restoreBoolean(keyValue[5], key.trim(), booleanFields)
    const value = logicFields.has(field) ? restoreKnownLogicIdentifiers(booleanValue, dict.logicIdentifiers) : booleanValue
    if (key === keyValue[2] && value === keyValue[5]) continue
    let after = replaceRange(before, keyValue[1].length, keyValue[2].length, key)
    if (value !== keyValue[5]) {
      const valueStart = after.length - keyValue[5].length
      after = replaceRange(after, valueStart, keyValue[5].length, value)
    }
    lines[index] = after
    const kind: TranslationRepairChangeKind = value !== booleanValue ? 'logic' : booleanValue !== keyValue[5] ? 'boolean' : 'key'
    changes.push({ line: index + 1, kind, before, after })
  }

  const content = lines.join(newline)
  return { content: bom ? '\uFEFF'.concat(content) : content, changes }
}
