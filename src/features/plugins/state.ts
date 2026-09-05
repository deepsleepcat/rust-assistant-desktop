/** Pure immutable plugin lifecycle state helpers for a future settings page. */
import type { PluginManifest } from './manifest'

export interface InstalledPlugin {
  manifest: PluginManifest
  enabled: boolean
}

export interface PluginState {
  plugins: ReadonlyArray<InstalledPlugin>
}

function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneUnknown(item))
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(source)) copy[key] = cloneUnknown(source[key])
  return copy
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
  return Object.freeze(value)
}

function cloneManifest(manifest: PluginManifest): PluginManifest {
  return freezeDeep(cloneUnknown(manifest) as PluginManifest)
}

function clonePlugin(plugin: InstalledPlugin): InstalledPlugin {
  return freezeDeep({ manifest: cloneManifest(plugin.manifest), enabled: plugin.enabled })
}

function cloneState(state: PluginState): PluginState {
  return freezeDeep({ plugins: state.plugins.map((plugin) => clonePlugin(plugin)) })
}

/** Create a state snapshot, dropping duplicate IDs while preserving first-seen order. */
export function createPluginState(plugins: readonly InstalledPlugin[] = []): PluginState {
  const seen = new Set<string>()
  const result: InstalledPlugin[] = []
  for (const plugin of plugins) {
    const id = plugin.manifest.id.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    result.push(clonePlugin(plugin))
  }
  return freezeDeep({ plugins: result })
}

/** Add an already validated manifest. Duplicate IDs are idempotent. */
export function installPlugin(state: PluginState, manifest: PluginManifest, enabled = true): PluginState {
  const id = manifest.id.toLowerCase()
  if (state.plugins.some((plugin) => plugin.manifest.id.toLowerCase() === id)) return cloneState(state)
  return freezeDeep({ plugins: [...state.plugins.map((plugin) => clonePlugin(plugin)), clonePlugin({ manifest, enabled })] })
}

export const addPlugin = installPlugin

function updateEnabled(state: PluginState, pluginId: string, enabled: boolean): PluginState {
  const id = pluginId.toLowerCase()
  return freezeDeep({
    plugins: state.plugins.map((plugin) => plugin.manifest.id.toLowerCase() === id
      ? clonePlugin({ manifest: plugin.manifest, enabled })
      : clonePlugin(plugin)),
  })
}

/** Enable one plugin without mutating the input state. */
export function enablePlugin(state: PluginState, pluginId: string): PluginState {
  return updateEnabled(state, pluginId, true)
}

/** Disable one plugin without mutating the input state. */
export function disablePlugin(state: PluginState, pluginId: string): PluginState {
  return updateEnabled(state, pluginId, false)
}

/** Set enabled state explicitly; useful for settings toggles. */
export function setPluginEnabled(state: PluginState, pluginId: string, enabled: boolean): PluginState {
  return updateEnabled(state, pluginId, enabled)
}

/** Toggle one plugin. Unknown IDs remain absent and do not create state. */
export function togglePlugin(state: PluginState, pluginId: string): PluginState {
  const id = pluginId.toLowerCase()
  return freezeDeep({
    plugins: state.plugins.map((plugin) => plugin.manifest.id.toLowerCase() === id
      ? clonePlugin({ manifest: plugin.manifest, enabled: !plugin.enabled })
      : clonePlugin(plugin)),
  })
}

/** Remove a plugin by ID. Removing an unknown ID is idempotent. */
export function removePlugin(state: PluginState, pluginId: string): PluginState {
  const id = pluginId.toLowerCase()
  return { plugins: state.plugins.filter((plugin) => plugin.manifest.id.toLowerCase() !== id).map((plugin) => clonePlugin(plugin)) }
}

export const deletePlugin = removePlugin
export const uninstallPlugin = removePlugin

export function getPlugin(state: PluginState, pluginId: string): InstalledPlugin | undefined {
  const id = pluginId.toLowerCase()
  const plugin = state.plugins.find((candidate) => candidate.manifest.id.toLowerCase() === id)
  return plugin ? clonePlugin(plugin) : undefined
}

export function enabledPlugins(state: PluginState): ReadonlyArray<InstalledPlugin> {
  return state.plugins.filter((plugin) => plugin.enabled).map((plugin) => clonePlugin(plugin))
}
