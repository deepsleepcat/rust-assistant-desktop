import { defaultKeymap } from '@codemirror/commands'
import { searchKeymap } from '@codemirror/search'
import { foldKeymap } from '@codemirror/language'
import { lintKeymap } from '@codemirror/lint'
import type { KeyboardShortcuts, ShortcutAction } from '../types/domain'

export const SHORTCUT_ACTIONS = [
  { id: 'save', label: '保存文件', scope: 'editor', defaultKey: 'Mod-s' },
  { id: 'undo', label: '撤销', scope: 'editor', defaultKey: 'Mod-z' },
  { id: 'redo', label: '重做', scope: 'editor', defaultKey: 'Mod-y' },
  { id: 'redoAlternative', label: '重做（第二组）', scope: 'editor', defaultKey: 'Mod-Shift-z' },
  { id: 'search', label: '搜索 / 替换', scope: 'editor', defaultKey: 'Mod-f' },
  { id: 'gotoLine', label: '跳转到行', scope: 'editor', defaultKey: 'Mod-Alt-g' },
  { id: 'commandPalette', label: '命令面板', scope: 'global', defaultKey: 'Mod-k' },
  { id: 'settings', label: '打开设置', scope: 'global', defaultKey: 'Mod-,' },
] as const satisfies ReadonlyArray<{ id: ShortcutAction; label: string; scope: 'editor' | 'global'; defaultKey: string }>

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map(({ id, defaultKey }) => [id, defaultKey]),
) as Record<ShortcutAction, string>

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

/** 单个按键组合，Mod 在 Windows/Linux 为 Ctrl，在 macOS 为 Command。 */
export function normalizeShortcut(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 80) return null
  if (raw === '') return ''
  const parts = raw.trim().split('-')
  const key = parts.pop()?.toLowerCase()
  if (!key || !(/^([a-z0-9,./;[\]\\`=]|f(?:[1-9]|1[0-2]))$/.test(key))) return null
  const modifiers = new Set<string>()
  for (const part of parts) {
    const modifier = ({ mod: 'Mod', ctrl: 'Mod', meta: 'Mod', cmd: 'Mod', shift: 'Shift', alt: 'Alt' } as Record<string, string>)[part.toLowerCase()]
    if (!modifier || modifiers.has(modifier)) return null
    modifiers.add(modifier)
  }
  // 不允许覆盖普通打字、导航、Tab/Enter/Escape；功能键可单独使用。
  if (!modifiers.has('Mod') && !modifiers.has('Alt') && !/^f\d+$/.test(key)) return null
  return [...['Mod', 'Alt', 'Shift'].filter((m) => modifiers.has(m)), /^f\d+$/.test(key) ? key.toUpperCase() : key].join('-')
}

/** 保留 CodeMirror 的编辑/补全/搜索导航快捷键，避免改绑后截断其内置行为。 */
function reservedShortcuts(): Set<string> {
  const mac = isMacPlatform()
  const keys = new Set(['Mod-c', 'Mod-v', 'Mod-x', 'Mod-a', 'Mod-q', 'Mod-w', 'Mod-r', 'Mod-Shift-r', 'Mod-Shift-i', 'Alt-F4', 'F1', 'F5', 'F11', 'F12'])
  for (const binding of [...defaultKeymap, ...searchKeymap, ...foldKeymap, ...lintKeymap]) {
    const key = (mac ? binding.mac : binding.win) ?? binding.key
    if (!key || (mac && key.includes('Ctrl-'))) continue
    const normalized = normalizeShortcut(key)
    if (!normalized || normalized === DEFAULT_SHORTCUTS.search || normalized === DEFAULT_SHORTCUTS.gotoLine) continue
    keys.add(normalized)
    if (binding.shift) {
      const shifted = normalizeShortcut(`Shift-${key}`)
      if (shifted) keys.add(shifted)
    }
  }
  return keys
}

export function resolveShortcuts(overrides: KeyboardShortcuts = {}): Record<ShortcutAction, string> {
  return { ...DEFAULT_SHORTCUTS, ...overrides }
}

export function shortcutConflict(action: ShortcutAction, key: string, overrides: KeyboardShortcuts): string | null {
  if (!key) return null
  const other = SHORTCUT_ACTIONS.find(({ id }) => id !== action && resolveShortcuts(overrides)[id] === key)
  if (other) return `与「${other.label}」冲突，请先修改或停用该快捷键。`
  if (reservedShortcuts().has(key)) return '该组合已用于编辑器内置操作或系统操作，请选择其它组合。'
  return null
}

/** 只存有效覆盖；损坏或冲突数据回退默认，空字符串表示明确停用。 */
export function sanitizeShortcuts(raw: unknown): KeyboardShortcuts {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: KeyboardShortcuts = {}
  for (const { id, defaultKey } of SHORTCUT_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue
    const key = normalizeShortcut((raw as Record<string, unknown>)[id])
    if (key !== null && key !== defaultKey) result[id] = key
  }
  // 删除一个覆盖后可能重新占用另一个覆盖的键，重复至稳定。
  while (true) {
    const conflicting = SHORTCUT_ACTIONS.filter(({ id }) => result[id] !== undefined && shortcutConflict(id, result[id], result))
    if (conflicting.length === 0) break
    for (const { id } of conflicting) delete result[id]
  }
  return result
}

export function formatShortcut(key: string): string {
  if (!key) return '未设置'
  return key.split('-').map((part) => part === 'Mod' ? (isMacPlatform() ? '⌘' : 'Ctrl') : part.length === 1 ? part.toUpperCase() : part).join(' + ')
}

export function shortcutFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'keyCode' | 'getModifierState'>): string | null {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return null
  return normalizeShortcut([
    ...(event.ctrlKey || event.metaKey ? ['Mod'] : []),
    ...(event.altKey ? ['Alt'] : []),
    ...(event.shiftKey ? ['Shift'] : []),
    event.key,
  ].join('-'))
}

export function isTextInput(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return !!element?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
}

/** 在冒泡阶段处理：CodeMirror 已处理的键、录入控件、IME 和重复按键均不触发全局操作。 */
export function matchGlobalShortcut(event: KeyboardEvent, overrides: KeyboardShortcuts): ShortcutAction | null {
  const inCode = !!(event.target as HTMLElement | null)?.closest?.('.cm-content')
  if (event.defaultPrevented || event.repeat || (isTextInput(event.target) && !inCode)) return null
  const key = shortcutFromEvent(event)
  if (!key) return null
  const effective = resolveShortcuts(overrides)
  return SHORTCUT_ACTIONS.find(({ id, scope }) => scope === 'global' && effective[id] === key)?.id ?? null
}
