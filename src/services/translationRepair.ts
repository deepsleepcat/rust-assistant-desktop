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
}

export type TranslationRepairChangeKind = 'section' | 'key' | 'boolean'

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
    const value = restoreBoolean(keyValue[5], key.trim(), booleanFields)
    if (key === keyValue[2] && value === keyValue[5]) continue
    let after = replaceRange(before, keyValue[1].length, keyValue[2].length, key)
    if (value !== keyValue[5]) {
      const valueStart = after.length - keyValue[5].length
      after = replaceRange(after, valueStart, keyValue[5].length, value)
    }
    lines[index] = after
    changes.push({ line: index + 1, kind: value === keyValue[5] ? 'key' : 'boolean', before, after })
  }

  const content = lines.join(newline)
  return { content: bom ? '\uFEFF'.concat(content) : content, changes }
}
