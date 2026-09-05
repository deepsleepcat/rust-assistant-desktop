import { useEffect, useState } from 'react'
import { AppIcon } from '../../../components/AppIcon'
import { getBridge } from '../../../services/bridge'
import {
  createPluginState,
  findPluginConflicts,
  installPlugin,
  removePlugin,
  setPluginEnabled,
  validatePluginConflicts,
  validatePluginManifest,
  type InstalledPlugin,
  type PluginManifest,
  type PluginState,
} from '../../../features/plugins'

const PLUGINS_STORE_KEY = 'plugins'

function readPluginState(value: unknown): PluginState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createPluginState()
  const plugins = (value as { plugins?: unknown }).plugins
  if (!Array.isArray(plugins)) return createPluginState()
  const valid: InstalledPlugin[] = []
  for (const item of plugins) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const candidate = item as { manifest?: unknown; enabled?: unknown }
    const checked = validatePluginManifest(candidate.manifest)
    if (checked.ok) valid.push({ manifest: checked.value, enabled: candidate.enabled !== false })
  }
  return createPluginState(valid)
}

function serializePluginState(state: PluginState): PluginState {
  return { plugins: state.plugins.map((plugin) => ({ manifest: plugin.manifest, enabled: plugin.enabled })) }
}

function capabilityLabel(manifest: PluginManifest): string {
  return manifest.capabilities.join('、')
}

export function PluginsSettingsTab() {
  const bridge = getBridge()
  const [state, setState] = useState<PluginState>(() => createPluginState())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void bridge.store.get(PLUGINS_STORE_KEY).then((value) => {
      if (!active) return
      setState(readPluginState(value))
      setLoading(false)
    }).catch((error) => {
      if (!active) return
      setLoading(false)
      setMessage(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [bridge])

  const persist = async (next: PluginState) => {
    setState(next)
    await bridge.store.set(PLUGINS_STORE_KEY, serializePluginState(next))
  }

  const importLocal = async () => {
    if (!bridge.plugins) {
      setMessage('浏览器预览模式不支持本地插件导入')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const selection = await bridge.plugins.importLocal()
      if (!selection) return
      const conflicts = findPluginConflicts(selection.manifest, state.plugins.map((plugin) => plugin.manifest))
      if (conflicts.length > 0) {
        setMessage(`插件冲突：${conflicts.map((item) => item.value).join('、')}`)
        return
      }
      const checked = validatePluginConflicts(selection.manifest, state.plugins.map((plugin) => plugin.manifest))
      if (!checked.ok) {
        setMessage(checked.errors.join('；'))
        return
      }
      await persist(installPlugin(state, selection.manifest))
      setMessage(`已导入插件：${selection.manifest.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const updateEnabled = async (pluginId: string, enabled: boolean) => {
    setBusy(true)
    setMessage(null)
    try {
      await persist(setPluginEnabled(state, pluginId, enabled))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const uninstall = async (plugin: InstalledPlugin) => {
    setBusy(true)
    setMessage(null)
    try {
      await persist(removePlugin(state, plugin.manifest.id))
      setMessage(`已卸载插件：${plugin.manifest.name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setting-section">
      <div className="setting-title"><AppIcon name="box" size={14} /> 插件</div>
      <div className="desc" style={{ marginBottom: 12 }}>
        插件只允许声明式数据和受限绘制指令，不支持脚本、可执行文件、网络或任意文件访问。
      </div>
      <div className="setting-row">
        <span className="label">
          本地插件
          <div className="desc">仅从你明确选择的 manifest.json 或插件目录导入。</div>
        </span>
        <button className="btn primary" disabled={loading || busy || !bridge.plugins} onClick={() => void importLocal()}>
          {busy ? '处理中…' : '从本地导入'}
        </button>
      </div>
      {message && <div className="local-note community-warning">{message}</div>}
      {loading ? <div className="local-note">正在读取插件配置…</div> : state.plugins.length === 0 ? (
        <div className="local-note">尚未安装插件。</div>
      ) : (
        <div className="setting-list">
          {state.plugins.map((plugin) => (
            <div className="setting-row" key={plugin.manifest.id}>
              <span className="label">
                <strong>{plugin.manifest.name}</strong> <span className="badge">v{plugin.manifest.version}</span>
                <div className="desc">{plugin.manifest.description || '无描述'} · 能力：{capabilityLabel(plugin.manifest)}</div>
                <div className="desc">来源：本地导入 · 风险：受限声明式插件</div>
              </span>
              <button className="btn-sm" disabled={busy} onClick={() => void updateEnabled(plugin.manifest.id, !plugin.enabled)}>
                {plugin.enabled ? '禁用' : '启用'}
              </button>
              <button className="btn-sm" disabled={busy} onClick={() => void uninstall(plugin)}>卸载</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
