import { validatePluginManifest, type PluginManifest } from './manifest'
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
  /** M41：已启用插件声明的渲染器扩展点（宿主据此判断「有没有插件可接管渲染」） */
  rendererAdapters: EnabledRendererAdapter[]
}

/** 一个已启用插件声明的渲染器扩展点 */
export interface EnabledRendererAdapter {
  pluginId: string
  pluginName: string
  /** 插件自带的图像资源（渲染器可引用；实际读盘由 plugin:readResource 按需进行） */
  resources: Array<{ id: string; path: string }>
  /** 插件声明的能力边界：允许的指令类型与预算（宿主据此收窄校验，插件不能自行放宽） */
  allowedCommands: string[]
  resourceIds: string[]
  maxCommands: number
  maxResponseBytes: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeText(value: unknown, max: number): value is string {
  // eslint-disable-next-line no-control-regex -- 控制字符在声明式数据里不可见且易被滥用，必须拒绝
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
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

/** Manifest has already passed the canonical validator. */
function readRendererAdapter(manifest: PluginManifest, output: EnabledRendererAdapter[]): void {
  const adapter = manifest.rendererAdapter
  if (!adapter) return
  output.push({
    pluginId: manifest.id.toLowerCase(),
    pluginName: manifest.name,
    resources: manifest.resources.filter((resource) => resource.kind === 'image').map(({ id, path }) => ({ id, path })),
    allowedCommands: [...adapter.allowedCommands],
    resourceIds: [...adapter.resourceIds],
    maxCommands: adapter.maxCommands,
    maxResponseBytes: adapter.maxResponseBytes,
  })
}

/** Read only enabled, persisted declarations. This layer has no bridge, filesystem, or execution dependency. */
export function loadEnabledPluginData(raw: unknown): EnabledPluginData {
  const result: EnabledPluginData = { translations: [], aliases: [], enumExplanations: {}, rules: [], rendererAdapters: [] }
  if (!isRecord(raw) || !Array.isArray(raw.plugins)) return result
  for (const item of raw.plugins) {
    if (!isRecord(item) || item.enabled !== true) continue
    const checked = validatePluginManifest(item.manifest)
    if (!checked.ok) continue
    const manifest = checked.value
    readTranslations(manifest.translations, result.translations)
    readAliases(manifest.fieldAliases, result.aliases)
    readEnumExplanations(manifest.enumExplanations, result.enumExplanations)
    readRules(manifest.rules, result.rules)
    readRendererAdapter(manifest, result.rendererAdapters)
  }
  return result
}

/**
 * 挑选可接管预览渲染的插件适配器（M41，纯函数，供预览侧消费）。
 *
 * 两个条件缺一不可：
 * 1. 插件已启用且声明了 rendererAdapter（由 loadEnabledPluginData 筛出）；
 * 2. 宿主为它的 pluginId **注册了实现**——声明只是「想接管」，实现才是「能接管」。
 *
 * 内置适配器的 id 必须排除：它是回退实现，不是插件。
 */
export function selectRendererAdapter(
  adapters: ReadonlyArray<EnabledRendererAdapter>,
  registeredAdapterIds: ReadonlyArray<string>,
  builtinAdapterId: string,
): EnabledRendererAdapter | null {
  const registered = new Set(registeredAdapterIds.map((id) => id.toLowerCase()))
  const builtin = builtinAdapterId.toLowerCase()
  return adapters.find((adapter) => adapter.pluginId !== builtin && registered.has(adapter.pluginId)) ?? null
}
