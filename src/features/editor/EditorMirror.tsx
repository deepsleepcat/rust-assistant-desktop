/**
 * CodeMirror 6 编辑器封装：
 * - 行号、当前行高亮、选中、撤销/重做、搜索替换（Ctrl+F）、自动补全
 * - 黑白专业主题，背景透明（配合 has-backdrop 半透明面板）
 * - Ctrl+S 保存回调
 */
import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { search, searchKeymap } from '@codemirror/search'
import { rustConfigLanguageSupport } from './rustLanguage'
import { rustCompletionSource } from './completion'
import { loadCodeData } from '../../services/codeData'

interface EditorMirrorProps {
  value: string
  onChange: (value: string) => void
  onCursor: (line: number, col: number) => void
  onSave: () => void
  fontFamily: string
  fontSize: number
}

const editorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--text-primary)',
    height: '100%',
    fontSize: 'var(--font-size, 14px)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'var(--mono-active, var(--font-mono))',
    caretColor: 'var(--text-primary)',
    padding: '8px 0',
  },
  '.cm-line': { padding: '0 14px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-muted)',
    borderRight: '1px solid var(--divider)',
    fontFamily: 'var(--font-mono)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,.04)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(0,0,0,.04)', color: 'var(--text-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(26,115,232,.18)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-0)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-md)',
    color: 'var(--text-primary)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--surface-hover)',
    color: 'var(--text-primary)',
  },
  '.cm-search': {
    backgroundColor: 'var(--surface-0)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-md)',
    padding: '8px',
  },
  '.cm-search input': {
    backgroundColor: 'var(--surface-input)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text-primary)',
  },
  '.cm-search button': {
    backgroundColor: 'var(--surface-input)',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text-primary)',
  },
  '.cm-matchingBracket': { backgroundColor: 'rgba(0,0,0,.08)' },
})

export function EditorMirror({ value, onChange, onCursor, onSave, fontFamily, fontSize }: EditorMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onCursorRef = useRef(onCursor)
  const onSaveRef = useRef(onSave)

  useEffect(() => {
    onChangeRef.current = onChange
    onCursorRef.current = onCursor
    onSaveRef.current = onSave
  }, [onChange, onCursor, onSave])

  useEffect(() => {
    void loadCodeData()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        rustConfigLanguageSupport(),
        autocompletion({ override: [rustCompletionSource], activateOnTyping: true }),
        search({ top: true }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          indentWithTab,
          { key: 'Mod-s', run: () => { onSaveRef.current(); return true } },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
          if (update.selectionSet || update.docChanged) {
            const pos = update.state.selection.main.head
            const line = update.state.doc.lineAt(pos)
            onCursorRef.current(line.number, pos - line.from + 1)
          }
        }),
        editorTheme,
      ],
    })
    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时创建一次编辑器实例
  }, [])

  // 外部 value 变化（切换标签、恢复文档）→ 同步进编辑器
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      })
    }
  }, [value])

  const monoFont = fontFamily === 'mono' ? 'var(--font-mono)' : fontFamily === 'kaiti' ? 'KaiTi, "楷体", serif' : 'var(--font-mono)'
  return (
    <div
      ref={containerRef}
      style={
        {
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          '--font-size': `${fontSize}px`,
          '--mono-active': monoFont,
        } as React.CSSProperties
      }
    />
  )
}
