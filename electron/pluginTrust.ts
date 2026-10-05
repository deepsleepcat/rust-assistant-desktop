import { normalizePath } from './paths'
import type { IpcContext } from './ipcContext'
import { createPluginState, normalizePluginRelativePath, validatePluginConflicts, validatePluginManifest, type PluginState } from '../src/features/plugins'

/** One main-process-only snapshot keeps installed declarations and resource grants together. */
export const PLUGIN_DIRS_KEY = 'pluginDirs'
interface PluginGrant { dir: string; paths: string[]; manifest?: string }
interface PluginSnapshot { version: 1; state: PluginState; grants: Record<string, PluginGrant> }
const queues = new WeakMap<IpcContext, Promise<unknown>>()

export function withPluginTransaction<T>(ctx: IpcContext, action: () => Promise<T>): Promise<T> {
  const next = (queues.get(ctx) ?? Promise.resolve()).catch(() => undefined).then(action)
  queues.set(ctx, next)
  return next
}

function snapshot(ctx: IpcContext): PluginSnapshot {
  const saved = ctx.store.get(PLUGIN_DIRS_KEY) as PluginSnapshot | undefined
  if (saved?.version === 1 && saved.state && saved.grants && typeof saved.grants === 'object' && !Array.isArray(saved.grants)) {
    try {
      const state = readPluginState(saved.state)
      const grants = Object.fromEntries(Object.entries(saved.grants).filter(([, grant]) =>
        grant && typeof grant.dir === 'string' && Array.isArray(grant.paths) &&
        grant.paths.every((relative) => typeof relative === 'string' && normalizePluginRelativePath(relative) === relative)))
      return { version: 1, state, grants }
    } catch { return { version: 1, state: createPluginState(), grants: {} } }
  }
  // Legacy directory-only grants cannot authorize resources; require reimport.
  let state = createPluginState()
  try { state = readPluginState(ctx.store.get('plugins')) } catch { /* Invalid legacy declarations are not loaded. */ }
  return { version: 1, state, grants: {} }
}

function readPluginState(raw: unknown): PluginState {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as PluginState).plugins)) return createPluginState()
  const plugins: Array<PluginState['plugins'][number]> = []
  for (const item of (raw as PluginState).plugins) {
    const checked = validatePluginManifest(item?.manifest)
    if (!checked.ok || typeof item.enabled !== 'boolean') throw new Error('插件配置无效')
    const conflicts = validatePluginConflicts(checked.value, plugins.map((plugin) => plugin.manifest))
    if (!conflicts.ok) throw new Error(conflicts.errors.join('；'))
    plugins.push({ manifest: checked.value, enabled: item.enabled })
  }
  return createPluginState(plugins)
}

export function installedPluginState(ctx: IpcContext): PluginState { return snapshot(ctx).state }

async function commit(ctx: IpcContext, next: PluginSnapshot): Promise<void> {
  await ctx.store.setDurable(PLUGIN_DIRS_KEY, next)
  ctx.pluginDirs.clear()
  for (const [id, grant] of Object.entries(next.grants)) ctx.pluginDirs.set(id, grant.dir)
}

/** Caller holds withPluginTransaction; grant paths must already be validated on disk. */
export async function registerPluginDir(ctx: IpcContext, pluginId: string, dir: string, paths: string[] = [], state = installedPluginState(ctx)): Promise<void> {
  const previous = snapshot(ctx)
  const manifest = state.plugins.find((item) => item.manifest.id.toLowerCase() === pluginId.toLowerCase())?.manifest
  await commit(ctx, { version: 1, state, grants: { ...previous.grants, [pluginId.toLowerCase()]: {
    dir: normalizePath(dir), paths, ...(manifest ? { manifest: JSON.stringify(manifest) } : {}),
  } } })
}

export async function savePluginState(ctx: IpcContext, raw: unknown): Promise<void> {
  await withPluginTransaction(ctx, async () => {
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as PluginState).plugins)) throw new Error('插件配置无效')
    const state = readPluginState(raw)
    const grants = { ...snapshot(ctx).grants }
    for (const [id, grant] of Object.entries(grants)) {
      const manifest = state.plugins.find((item) => item.manifest.id.toLowerCase() === id)?.manifest
      if (!manifest || grant.manifest !== JSON.stringify(manifest)) delete grants[id]
    }
    await commit(ctx, { version: 1, state, grants })
  })
}

export async function unregisterPluginDir(ctx: IpcContext, pluginId: string): Promise<void> {
  await withPluginTransaction(ctx, async () => {
    const previous = snapshot(ctx)
    const grants = { ...previous.grants }
    delete grants[pluginId.toLowerCase()]
    await commit(ctx, { ...previous, grants })
  })
}

export function restorePluginDirs(ctx: IpcContext): void {
  ctx.pluginDirs.clear()
  for (const [id, grant] of Object.entries(snapshot(ctx).grants)) {
    if (typeof grant.dir === 'string' && Array.isArray(grant.paths)) ctx.pluginDirs.set(id, normalizePath(grant.dir))
  }
}

export function pluginDirOf(ctx: IpcContext, pluginId: string): string | null {
  return ctx.pluginDirs.get(pluginId.toLowerCase()) ?? null
}

export function pluginResourceAllowed(ctx: IpcContext, pluginId: string, relative: string): boolean {
  return snapshot(ctx).grants[pluginId.toLowerCase()]?.paths.includes(relative) === true
}
