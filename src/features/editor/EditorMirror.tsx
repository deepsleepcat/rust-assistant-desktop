/**
 * CodeMirror 6 编辑器封装：
 * - 行号、当前行高亮、选中、撤销/重做、搜索替换（Ctrl+F）、自动补全
 * - 黑白专业主题，背景透明（配合 has-backdrop 半透明面板）
 * - Ctrl+S 保存回调
 */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, repositionTooltips, tooltips } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, CompletionContext, startCompletion } from '@codemirror/autocomplete'
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
import { shouldReopenAfterComposition } from './imeCompletion'

interface EditorMirrorProps {
  value: string
  onChange: (value: string) => void
  onCursor: (line: number, col: number) => void
  onSave: () => void
  /** 每 tab 统一编辑历史：代码快捷键调用 store，而非实例级 CodeMirror history */
  onUndo?: () => void
  onRedo?: () => void
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
    // M34：补全/悬浮提示浮层层级明确化——高于工具栏溢出菜单(z80)
    // 与紧凑抽屉(z90)、mod-tools 菜单(z60)，低于全局弹窗(z200)
    zIndex: 95,
  },
  // M34：候选过多时在提示框内滚动，避免撑出编辑器/视口被裁切；
  // 宽度贴着可用视口约束（补全候选行可能很长）。
  // 注意：ul 选择器必须带 .cm-tooltip 前缀与 CodeMirror baseTheme 同级
  // specificity（.ͼb .cm-tooltip.cm-tooltip-autocomplete > ul），否则被
  // baseTheme 的 max-height:10em 覆盖，高度限制不生效
  '.cm-tooltip-autocomplete': {
    maxHeight: 'min(340px, 55vh)',
    maxWidth: 'min(560px, calc(100vw - 24px))',
    display: 'flex',
    flexDirection: 'column',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    overflowY: 'auto',
    maxHeight: 'min(300px, 48vh)',
    maxWidth: '100%',
  },
  '.cm-tooltip-autocomplete > ul li': {
    overflowX: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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

export function EditorMirror({ value, onChange, onCursor, onSave, onUndo, onRedo, fontFamily, fontSize, chineseMode = false, translationMap, jumpTo, onJumpDone, rootPath, semanticCheckers, targetVersionName, fileName }: EditorMirrorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onCursorRef = useRef(onCursor)
  const onSaveRef = useRef(onSave)
  const onUndoRef = useRef(onUndo)
  const onRedoRef = useRef(onRedo)
  const syncingRef = useRef(false)
  // 语义 lint 专用槽位：配置（开关/项目根）变化时热替换，避免挂载时闭包陈旧
  // （否则设置页关掉检查器，已打开的编辑器波浪线仍按旧配置检查）
  const lintCompartment = useRef(new Compartment())

  useEffect(() => {
    onChangeRef.current = onChange
    onCursorRef.current = onCursor
    onSaveRef.current = onSave
    onUndoRef.current = onUndo
    onRedoRef.current = onRedo
  }, [onChange, onCursor, onSave, onUndo, onRedo])

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
        // 统一历史由 workspace store 管理；CM 仅负责显示受控内容，避免切 tab/表单模式丢栈。
        rustConfigLanguageSupport(),
        lintCompartment.current.of(rustLintExtension({ rootPath, semanticCheckers, targetVersionName, file: fileName, translationMap: chineseMode ? translationMap : null })),
        rustHoverExtension,
        // aboveCursor：补全框显示在光标上方——中文输入时系统输入法候选窗
        // 在光标正下方，框在下方会被完全挡住（表现为「中文补全不可用」；
        // 空间不足时 CodeMirror 会自动翻回下方，不丢失候选）
        autocompletion({ override: [rustCompletionSource], activateOnTyping: true, aboveCursor: true }),
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
          { key: 'Mod-z', run: () => { onUndoRef.current?.(); return true } },
          { key: 'Mod-y', run: () => { onRedoRef.current?.(); return true } },
          { key: 'Mod-Shift-z', run: () => { onRedoRef.current?.(); return true } },
          ...smartEnterBindings, // 必须排在 defaultKeymap 之前：defaultKeymap 的 Enter（换行）无条件返回 true，
          // 排在后面永远轮不到；补全弹窗打开时 Enter 仍先走 Prec.highest 的 acceptCompletion（自动注册，与数组位置无关）
          ...defaultKeymap,
          ...searchKeymap,
          ...foldKeymap,
          ...lintKeymap,
          indentWithTab,
          { key: 'Mod-s', run: () => { onSaveRef.current(); return true } },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncingRef.current) {
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
    let compositionStartDoc: string | null = null
    // 用户 Esc 显式关闭补全后的一小段时间内，IME 提交不再强制重开浮层（否则中文用户
    // 每次关掉候选都会被 compositionend 重新弹出来，无法主动关闭）
    let suppressReopenUntil = 0
    const onCompositionStart = () => {
      compositionStartDoc = view.state.doc.toString()
    }
    const onCompositionEnd = () => {
      repositionTooltips(view)
      const startedDoc = compositionStartDoc
      compositionStartDoc = null
      if (!shouldReopenAfterComposition({
        startedDoc,
        endedDoc: view.state.doc.toString(),
        hasFocus: view.hasFocus,
        now: Date.now(),
        suppressReopenUntil,
      })) return
      // 组合提交后只在当前上下文确实有候选时刷新。普通中文文本、取消组合和
      // 非键值上下文都不会因为显式触发而弹出全局候选。
      const submittedDoc = view.state.doc.toString()
      reopenTimer = setTimeout(() => {
        if (!view.hasFocus || view.state.doc.toString() !== submittedDoc) return
        const pos = view.state.selection.main.head
        void rustCompletionSource(new CompletionContext(view.state, pos, false)).then((result) => {
          if (result && view.hasFocus && view.state.doc.toString() === submittedDoc) startCompletion(view)
        })
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
    view.dom.addEventListener('compositionstart', onCompositionStart)
    view.dom.addEventListener('compositionend', onCompositionEnd)
    view.dom.addEventListener('keydown', onKeyDown)
    return () => {
      view.destroy()
      if (reopenTimer) clearTimeout(reopenTimer)
      vv?.removeEventListener('resize', reposition)
      vv?.removeEventListener('scroll', reposition)
      window.removeEventListener('resize', reposition)
      view.dom.removeEventListener('compositionstart', onCompositionStart)
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
      effects: lintCompartment.current.reconfigure(rustLintExtension({ rootPath, semanticCheckers, targetVersionName, file: fileName, translationMap: chineseMode ? translationMap : null })),
    })
  }, [rootPath, semanticCheckers, targetVersionName, fileName, translationMap, chineseMode])

  // 外部 value 变化（切换标签、恢复文档）→ 同步进编辑器
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (view.state.doc.toString() !== value) {
      // 不进撤销历史（addToHistory annotation）——程序化整档替换（切中文视图/格式化/
      // 恢复文档）否则 Ctrl+Z 会把整档回退到旧视图，而 store 里翻译开关已切换，视图与状态不一致
      syncingRef.current = true
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.addToHistory.of(false),
      })
      syncingRef.current = false
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
