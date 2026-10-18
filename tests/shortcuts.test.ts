import { afterEach, describe, expect, it, vi } from 'vitest'
import { Compartment, EditorSelection, EditorState } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { gotoLine, openSearchPanel } from '@codemirror/search'
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, matchGlobalShortcut, normalizeShortcut, resolveShortcuts, sanitizeShortcuts, shortcutConflict, shortcutFromEvent } from '../src/utils/shortcuts'
import { editorShortcutKeymap, remainingSearchKeymap } from '../src/features/editor/shortcutKeymap'
import { sanitizeSettings } from '../src/utils/settings'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge } from '../src/services/mockBridge'

function event(key: string, rest: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, repeat: false, defaultPrevented: false, target: null, getModifierState: () => false, ...rest } as KeyboardEvent
}

function target(kind: 'input' | 'code' | 'search' | 'contenteditable' | 'select'): EventTarget {
  return { closest: (selector: string) => selector === '.cm-content' ? (kind === 'code' ? {} : null) : {} } as unknown as EventTarget
}

afterEach(() => vi.unstubAllGlobals())

describe('快捷键清洗、冲突和键盘上下文', () => {
  it('旧配置完整沿用全局与 CodeMirror 默认绑定', () => {
    expect(sanitizeSettings({}).keyboardShortcuts).toEqual({})
    expect(resolveShortcuts()).toEqual({ save: 'Mod-s', undo: 'Mod-z', redo: 'Mod-y', redoAlternative: 'Mod-Shift-z', search: 'Mod-f', gotoLine: 'Mod-Alt-g', commandPalette: 'Mod-k', settings: 'Mod-,' })
    for (const { id, defaultKey } of SHORTCUT_ACTIONS) expect(shortcutConflict(id, defaultKey, {})).toBeNull()
  })

  it('规范化修饰键和大小写，拒绝普通文字与导航控制键', () => {
    expect(normalizeShortcut('Shift-Ctrl-S')).toBe('Mod-Shift-s')
    expect(normalizeShortcut('Meta-Alt-P')).toBe('Mod-Alt-p')
    expect(normalizeShortcut('F8')).toBe('F8')
    expect(normalizeShortcut('')).toBe('')
    for (const key of ['s', 'Shift-z', 'Enter', 'Tab', 'Escape', 'Mod-Mod-z', 'Mod-Unknown', 'Ctrl+S', 'Mod-Shift-Enter']) expect(normalizeShortcut(key)).toBeNull()
  })

  it('明确拒绝动作间冲突、编辑器和系统保留组合，允许释放旧绑定再分配', () => {
    expect(shortcutConflict('save', 'Mod-z', {})).toContain('撤销')
    for (const key of ['Mod-c', 'Mod-/', 'Mod-g', 'Mod-Shift-g', 'F3', 'Shift-F3', 'Mod-Shift-k', 'Alt-F4', 'Mod-w']) expect(shortcutConflict('save', key, {})).not.toBeNull()
    expect(shortcutConflict('save', 'Mod-z', { undo: '' })).toBeNull()
    expect(shortcutConflict('save', '', {})).toBeNull()
  })

  it('清洗损坏与冲突数据，不读取继承字段，清洗幂等', () => {
    expect(sanitizeShortcuts({ save: 'Ctrl-Shift-S', undo: '', rogue: 'Mod-p', search: 9 })).toEqual({ save: 'Mod-Shift-s', undo: '' })
    expect(sanitizeShortcuts(Object.create({ save: 'Mod-p' }))).toEqual({})
    expect(sanitizeShortcuts({ save: 'Mod-z', undo: 'Mod-p', search: 'Mod-p' })).toEqual({})
    expect(sanitizeShortcuts({ save: 'Mod-c', undo: false })).toEqual({})
    expect(sanitizeShortcuts([])).toEqual({})
    const valid = { save: 'Mod-Shift-s', commandPalette: 'Mod-p', redoAlternative: '' }
    expect(sanitizeShortcuts(sanitizeShortcuts(valid))).toEqual(valid)
  })

  it('阻止 IME、AltGraph、重复、已处理事件和文本控件误触发；代码区仍可打开面板', () => {
    expect(matchGlobalShortcut(event('k'), {})).toBe('commandPalette')
    expect(matchGlobalShortcut(event('K', { shiftKey: true }), {})).toBeNull()
    expect(matchGlobalShortcut(event('k', { metaKey: true, ctrlKey: false }), {})).toBe('commandPalette')
    for (const rest of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }, { getModifierState: () => true }]) expect(matchGlobalShortcut(event('k', rest), {})).toBeNull()
    for (const kind of ['input', 'search', 'contenteditable', 'select'] as const) expect(matchGlobalShortcut(event('k', { target: target(kind) }), {})).toBeNull()
    expect(matchGlobalShortcut(event('k', { target: target('code') }), {})).toBe('commandPalette')
    expect(shortcutFromEvent(event('Process', { isComposing: true }))).toBeNull()
  })

  it('改绑立即切换全局匹配，停用后不再触发，恢复后回到原组合', () => {
    const overrides = sanitizeShortcuts({ commandPalette: 'Mod-p', settings: 'Mod-Shift-p' })
    expect(matchGlobalShortcut(event('k'), overrides)).toBeNull()
    expect(matchGlobalShortcut(event('p'), overrides)).toBe('commandPalette')
    expect(matchGlobalShortcut(event('p', { shiftKey: true }), overrides)).toBe('settings')
    expect(matchGlobalShortcut(event('p'), { commandPalette: '' })).toBeNull()
    expect(matchGlobalShortcut(event('k'), {})).toBe('commandPalette')
  })

  it('macOS 不把 Ctrl 专用的 Emacs 绑定错误保留为 Command', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(shortcutConflict('commandPalette', 'Mod-p', {})).toBeNull()
    expect(shortcutConflict('save', 'Mod-Shift-k', {})).not.toBeNull()
    expect(shortcutConflict('search', DEFAULT_SHORTCUTS.search, {})).toBeNull()
  })
})

describe('CodeMirror 快捷键热更新和持久化', () => {
  it('热更新替换旧键，保留文档、选区并继续调用 store 历史回调', () => {
    const callbacks = { save: vi.fn(), undo: vi.fn(), redo: vi.fn() }
    const compartment = new Compartment()
    let state = EditorState.create({ doc: 'file contents', selection: EditorSelection.cursor(5), extensions: compartment.of(keymap.of(editorShortcutKeymap({}, callbacks))) })
    const doc = state.doc
    state = state.update({ effects: compartment.reconfigure(keymap.of(editorShortcutKeymap({ save: 'Mod-Shift-s', undo: 'Mod-Alt-z', redo: '', redoAlternative: 'Mod-Alt-y', search: 'Mod-Shift-f', gotoLine: 'Mod-Alt-j' }, callbacks))) }).state
    expect(state.doc).toBe(doc)
    expect(state.selection.main.head).toBe(5)
    const bindings = state.facet(keymap).flat()
    expect(bindings.map(({ key }) => key)).toEqual(['Mod-Shift-s', 'Mod-Alt-z', 'Mod-Alt-y', 'Mod-Shift-f', 'Mod-Alt-j'])
    for (const key of ['Mod-Shift-s', 'Mod-Alt-z', 'Mod-Alt-y']) expect(bindings.find((binding) => binding.key === key)?.run?.({} as EditorView)).toBe(true)
    expect(callbacks.save).toHaveBeenCalledOnce()
    expect(callbacks.undo).toHaveBeenCalledOnce()
    expect(callbacks.redo).toHaveBeenCalledOnce()
    expect(bindings.find(({ key }) => key === 'Mod-Shift-f')?.run).toBe(openSearchPanel)
    expect(bindings.find(({ key }) => key === 'Mod-Alt-j')?.run).toBe(gotoLine)
    expect(remainingSearchKeymap.some(({ run }) => run === openSearchPanel || run === gotoLine)).toBe(false)
    expect(remainingSearchKeymap.some(({ key }) => key === 'F3')).toBe(true)
    expect(remainingSearchKeymap.some(({ key }) => key === 'Escape')).toBe(true)
  })

  it('改绑和停用经 store 落盘、重启恢复，单项与全部恢复默认也落盘', async () => {
    const bridge = createMockBridge()
    const saved = new Map<string, unknown>()
    bridge.store.get = async (key) => saved.get(key) ?? null
    bridge.store.set = async (key, value) => { saved.set(key, structuredClone(value)) }
    const store = createWorkspaceStore(bridge)
    await store.getState().init()
    store.getState().updateSettings({ keyboardShortcuts: { save: 'Mod-Shift-s', commandPalette: 'Mod-p', redoAlternative: '' } })
    await store.getState().flushPersist()
    const restored = createWorkspaceStore(bridge)
    await restored.getState().init()
    expect(restored.getState().settings.keyboardShortcuts).toEqual({ save: 'Mod-Shift-s', commandPalette: 'Mod-p', redoAlternative: '' })
    restored.getState().updateSettings({ theme: 'dark' })
    expect(resolveShortcuts(restored.getState().settings.keyboardShortcuts).commandPalette).toBe('Mod-p')
    const singleReset = { ...restored.getState().settings.keyboardShortcuts }
    delete singleReset.save
    restored.getState().updateSettings({ keyboardShortcuts: singleReset })
    expect(resolveShortcuts(restored.getState().settings.keyboardShortcuts).save).toBe('Mod-s')
    restored.getState().updateSettings({ keyboardShortcuts: {} })
    await restored.getState().flushPersist()
    const reset = createWorkspaceStore(bridge)
    await reset.getState().init()
    expect(reset.getState().settings.keyboardShortcuts).toEqual({})
    expect(resolveShortcuts(reset.getState().settings.keyboardShortcuts)).toEqual(DEFAULT_SHORTCUTS)
  })
})
