import { validatePluginManifest, type RendererAdapterDescriptor } from './manifest'

export interface EnabledRendererAdapter extends RendererAdapterDescriptor {
  pluginId: string
}

/** Select only a registered host implementation with a valid, enabled persisted declaration. */
export function selectEnabledRendererAdapter(
  raw: unknown,
  registeredIds: readonly string[],
  builtinId: string,
): EnabledRendererAdapter | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const plugins = (raw as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return null
  const registered = new Set(registeredIds.map((id) => id.toLowerCase()))
  for (const item of plugins) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as { enabled?: unknown; manifest?: unknown }
    if (entry.enabled !== true) continue
    const checked = validatePluginManifest(entry.manifest)
    if (!checked.ok) continue
    const { id, rendererAdapter } = checked.value
    if (!rendererAdapter || id.toLowerCase() === builtinId.toLowerCase() || !registered.has(id.toLowerCase())) continue
    return { pluginId: id, ...rendererAdapter }
  }
  return null
}
