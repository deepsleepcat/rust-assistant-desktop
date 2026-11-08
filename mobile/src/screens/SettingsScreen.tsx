/**
 * 设置页：主题、编辑器（字体/字号/文件树）、中文翻译显示层、语义检查器（含目标版本）、
 * AI（BYOK，M5 生效）、关于。
 * 对齐桌面端 EditorSettingsTab 的手机端可用子集：语义检查器开关、目标游戏版本、
 * 编辑器字体、文件树排序与隐藏文件。
 */
import { useEffect, useState } from 'react'
import { useWorkspace } from '../stores/workspace'
import { AppIcon } from '../components/AppIcon'
import { FONT_OPTIONS, FILE_SORTS } from '../utils/settings'
import { ALL_SEMANTIC_CHECKERS } from '../features/editor/semanticChecks/registry'
import { getGameVersions, loadCodeData, type GameVersionInfo } from '../services/codeData'
import type { FileSort, ThemeMode } from '../types/domain'

/** 文件树排序方式的界面文案 */
const FILE_SORT_LABELS: Record<FileSort, string> = {
  name: '名称',
  type: '类型',
  size: '大小',
  mtime: '修改时间',
}

export function SettingsScreen() {
  const settings = useWorkspace((s) => s.settings)
  const updateSettings = useWorkspace((s) => s.updateSettings)
  // 目标游戏版本下拉数据（异步加载版本表；失败时只显示「跟随最新」）
  const [gameVersions, setGameVersions] = useState<GameVersionInfo[]>([])

  useEffect(() => {
    let alive = true
    void loadCodeData()
      .then(() => {
        if (alive) setGameVersions(getGameVersions())
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

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

        <p className="m-group-title">编辑器与文件树</p>
        <div className="m-field">
          <label>字体</label>
          <select
            value={settings.fontFamily}
            onChange={(e) => updateSettings({ fontFamily: e.target.value })}
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
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
        <div className="m-field">
          <label>文件树排序（文件夹始终优先）</label>
          <select
            value={settings.fileSort}
            onChange={(e) => updateSettings({ fileSort: e.target.value as FileSort })}
          >
            {FILE_SORTS.map((s) => (
              <option key={s} value={s}>
                {FILE_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="m-switch-row">
          <span>显示隐藏文件（以 . 开头）</span>
          <input
            type="checkbox"
            checked={settings.showHiddenFiles}
            onChange={(e) => updateSettings({ showHiddenFiles: e.target.checked })}
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

        <p className="m-group-title">语义检查</p>
        <p className="m-group-desc">检查页、编辑器波浪线与 AI 写后质检共用这些规则，可单独开关。</p>
        <div className="m-field">
          <label>目标游戏版本（超出该版本的字段会提示）</label>
          <select
            value={settings.targetGameVersion}
            onChange={(e) => updateSettings({ targetGameVersion: e.target.value })}
          >
            <option value="">
              跟随最新{gameVersions.length > 0 ? `（${gameVersions[gameVersions.length - 1].versionName}）` : ''}
            </option>
            {gameVersions.map((v) => (
              <option key={v.versionNumber} value={v.versionName}>
                {v.versionName}
              </option>
            ))}
          </select>
        </div>
        <div className="checker-list">
          {ALL_SEMANTIC_CHECKERS.map((c) => {
            const on = settings.semanticCheckers[c.id] !== false
            return (
              <label key={c.id} className="checker-item">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    updateSettings({ semanticCheckers: { ...settings.semanticCheckers, [c.id]: e.target.checked } })
                  }
                />
                <span className="checker-name">{c.title}</span>
                <span className="checker-desc">{c.description}</span>
              </label>
            )
          })}
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
            铁锈工坊 v0.1.0
            <br />
            <small style={{ color: 'var(--text-muted)' }}>随身模组编辑器 · 纯本地 · GPL-3.0</small>
          </span>
          <AppIcon name="tower" size={28} />
        </div>
      </div>
    </div>
  )
}
