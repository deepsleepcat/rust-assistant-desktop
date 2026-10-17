import type { KeyBinding } from '@codemirror/view'
import { gotoLine, openSearchPanel, searchKeymap } from '@codemirror/search'
import type { KeyboardShortcuts, ShortcutAction } from '../../types/domain'
import { resolveShortcuts } from '../../utils/shortcuts'

/** 只替换可配置的搜索入口，保留 F3/Mod-G、Escape 和多选等原生操作。 */
export const remainingSearchKeymap = searchKeymap.filter((binding) => binding.run !== openSearchPanel && binding.run !== gotoLine)

export function editorShortcutKeymap(overrides: KeyboardShortcuts, callbacks: {
  save: () => void
  undo: () => void
  redo: () => void
}): KeyBinding[] {
  const shortcuts = resolveShortcuts(overrides)
  const actions: Partial<Record<ShortcutAction, KeyBinding['run']>> = {
    save: () => { callbacks.save(); return true },
    undo: () => { callbacks.undo(); return true },
    redo: () => { callbacks.redo(); return true },
    redoAlternative: () => { callbacks.redo(); return true },
    search: openSearchPanel,
    gotoLine,
  }
  return (Object.keys(actions) as ShortcutAction[]).flatMap((action) => {
    const key = shortcuts[action]
    return key ? [{ key, run: actions[action], preventDefault: true,
      ...(action === 'search' || action === 'gotoLine' ? { scope: 'editor search-panel' } : {}),
    }] : []
  })
}
