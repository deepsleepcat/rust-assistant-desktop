const FORBIDDEN_KEYS = new Set([
  '__proto__', 'prototype', 'constructor', 'script', 'scripts', 'exec', 'execute',
  'command', 'commands', 'runtime', 'node', 'network', 'url', 'uri', 'endpoint',
  'fetch', 'eval', 'code', 'handler', 'binary', 'executable', 'process',
  'child_process', 'filesystem', 'fs', 'readfile', 'writefile', 'spawn', 'shell',
  'require', 'import', 'dependency', 'dependencies', 'package', 'packages',
])
const CAPABILITIES = new Set(['translations', 'fieldAliases', 'enumExplanations', 'rules', 'rendererAdapter'])
const CHECK_TYPES = new Set(['numeric-range', 'required-key', 'forbidden-value', 'regex-match', 'enum-value'])
export type PluginCheckType = 'numeric-range' | 'required-key' | 'forbidden-value' | 'regex-match' | 'enum-value'

export interface PluginRule {
  id: string
  title: string
  description?: string
  section?: string
  key?: string
  severity?: 'error' | 'warning' | 'info'
  check: { type: PluginCheckType; min?: number; max?: number; values?: string[]; pattern?: string }
}

export interface EnabledPluginData {
  translations: Array<{ en: string; zh: string }>
  aliases: Array<{ alias: string; code: string }>
  enumExplanations: Record<string, Record<string, string>>
  rules: PluginRule[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasForbiddenKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false
  if (seen.has(value)) return true
  seen.add(value)
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item, seen))
  if (!isRecord(value)) return true
  return Object.entries(value).some(([key, child]) => FORBIDDEN_KEYS.has(key.toLowerCase()) || hasForbiddenKey(child, seen))
}

function safeText(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex -- 控制字符在声明式数据里不可见且易被滥用，必须拒绝
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
}

function validatePersistedManifest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || hasForbiddenKey(value)) return false
  if (value.manifestVersion !== 1 || !safeText(value.id, 64) || !safeText(value.version, 64) || !safeText(value.name, 128)) return false
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0 || value.capabilities.some((item) => typeof item !== 'string' || !CAPABILITIES.has(item))) return false
  return true
}

function readTranslations(value: unknown, output: EnabledPluginData['translations']): void {
  if (!isRecord(value)) return
  for (const [locale, entries] of Object.entries(value)) {
    if (locale.toLowerCase() !== 'en' && locale.toLowerCase() !== 'default') continue
    if (!isRecord(entries)) continue
    for (const [en, zh] of Object.entries(entries)) if (safeText(en, 128) && safeText(zh, 4096)) output.push({ en, zh })
  }
}

function readAliases(value: unknown, output: EnabledPluginData['aliases']): void {
  if (!isRecord(value)) return
  for (const [code, aliases] of Object.entries(value)) {
    if (!safeText(code, 128) || !Array.isArray(aliases)) continue
    for (const alias of aliases) if (safeText(alias, 128)) output.push({ alias, code })
  }
}

function readEnumExplanations(value: unknown, output: EnabledPluginData['enumExplanations']): void {
  if (!isRecord(value)) return
  for (const [field, entries] of Object.entries(value)) {
    if (!safeText(field, 128) || !isRecord(entries)) continue
    const target = output[field] ?? (output[field] = {})
    for (const [enumValue, explanation] of Object.entries(entries)) if (safeText(enumValue, 128) && safeText(explanation, 1024)) target[enumValue] = explanation
  }
}

function readRules(value: unknown, output: EnabledPluginData['rules']): void {
  if (!isRecord(value) || !Array.isArray(value.rules)) return
  for (const item of value.rules) {
    if (!isRecord(item) || !safeText(item.id, 64) || !safeText(item.title, 256) || !isRecord(item.check)) continue
    if (typeof item.check.type !== 'string' || !CHECK_TYPES.has(item.check.type)) continue
    output.push({
      id: item.id,
      title: item.title,
      ...(safeText(item.description, 4096) ? { description: item.description } : {}),
      ...(safeText(item.section, 128) ? { section: item.section } : {}),
      ...(safeText(item.key, 128) ? { key: item.key } : {}),
      ...(item.severity === 'error' || item.severity === 'warning' || item.severity === 'info' ? { severity: item.severity } : {}),
      check: item.check as PluginRule['check'],
    })
  }
}

/** Read only enabled, persisted declarations. This layer has no bridge, filesystem, or execution dependency. */
export function loadEnabledPluginData(raw: unknown): EnabledPluginData {
  const result: EnabledPluginData = { translations: [], aliases: [], enumExplanations: {}, rules: [] }
  if (!isRecord(raw) || !Array.isArray(raw.plugins)) return result
  for (const item of raw.plugins) {
    if (!isRecord(item) || item.enabled !== true || !validatePersistedManifest(item.manifest)) continue
    readTranslations(item.manifest.translations, result.translations)
    readAliases(item.manifest.fieldAliases, result.aliases)
    readEnumExplanations(item.manifest.enumExplanations, result.enumExplanations)
    readRules(item.manifest.rules, result.rules)
  }
  return result
}
