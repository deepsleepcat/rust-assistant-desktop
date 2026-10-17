import { useId, useState, type KeyboardEvent } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import type { ShortcutAction } from '../../../types/domain'
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, formatShortcut, resolveShortcuts, shortcutConflict, shortcutFromEvent } from '../../../utils/shortcuts'
import { useEscapeHandler } from '../../../utils/modalStack'

/** 独立设置页组件：所有成功修改经 updateSettings 清洗并持久化。 */
export function ShortcutSettingsTab() {
  const overrides = useWorkspaceStore((s) => s.settings.keyboardShortcuts)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [error, setError] = useState<{ action: ShortcutAction; message: string } | null>(null)
  const prefix = useId()
  const shortcuts = resolveShortcuts(overrides)

  useEscapeHandler(() => {
    setRecording(null)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }, recording !== null)

  function change(action: ShortcutAction, key?: string): boolean {
    const current = useWorkspaceStore.getState().settings.keyboardShortcuts
    const next = { ...current }
    if (key === undefined || key === DEFAULT_SHORTCUTS[action]) delete next[action]
    else next[action] = key
    const conflict = shortcutConflict(action, resolveShortcuts(next)[action], next)
    if (conflict) {
      setError({ action, message: conflict })
      return false
    }
    updateSettings({ keyboardShortcuts: next })
    setError(null)
    setRecording(null)
    return true
  }

  function record(action: ShortcutAction, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    if (event.key === 'Escape') {
      setRecording(null)
      event.currentTarget.blur()
      return
    }
    if (recording !== action || event.repeat || ['Control', 'Meta', 'Shift', 'Alt'].includes(event.key)) return
    const key = shortcutFromEvent(event.nativeEvent)
    if (!key) {
      setError({ action, message: '请按 Ctrl / Command 或 Alt 与字母、数字或标点的组合，也可使用功能键。' })
      return
    }
    if (change(action, key)) event.currentTarget.blur()
  }

  return (
    <section className="setting-section" aria-labelledby={`${prefix}-title`}>
      <div className="setting-title" id={`${prefix}-title`}>快捷键</div>
      <p className="desc" id={`${prefix}-help`}>
        点击快捷键后按下新组合，成功后立即生效并自动保存。Tab 切换控件，Esc 取消录入。
        Ctrl 在 macOS 对应 Command。编辑器操作仅在代码区生效，普通输入框保留原有输入行为。
      </p>
      <div aria-live="polite" className="desc">
        {recording ? `正在录入「${SHORTCUT_ACTIONS.find(({ id }) => id === recording)?.label}」…` : '选择一项快捷键进行修改。'}
      </div>
      {SHORTCUT_ACTIONS.map(({ id, label, scope, defaultKey }) => (
        <div key={id}>
          <div className="setting-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <label className="label" htmlFor={`${prefix}-${id}`}>
              {label}
              <span className="desc" style={{ display: 'block' }}>{scope === 'editor' ? '编辑器' : '全局'} · 默认 {formatShortcut(defaultKey)}</span>
            </label>
            <input
              id={`${prefix}-${id}`}
              type="text"
              readOnly
              value={recording === id ? '请按下新组合…' : formatShortcut(shortcuts[id])}
              aria-label={`设置${label}快捷键`}
              aria-describedby={`${prefix}-help${error?.action === id ? ` ${prefix}-${id}-error` : ''}`}
              aria-invalid={error?.action === id || undefined}
              style={{ width: 180, maxWidth: '100%', cursor: 'pointer', textAlign: 'center' }}
              onFocus={() => { setRecording(id); setError(null) }}
              onClick={() => setRecording(id)}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => record(id, event)}
            />
            <button className="btn" disabled={!shortcuts[id]} onClick={() => change(id, '')} aria-label={`停用${label}快捷键`}>停用</button>
            <button className="btn" disabled={overrides[id] === undefined} onClick={() => change(id)} aria-label={`恢复${label}默认快捷键`}>恢复默认</button>
          </div>
          {error?.action === id && <p className="setting-error" role="alert" id={`${prefix}-${id}-error`}>{error.message}</p>}
        </div>
      ))}
      <div className="setting-divider" />
      <div className="setting-row">
        <span className="label">全部快捷键<div className="desc">恢复应用原有组合，包括两组重做快捷键。</div></span>
        <button className="btn" disabled={Object.keys(overrides).length === 0} onClick={() => {
          updateSettings({ keyboardShortcuts: {} })
          setRecording(null)
          setError(null)
        }}>全部恢复默认</button>
      </div>
    </section>
  )
}
