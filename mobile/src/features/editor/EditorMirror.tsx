/**
 * CodeMirror 6 编辑器封装：
 * - 行号、当前行高亮、选中、撤销/重做、搜索替换（Ctrl+F）、自动补全
 * - 黑白专业主题，背景透明（配合 has-backdrop 半透明面板）
 * - Ctrl+S 保存回调
 */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, repositionTooltips, tooltips } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, startCompletion } from '@codemirror/autocomplete'
import { search, searchKeymap } from '@codemirror/search'
import { rustConfigLanguageSupport, smartEnterBindings } from './rustLanguage'
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
  /** 大纲/外部跳转请求：line 为 1 基行号；seq 递增保证同节重复点击也触发；external 标记外部（质检「定位」）来源 */
  jumpTo?: { line: number; seq: number; external?: boolean } | null
  /** 跳转已处理（含行越界/视图未就绪的失效场景），回传实际执行/失效的请求——外部跳转据此消费，防止陈旧请求重复触发 */
  onJumpDone?: (jump: { line: number; seq: number; external?: boolean }) => void
  /** 项目根路径（语义检查的引用完整性需要扫描单位名） */
  rootPath?: string
  /** 语义检查器开关（缺省全部开启） */
  semanticCheckers?: Record<string, boolean>
  /** 当前项目目标游戏版本名（版本兼容检查用；空 = 跟随最新） */
  targetVersionName?: string
  /** 当前文件名（checkFile 区分 .template 模板文件用） */
  fileName?: string
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
  '.cm-activeLine': { backgroundColor: 'var(--cm-active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--cm-active-line)', color: 'var(--text-primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--cm-selection)',
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
  '.cm-matchingBracket': { backgroundColor: 'var(--surface-hover)' },
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

export function EditorMirror({ value, onChange, onCursor, onSave, fontFamily, fontSize, chineseMode = false, translationMap, jumpTo, onJumpDone, rootPath, semanticCheckers, targetVersionName, fileName }: EditorMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onCursorRef = useRef(onCursor)
  const onSaveRef = useRef(onSave)
  // 语义 lint 专用槽位：配置（开关/项目根）变化时热替换，避免挂载时闭包陈旧
  // （否则设置页关掉检查器，已打开的编辑器波浪线仍按旧配置检查）
  const lintCompartment = useRef(new Compartment())

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
        lintCompartment.current.of(rustLintExtension({ rootPath, semanticCheckers, targetVersionName, file: fileName })),
        rustHoverExtension,
        autocompletion({ override: [rustCompletionSource], activateOnTyping: true }),
        tooltips({
          // 输入法弹起时可视视口底部上移：补全空间按 visualViewport 计算，
          // 候选才会在键盘上方翻转/压缩而不是落在软键盘下面
          // （默认按 documentElement 布局视口计算，看不到键盘顶部）。
          // 桌面 Electron 的 visualViewport 与布局视口一致，行为不变。
          tooltipSpace: (_view) => {
            const vv = window.visualViewport
            if (vv && vv.height > 0) {
              return { top: vv.offsetTop, left: vv.offsetLeft, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height }
            }
            return { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight }
          },
        }),
        search({ top: true }),
        keymap.of([
          ...smartEnterBindings, // 必须排在 defaultKeymap 之前：defaultKeymap 的 Enter（换行）无条件返回 true，
          // 排在后面永远轮不到；补全弹窗打开时 Enter 仍先走 Prec.highest 的 acceptCompletion（自动注册，与数组位置无关）
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
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
    // 可视视口变化（输入法弹起/收起、窗口尺寸变化、中文合成提交）→ 重定位补全浮层。
    // CodeMirror 默认只在 window resize 时重测，不感知 visualViewport
    let reopenTimer: ReturnType<typeof setTimeout> | undefined
    // 用户 Esc 显式关闭补全后的一小段时间内，IME 提交不再强制重开浮层（否则中文用户
    // 每次关掉候选都会被 compositionend 重新弹出来，无法主动关闭）
    let suppressReopenUntil = 0
    const onCompositionEnd = () => {
      repositionTooltips(view)
      if (Date.now() < suppressReopenUntil) return
      // IME 组合提交后重开补全：CodeMirror 只在组合期间「内容变化且光标移动」时
      // 自动重开（view 内部 ChangedAndMoved 分支），而中文输入组合不移动光标，
      // 提交后补全不会弹——这里补上。显式查询幂等：无候选时 source 返回 null，
      // 已有浮层时刷新列表，无副作用
      reopenTimer = setTimeout(() => {
        if (view.hasFocus) startCompletion(view)
      }, 20)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') suppressReopenUntil = Date.now() + 2000
    }
    const reposition = () => repositionTooltips(view)
    const vv = window.visualViewport
    vv?.addEventListener('resize', reposition)
    vv?.addEventListener('scroll', reposition)
    window.addEventListener('resize', reposition)
    view.dom.addEventListener('compositionend', onCompositionEnd)
    view.dom.addEventListener('keydown', onKeyDown)
    return () => {
      view.destroy()
      if (reopenTimer) clearTimeout(reopenTimer)
      vv?.removeEventListener('resize', reposition)
      vv?.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
      view.dom.removeEventListener('compositionend', onCompositionEnd)
      view.dom.removeEventListener('keydown', onKeyDown)
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时创建一次编辑器实例
  }, [])

  // 语义 lint 配置变化（检查器开关/项目根/目标版本/文件名）→ 热替换槽位（不重建编辑器）
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: lintCompartment.current.reconfigure(rustLintExtension({ rootPath, semanticCheckers, targetVersionName, file: fileName })),
    })
  }, [rootPath, semanticCheckers, targetVersionName, fileName])

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

  // 大纲/外部跳转：把光标定位到目标行首并滚动到视口中央。
  // 处理完成（含失败）都回调 onJumpDone——外部跳转据此消费请求；行越界/视图未就绪
  // 时也必须消费，否则请求残留会在之后每次重挂载时重试（行号一旦合法就意外跳转）
  useEffect(() => {
    if (!jumpTo) return
    const view = viewRef.current
    if (!view) {
      onJumpDone?.(jumpTo)
      return
    }
    const doc = view.state.doc
    if (jumpTo.line < 1 || jumpTo.line > doc.lines) {
      onJumpDone?.(jumpTo)
      return
    }
    const pos = doc.line(jumpTo.line).from
    view.dispatch({
      selection: { anchor: pos, head: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
    onJumpDone?.(jumpTo)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onJumpDone 是稳定的 store action/内联回调；跳转只应响应 jumpTo 变化
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
