/**
 * M40 plugin contracts and validation.
 *
 * This module intentionally has no filesystem, network, Electron, or execution
 * dependency. Import UI code can pass a user-selected JSON/directory payload
 * here, validate it, and only then decide whether to persist it.
 */
import { validateRuleSet, type CustomRuleSet } from '../editor/semanticChecks/ruleSchema'

export const PLUGIN_MANIFEST_VERSION = 1 as const

export type PluginCapability =
  | 'translations'
  | 'fieldAliases'
  | 'enumExplanations'
  | 'rules'
  | 'rendererAdapter'

export const PLUGIN_CAPABILITIES: ReadonlyArray<PluginCapability> = [
  'translations',
  'fieldAliases',
  'enumExplanations',
  'rules',
  'rendererAdapter',
]

export interface PluginResource {
  id: string
  path: string
  kind: 'image' | 'data'
}

export type RenderCommandType = 'drawTile' | 'fillRect' | 'imageRef'

export interface RendererAdapterDescriptor {
  formatVersion: 1
  kind: 'canvas-2d'
  /** Commands the adapter may return. The renderer still validates every result. */
  allowedCommands: ReadonlyArray<RenderCommandType>
  resourceIds: ReadonlyArray<string>
  maxCommands: number
  maxResponseBytes: number
}

export interface PluginManifest {
  manifestVersion: 1
  id: string
  version: string
  name: string
  description?: string
  capabilities: ReadonlyArray<PluginCapability>
  translations?: Readonly<Record<string, Readonly<Record<string, string>>>>
  fieldAliases?: Readonly<Record<string, ReadonlyArray<string>>>
  enumExplanations?: Readonly<Record<string, Readonly<Record<string, string>>>>
  rules?: CustomRuleSet
  resources: ReadonlyArray<PluginResource>
  rendererAdapter?: RendererAdapterDescriptor
}

export interface PluginFile {
  path: string
  size: number
}

export type PluginImportKind = 'json' | 'directory'

export interface PluginImportRequest {
  /** Only a local JSON file or a local directory is accepted. */
  source: PluginImportKind
  /** Must be true because importing is an explicit user action. */
  userInitiated: true
  manifest: unknown
  files?: ReadonlyArray<PluginFile>
  /** Accepted as an input alias for directory adapters. */
  entries?: ReadonlyArray<PluginFile>
  /** Optional picker metadata. It must still be relative when supplied. */
  path?: string
  sourcePath?: string
  rootPath?: string
}

export interface ValidatedPluginImport {
  source: PluginImportKind
  manifest: PluginManifest
  files: ReadonlyArray<PluginFile>
}

export interface ValidationSuccess<T> {
  ok: true
  value: T
}

export interface ValidationFailure {
  ok: false
  errors: string[]
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

export const PLUGIN_LIMITS = Object.freeze({
  maxManifestBytes: 256 * 1024,
  maxPackageBytes: 16 * 1024 * 1024,
  maxFiles: 256,
  maxFileBytes: 8 * 1024 * 1024,
  maxResources: 128,
  maxRules: 128,
  maxTranslations: 2048,
  maxAliases: 2048,
  maxEnumExplanations: 2048,
})

const PLUGIN_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const LOCALE_RE = /^(?:default|[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*)$/
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isSafeKey(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !hasControlCharacters(value)
}
const SAFE_RESOURCE_EXTENSIONS = new Set([
  '.json', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico',
  '.txt', '.md', '.csv', '.xml', '.tmx', '.ini', '.template',
])
const SCRIPT_OR_EXECUTABLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.node', '.wasm', '.exe', '.com', '.bat', '.cmd',
  '.ps1', '.sh', '.bash', '.zsh', '.dll', '.so', '.dylib', '.scr', '.vbs', '.jar',
])
const FORBIDDEN_PACKAGE_FILENAMES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'])
const FORBIDDEN_KEY_RE = /^(?:__proto__|prototype|constructor|script|scripts|exec|execute|command|commands|entry|entrypoint|module|runtime|node|network|url|uri|endpoint|fetch|eval|code|hook|handler|binary|executable|process|child_process|filesystem|fs|readfile|writefile|deletefile|spawn|shell|require|import|dependency|dependencies|package|packages|socket|tcp|http|https|websocket|host|port|loader|resolve|cwd|directory|directories|file|files|tojson)$/i
const MANIFEST_KEYS = new Set([
  'manifestVersion', 'formatVersion', 'id', 'version', 'name', 'description', 'capabilities',
  'translations', 'fieldAliases', 'aliases', 'enumExplanations', 'rules', 'resources', 'rendererAdapter',
])
const CAPABILITY_ALIASES: Readonly<Record<string, PluginCapability>> = {
  translations: 'translations',
  translation: 'translations',
  locale: 'translations',
  locales: 'translations',
  fieldaliases: 'fieldAliases',
  'field-aliases': 'fieldAliases',
  aliases: 'fieldAliases',
  enumexplanations: 'enumExplanations',
  'enum-explanations': 'enumExplanations',
  enumdescriptions: 'enumExplanations',
  enums: 'enumExplanations',
  rules: 'rules',
  rendereradapter: 'rendererAdapter',
  'renderer-adapter': 'rendererAdapter',
  renderer: 'rendererAdapter',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasForbiddenKey(value: unknown, seen = new Set<object>()): boolean {
  if (Array.isArray(value)) {
    if (seen.has(value)) return true
    seen.add(value)
    return value.some((item) => hasForbiddenKey(item, seen))
  }
  if (!isRecord(value)) return false
  if (seen.has(value)) return true
  seen.add(value)
  return Object.keys(value).some((key) => {
    if (FORBIDDEN_KEY_RE.test(key)) return true
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !descriptor || !('value' in descriptor) || hasForbiddenKey(descriptor.value, seen)
  })
}

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isSafeData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    return Object.keys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor && 'value' in descriptor && isSafeData(descriptor.value, seen))
    })
  }
  if (!isRecord(value)) return false
  return Object.keys(value).every((key) => {
    if (!isSafeKey(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && 'value' in descriptor && isSafeData(descriptor.value, seen))
  })
}

function serializedSize(value: unknown): number | null {
  if (!isSafeData(value)) return null
  try {
    const json = JSON.stringify(value)
    return json === undefined ? null : utf8Size(json)
  } catch {
    return null
  }
}

function text(value: unknown, field: string, max: number, errors: string[], required = false): string | undefined {
  if (typeof value !== 'string' || (required && !value.trim())) {
    errors.push(`${field} 必须是非空字符串`)
    return undefined
  }
  if (value.length > max || hasControlCharacters(value)) errors.push(`${field} 超出长度或包含控制字符`)
  return value
}

function normalizeCapabilities(value: unknown, errors: string[]): PluginCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PLUGIN_CAPABILITIES.length) {
    errors.push('capabilities 必须是非空能力数组')
    return []
  }
  const result: PluginCapability[] = []
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push(`capabilities[${index}] 必须是字符串`)
      continue
    }
    const normalized = CAPABILITY_ALIASES[item.toLowerCase()]
    if (!normalized) {
      errors.push(`capabilities[${index}] 不是受支持的能力`)
      continue
    }
    if (!result.includes(normalized)) result.push(normalized)
    else errors.push(`capabilities[${index}] 重复`)
  }
  return result
}

function normalizeTranslations(value: unknown, errors: string[]): Readonly<Record<string, Readonly<Record<string, string>>>> | undefined {
  if (!isRecord(value)) {
    errors.push('translations 必须是 locale 到词条对象的映射')
    return undefined
  }
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > PLUGIN_LIMITS.maxTranslations) {
    errors.push('translations 数量超出限制或为空')
    return undefined
  }
  const result: Record<string, Record<string, string>> = {}
  const firstValue = entries[0]?.[1]
  const flat = typeof firstValue === 'string'
  const locales: Array<[string, unknown]> = flat ? [['default', value]] : entries
  let count = 0
  for (const [locale, rawItems] of locales) {
    if (!LOCALE_RE.test(locale) || !isRecord(rawItems)) {
      errors.push(`translations 的 locale「${locale}」无效`)
      continue
    }
    const items: Record<string, string> = {}
    for (const [key, rawText] of Object.entries(rawItems)) {
      if (!isSafeKey(key) || typeof rawText !== 'string' || rawText.length > 4096 || hasControlCharacters(rawText)) {
        errors.push(`translations.${locale}.${key} 词条无效`)
        continue
      }
      items[key] = rawText
      count++
    }
    if (Object.keys(items).length === 0) errors.push(`translations.${locale} 不能为空`)
    result[locale] = items
  }
  if (count > PLUGIN_LIMITS.maxTranslations) errors.push('translations 词条总数超出限制')
  return result
}

function normalizeAliases(value: unknown, errors: string[]): Readonly<Record<string, ReadonlyArray<string>>> | undefined {
  if (!isRecord(value)) {
    errors.push('fieldAliases 必须是字段到别名数组的映射')
    return undefined
  }
  const result: Record<string, string[]> = {}
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > PLUGIN_LIMITS.maxAliases) errors.push('fieldAliases 数量超出限制或为空')
  for (const [field, rawAliases] of entries) {
    if (!isSafeKey(field)) {
      errors.push(`fieldAliases.${field} 字段名无效`)
      continue
    }
    const aliases = typeof rawAliases === 'string' ? [rawAliases] : rawAliases
    if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > 32 || !aliases.every((alias) => typeof alias === 'string')) {
      errors.push(`fieldAliases.${field} 必须是非空字符串数组`)
      continue
    }
    const clean = [...new Set(aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0 && alias.length <= 128 && !hasControlCharacters(alias)))]
    if (clean.length !== aliases.length || clean.length === 0) errors.push(`fieldAliases.${field} 含无效或重复别名`)
    result[field] = clean
  }
  return result
}

function normalizeEnumExplanations(value: unknown, errors: string[]): Readonly<Record<string, Readonly<Record<string, string>>>> | undefined {
  if (!isRecord(value)) {
    errors.push('enumExplanations 必须是字段到枚举解释映射')
    return undefined
  }
  const result: Record<string, Record<string, string>> = {}
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > PLUGIN_LIMITS.maxEnumExplanations) errors.push('enumExplanations 数量超出限制或为空')
  for (const [field, rawValues] of entries) {
    if (!isSafeKey(field) || !isRecord(rawValues)) {
      errors.push(`enumExplanations.${field} 无效`)
      continue
    }
    const explanations: Record<string, string> = {}
    for (const [enumValue, explanation] of Object.entries(rawValues)) {
      if (!isSafeKey(enumValue) || typeof explanation !== 'string' || explanation.length > 1024 || hasControlCharacters(explanation)) {
        errors.push(`enumExplanations.${field}.${enumValue} 无效`)
        continue
      }
      explanations[enumValue] = explanation
    }
    if (Object.keys(explanations).length === 0) errors.push(`enumExplanations.${field} 不能为空`)
    result[field] = explanations
  }
  return result
}

/** Normalize a plugin-internal path and reject absolute/traversal/device paths. */
export function normalizePluginRelativePath(value: string): string | null {
  if (!value || value.length > 240 || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || /^\\\\/.test(value)) return null
  if (/^(?:https?|file|data):/i.test(value) || /%(?:2e|2f|5c)/i.test(value)) return null
  const parts: string[] = []
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    if (hasControlCharacters(segment) || /:/.test(segment) || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) return null
    parts.push(segment)
  }
  return parts.length > 0 ? parts.join('/') : null
}

function extension(path: string): string {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash ? path.slice(dot).toLowerCase() : ''
}

function normalizeResources(value: unknown, errors: string[]): PluginResource[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > PLUGIN_LIMITS.maxResources) {
    errors.push('resources 必须是有限数组')
    return []
  }
  const result: PluginResource[] = []
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`resources[${index}] 必须是对象`)
      continue
    }
    const id = text(item.id, `resources[${index}].id`, 64, errors, true)
    const pathValue = text(item.path, `resources[${index}].path`, 240, errors, true)
    const kind = item.kind
    const path = pathValue ? normalizePluginRelativePath(pathValue) : null
    const idKey = id?.toLowerCase()
    const pathKey = path?.toLowerCase()
    if (!id || !PLUGIN_ID_RE.test(id) || (idKey !== undefined && ids.has(idKey))) errors.push(`resources[${index}].id 无效或重复`)
    if (!path || !SAFE_RESOURCE_EXTENSIONS.has(extension(path))) errors.push(`resources[${index}].path 必须是安全的相对资源路径`)
    if (kind !== 'image' && kind !== 'data') errors.push(`resources[${index}].kind 只能是 image/data`)
    if (pathKey !== undefined && paths.has(pathKey)) errors.push(`resources[${index}].path 重复`)
    if (id && path && PLUGIN_ID_RE.test(id) && idKey !== undefined && !ids.has(idKey) && pathKey !== undefined && !paths.has(pathKey) && (kind === 'image' || kind === 'data')) {
      ids.add(idKey)
      paths.add(pathKey)
      result.push({ id, path, kind })
    }
  }
  return result
}

function normalizeRendererAdapter(value: unknown, resources: readonly PluginResource[], errors: string[]): RendererAdapterDescriptor | undefined {
  if (!isRecord(value)) {
    errors.push('rendererAdapter 必须是受控描述对象')
    return undefined
  }
  if (value.formatVersion !== 1) errors.push('rendererAdapter.formatVersion 必须为 1')
  if (value.kind !== 'canvas-2d') errors.push('rendererAdapter.kind 只能是 canvas-2d')
  const rawCommands = value.allowedCommands ?? value.commands
  if (!Array.isArray(rawCommands) || rawCommands.length === 0 || rawCommands.some((item) => item !== 'drawTile' && item !== 'fillRect' && item !== 'imageRef')) {
    errors.push('rendererAdapter.allowedCommands 只能包含 drawTile/fillRect/imageRef')
  }
  const maxCommands = value.maxCommands
  const maxResponseBytes = value.maxResponseBytes
  if (typeof maxCommands !== 'number' || !Number.isInteger(maxCommands) || maxCommands < 1 || maxCommands > 256) errors.push('rendererAdapter.maxCommands 必须在 1-256')
  if (typeof maxResponseBytes !== 'number' || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1024 || maxResponseBytes > 256 * 1024) errors.push('rendererAdapter.maxResponseBytes 必须在 1024-262144')
  const resourceIds = value.resourceIds
  const knownIds = new Set(resources.map((resource) => resource.id))
  if (!Array.isArray(resourceIds) || resourceIds.some((id) => typeof id !== 'string' || !knownIds.has(id))) errors.push('rendererAdapter.resourceIds 必须引用已声明资源')
  const cleanIds = Array.isArray(resourceIds) ? [...new Set(resourceIds.filter((id): id is string => typeof id === 'string' && knownIds.has(id)))] : []
  return {
    formatVersion: 1,
    kind: 'canvas-2d',
    allowedCommands: Array.isArray(rawCommands) ? rawCommands.filter((item): item is RenderCommandType => item === 'drawTile' || item === 'fillRect' || item === 'imageRef') : [],
    resourceIds: cleanIds,
    maxCommands: typeof maxCommands === 'number' && Number.isInteger(maxCommands) ? maxCommands : 0,
    maxResponseBytes: typeof maxResponseBytes === 'number' && Number.isInteger(maxResponseBytes) ? maxResponseBytes : 0,
  }
}

/** Validate and normalize one plugin manifest. This function never executes plugin data. */
export function validatePluginManifest(input: unknown): ValidationResult<PluginManifest> {
  const errors: string[] = []
  let rawInput = input
  if (typeof rawInput === 'string') {
    if (utf8Size(rawInput) > PLUGIN_LIMITS.maxManifestBytes) return { ok: false, errors: ['manifest 超过大小限制'] }
    try {
      rawInput = JSON.parse(rawInput) as unknown
    } catch {
      return { ok: false, errors: ['manifest 不是合法 JSON'] }
    }
  }
  const size = serializedSize(rawInput)
  if (size === null || size > PLUGIN_LIMITS.maxManifestBytes) errors.push('manifest 超过大小限制或不可序列化')
  if (!isRecord(rawInput)) return { ok: false, errors: ['manifest 必须是对象'] }
  if (hasForbiddenKey(rawInput)) errors.push('manifest 含脚本、可执行文件、网络或任意代码字段')
  for (const key of Object.keys(rawInput)) if (!MANIFEST_KEYS.has(key)) errors.push(`manifest 不支持字段「${key}」`)

  const versionField = rawInput.manifestVersion ?? rawInput.formatVersion
  if (versionField !== PLUGIN_MANIFEST_VERSION) errors.push('manifestVersion 必须为 1')
  const id = text(rawInput.id, 'id', 64, errors, true)
  const version = text(rawInput.version, 'version', 64, errors, true)
  const name = text(rawInput.name, 'name', 128, errors, true)
  const description = rawInput.description === undefined ? undefined : text(rawInput.description, 'description', 4096, errors)
  if (id && !PLUGIN_ID_RE.test(id)) errors.push('id 必须是安全的 1-64 位插件标识')
  if (version && !SEMVER_RE.test(version)) errors.push('version 必须是完整 semver 版本')
  const capabilities = normalizeCapabilities(rawInput.capabilities, errors)
  const resources = normalizeResources(rawInput.resources, errors)
  const translations = rawInput.translations === undefined ? undefined : normalizeTranslations(rawInput.translations, errors)
  const fieldAliases = rawInput.fieldAliases === undefined ? (rawInput.aliases === undefined ? undefined : normalizeAliases(rawInput.aliases, errors)) : normalizeAliases(rawInput.fieldAliases, errors)
  const enumExplanations = rawInput.enumExplanations === undefined ? undefined : normalizeEnumExplanations(rawInput.enumExplanations, errors)

  let rules: CustomRuleSet | undefined
  if (rawInput.rules !== undefined) {
    const rawRules = Array.isArray(rawInput.rules)
      ? { formatVersion: 1, name: name ?? 'plugin rules', rules: rawInput.rules }
      : rawInput.rules
    if (!isRecord(rawRules) || !Array.isArray(rawRules.rules) || rawRules.rules.length > PLUGIN_LIMITS.maxRules) errors.push(`rules 必须复用 formatVersion 1 规则集且最多 ${PLUGIN_LIMITS.maxRules} 条`)
    else {
      const checked = validateRuleSet(rawRules)
      if (!checked.ok) errors.push(...checked.errors.map((error) => `rules：${error}`))
      else rules = checked.set
    }
  }
  const rendererAdapter = rawInput.rendererAdapter === undefined ? undefined : normalizeRendererAdapter(rawInput.rendererAdapter, resources, errors)

  const payloads: Readonly<Record<PluginCapability, unknown>> = { translations, fieldAliases, enumExplanations, rules, rendererAdapter }
  for (const capability of PLUGIN_CAPABILITIES) {
    const declared = capabilities.includes(capability)
    const present = payloads[capability] !== undefined
    if (declared !== present) errors.push(`能力 ${capability} 与对应声明数据不一致`)
  }
  if (rendererAdapter && resources.length === 0) errors.push('rendererAdapter 至少需要一个资源')
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] }
  return {
    ok: true,
    value: {
      manifestVersion: 1,
      id: id as string,
      version: version as string,
      name: name as string,
      ...(description === undefined ? {} : { description }),
      capabilities,
      ...(translations === undefined ? {} : { translations }),
      ...(fieldAliases === undefined ? {} : { fieldAliases }),
      ...(enumExplanations === undefined ? {} : { enumExplanations }),
      ...(rules === undefined ? {} : { rules }),
      resources,
      ...(rendererAdapter === undefined ? {} : { rendererAdapter }),
    },
  }
}

function normalizeImportSource(input: Record<string, unknown>): PluginImportKind | null {
  const source = input.source ?? input.sourceType ?? input.kind
  if (source === 'json' || source === 'local-json') return 'json'
  if (source === 'directory' || source === 'local-directory' || source === 'dir') return 'directory'
  return null
}

function validatePluginFiles(value: unknown, source: PluginImportKind, errors: string[]): PluginFile[] {
  if (value === undefined) {
    if (source === 'directory') errors.push('目录导入必须提供文件清单')
    return []
  }
  if (!Array.isArray(value) || value.length > PLUGIN_LIMITS.maxFiles) {
    errors.push(`files 必须是不超过 ${PLUGIN_LIMITS.maxFiles} 个文件的数组`)
    return []
  }
  const paths = new Set<string>()
  const result: PluginFile[] = []
  let total = 0
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      errors.push(`files[${index}] 必须是对象`)
      continue
    }
    const rawPath = item.path
    const path = typeof rawPath === 'string' ? normalizePluginRelativePath(rawPath) : null
    const size = item.size
    const ext = path ? extension(path) : ''
    const lowerPath = path?.toLowerCase() ?? ''
    if (!path || paths.has(path)) errors.push(`files[${index}].path 无效或重复`)
    const filename = lowerPath.slice(lowerPath.lastIndexOf('/') + 1)
    const forbiddenFile = SCRIPT_OR_EXECUTABLE_EXTENSIONS.has(ext) || lowerPath.split('/').includes('node_modules') || FORBIDDEN_PACKAGE_FILENAMES.has(filename)
    if (forbiddenFile) errors.push(`files[${index}] 含脚本、可执行文件或 Node 包`)
    if (!path || !SAFE_RESOURCE_EXTENSIONS.has(ext)) errors.push(`files[${index}].path 扩展名不在允许范围`)
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > PLUGIN_LIMITS.maxFileBytes) errors.push(`files[${index}].size 超出限制`)
    if (path && !paths.has(lowerPath) && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= PLUGIN_LIMITS.maxFileBytes && !forbiddenFile && SAFE_RESOURCE_EXTENSIONS.has(ext)) {
      paths.add(lowerPath)
      result.push({ path, size })
      total += size
    }
  }
  if (total > PLUGIN_LIMITS.maxPackageBytes) errors.push('插件包总大小超出限制')
  return result
}

/** Validate an explicitly user-initiated local JSON or directory import. */
export function validatePluginImport(input: unknown): ValidationResult<ValidatedPluginImport> {
  if (!isRecord(input)) return { ok: false, errors: ['导入请求必须是对象'] }
  const errors: string[] = []
  const source = normalizeImportSource(input)
  if (!source) errors.push('插件只能从本地 JSON 文件或目录导入')
  const explicit = input.userInitiated === true || input.explicitUserAction === true || input.userConfirmed === true
  if (!explicit || input.userInitiated === false || input.explicitUserAction === false || input.userConfirmed === false) errors.push('插件导入必须由用户明确发起')
  for (const key of ['path', 'sourcePath', 'rootPath']) {
    const rawPath = input[key]
    if (rawPath !== undefined && (typeof rawPath !== 'string' || normalizePluginRelativePath(rawPath) === null)) errors.push(`${key} 不能是绝对路径或路径穿越`)
  }
  const manifestResult = validatePluginManifest(input.manifest)
  if (!manifestResult.ok) errors.push(...manifestResult.errors)
  const files = validatePluginFiles(input.files ?? input.entries, source ?? 'json', errors)
  if (source === 'directory' && manifestResult.ok) {
    const listedPaths = new Set(files.map((file) => file.path.toLowerCase()))
    for (const resource of manifestResult.value.resources) if (!listedPaths.has(resource.path.toLowerCase())) errors.push(`资源 ${resource.id} 未出现在目录文件清单中`)
  }
  if (errors.length > 0 || !source || !manifestResult.ok) return { ok: false, errors: [...new Set(errors)] }
  return { ok: true, value: { source, manifest: manifestResult.value, files } }
}

/** Aliases for callers that use bundle/package terminology. */
export const validatePluginBundle = validatePluginImport
export const validatePluginPackage = validatePluginImport

export interface PluginConflict {
  kind: 'plugin-id' | 'rule-id' | 'translation-key' | 'field-alias' | 'enum-field' | 'resource-id'
  value: string
  withPlugin?: string
}

function manifestEntries(manifest: PluginManifest): Array<[PluginConflict['kind'], string]> {
  const entries: Array<[PluginConflict['kind'], string]> = [['plugin-id', manifest.id.toLowerCase()]]
  for (const rule of manifest.rules?.rules ?? []) entries.push(['rule-id', rule.id.toLowerCase()])
  for (const [locale, values] of Object.entries(manifest.translations ?? {})) for (const key of Object.keys(values)) entries.push(['translation-key', `${locale.toLowerCase()}:${key.toLowerCase()}`])
  for (const field of Object.keys(manifest.fieldAliases ?? {})) entries.push(['field-alias', field.toLowerCase()])
  for (const field of Object.keys(manifest.enumExplanations ?? {})) entries.push(['enum-field', field.toLowerCase()])
  for (const resource of manifest.resources) entries.push(['resource-id', resource.id.toLowerCase()])
  return entries
}

/** Find global namespace collisions before a validated plugin is enabled. */
export function findPluginConflicts(manifest: PluginManifest, installed: readonly PluginManifest[] = []): PluginConflict[] {
  const conflicts: PluginConflict[] = []
  const seen = new Map<string, { kind: PluginConflict['kind']; plugin: string }>()
  for (const existing of installed) {
    for (const [kind, value] of manifestEntries(existing)) seen.set(`${kind}:${value}`, { kind, plugin: existing.id })
  }
  for (const [kind, value] of manifestEntries(manifest)) {
    const prior = seen.get(`${kind}:${value}`)
    if (prior) conflicts.push({ kind, value, withPlugin: prior.plugin })
  }
  return conflicts
}

export function validatePluginConflicts(manifest: PluginManifest, installed: readonly PluginManifest[] = []): ValidationResult<PluginManifest> {
  const conflicts = findPluginConflicts(manifest, installed)
  return conflicts.length === 0
    ? { ok: true, value: manifest }
    : { ok: false, errors: conflicts.map((conflict) => `${conflict.kind}「${conflict.value}」与插件 ${conflict.withPlugin} 冲突`) }
}

export const checkPluginConflicts = findPluginConflicts
