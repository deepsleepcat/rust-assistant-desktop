/**
 * CodeMirror 6 编辑器封装：
 * - 行号、当前行高亮、选中、撤销/重做、搜索替换（Ctrl+F）、自动补全
 * - 黑白专业主题，背景透明（配合 has-backdrop 半透明面板）
 * - Ctrl+S 保存回调
 */
import { useEffect, useRef } from 'react'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { search, searchKeymap } from '@codemirror/search'
import { rustConfigLanguageSupport } from './rustLanguage'
import { rustHoverExtension } from './rustHover'
import { rustCompletionSource, setCompletionChineseMode, setCompletionTracker } from './completion'
import { foldGutter, foldKeymap } from '@codemirror/language'
import { lintGutter, lintKeymap } from '@codemirror/lint'
import { colorDecorationExtension } from './colorDecorationsExtension'
import { rustSectionFolding } from './sectionFolding'
import { rustLintExtension } from './rustLint'
import { loadCodeData } from '../../services/codeData'

interface EditorMirrorProps {
  value: string
  onChange: (value: string) => void
  onCursor: (line: number, col: number) => void
  onSave: () => void
  fontFamily: string
  fontSize: number
  /** 中文显示层开启时，补全提交中文键/节名（保存时自动回译） */
  chineseMode?: boolean
  /** 翻译追踪表：补全提交的中文登记进去，保存时才能回译成英文 */
  translationMap?: Map<string, string> | null
  /** 大纲跳转请求：line 为 1 基行号；seq 递增保证同节重复点击也触发 */
  jumpTo?: { line: number; seq: number } | null
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
  // 值合法性检查（lint）标记：红色波浪线 + 槽内标记，保持黑白专业主题
  '.cm-lintRange-error': {
    backgroundImage: 'linear-gradient(to right, transparent 40%, var(--danger, #c5221f) 40%)',
    backgroundPosition: 'bottom',
    backgroundRepeat: 'repeat-x',
    backgroundSize: '4px 2px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'linear-gradient(to right, transparent 40%, var(--warn, #d99014) 40%)',
    backgroundPosition: 'bottom',
    backgroundRepeat: 'repeat-x',
    backgroundSize: '4px 2px',
  },
  '.cm-lint-marker-error, .cm-lint-marker-warning': {
    color: 'var(--danger, #c5221f)',
  },
  '.cm-tooltip-lint': {
    fontSize: '12px',
  },
})

export function EditorMirror({ value, onChange, onCursor, onSave, fontFamily, fontSize, chineseMode = false, translationMap, jumpTo }: EditorMirrorProps) {
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

  // 中文显示层切换 → 补全提交文本同步（中文键/节名）；卸载时复位为英文模式
  useEffect(() => {
    setCompletionChineseMode(chineseMode)
    return () => setCompletionChineseMode(false)
  }, [chineseMode])

  // 翻译追踪表注入补全：中文模式下补全提交的新键登记后，保存时才能回译
  useEffect(() => {
    setCompletionTracker(chineseMode ? (translationMap ?? null) : null)
    return () => setCompletionTracker(null)
  }, [chineseMode, translationMap])

  useEffect(() => {
    void loadCodeData()
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        lintGutter(),
        rustSectionFolding,
        colorDecorationExtension,
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        rustConfigLanguageSupport(),
        rustLintExtension(),
        rustHoverExtension,
        autocompletion({ override: [rustCompletionSource], activateOnTyping: true }),
        search({ top: true }),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          ...completionKeymap,
          ...foldKeymap,
          ...lintKeymap,
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
      // 不进撤销历史（addToHistory annotation）——程序化整档替换（切中文视图/格式化/
      // 恢复文档）否则 Ctrl+Z 会把整档回退到旧视图，而 store 里翻译开关已切换，视图与状态不一致
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      })
    }
  }, [value])

  // 大纲跳转：把光标定位到目标行首并滚动到视口中央
  useEffect(() => {
    if (!jumpTo) return
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc
    if (jumpTo.line < 1 || jumpTo.line > doc.lines) return
    const pos = doc.line(jumpTo.line).from
    view.dispatch({
      selection: { anchor: pos, head: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
  }, [jumpTo])

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
