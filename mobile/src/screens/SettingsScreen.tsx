/**
 * 设置页：主题、编辑器字号/字体、中文翻译显示层、AI（BYOK，M5 生效）、关于。
 */
import { useWorkspace } from "../stores/workspace"
import { AppIcon } from "../components/AppIcon"
import type { ThemeMode } from "../types/domain"

export function SettingsScreen() {
  const settings = useWorkspace((s) => s.settings)
  const updateSettings = useWorkspace((s) => s.updateSettings)

  return (
    <div className="m-screen">
      <header className="m-screen-header">
        <h1 className="m-screen-title">设置</h1>
      </header>
      <div className="m-scroll">
        <p className="m-group-title">外观</p>
        <div className="m-field">
          <label>主题</label>
          <select
            value={settings.theme}
            onChange={(e) => updateSettings({ theme: e.target.value as ThemeMode })}
          >
            <option value="light">浅色</option>
            <option value="dark">深色</option>
            <option value="system">跟随系统</option>
          </select>
        </div>
        <div className="m-field">
          <label>编辑器字号（{settings.fontSize}px）</label>
          <input
            type="range"
            min={12}
            max={20}
            value={settings.fontSize}
            onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
            style={{ width: "100%", minHeight: 44 }}
          />
        </div>
        <div className="m-switch-row">
          <span>中文显示层（键/节显示中文，保存回译英文）</span>
          <input
            type="checkbox"
            checked={settings.translateMode}
            onChange={(e) => updateSettings({ translateMode: e.target.checked })}
          />
        </div>

        <p className="m-group-title">AI（M5 上线）</p>
        <div className="m-field">
          <label>DeepSeek API Key（仅存本机）</label>
          <input
            type="password"
            placeholder="sk-…"
            value={settings.ai.deepseekApiKey}
            onChange={(e) =>
              updateSettings({ ai: { ...settings.ai, deepseekApiKey: e.target.value } })
            }
          />
        </div>
        <div className="m-field">
          <label>模型</label>
          <select
            value={settings.ai.deepseekModel}
            onChange={(e) =>
              updateSettings({ ai: { ...settings.ai, deepseekModel: e.target.value } })
            }
          >
            <option value="deepseek-v4-flash">deepseek-v4-flash（快）</option>
            <option value="deepseek-v4-pro">deepseek-v4-pro（强）</option>
          </select>
        </div>

        <p className="m-group-title">关于</p>
        <div className="m-switch-row">
          <span>
            铁锈助手手机版 v0.1.0
            <br />
            <small style={{ color: "var(--text-muted)" }}>随身模组编辑器 · 纯本地 · GPL-3.0</small>
          </span>
          <AppIcon name="tower" size={28} />
        </div>
      </div>
    </div>
  )
}
