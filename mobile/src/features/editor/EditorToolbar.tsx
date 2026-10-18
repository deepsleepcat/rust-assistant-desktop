/**
 * 手机端编辑器工具栏。
 *
 * 移动端没有 Ctrl/Cmd 组合键，撤销、重做、搜索、缩进、补全、常用符号
 * 只能靠按钮触发。所有按钮在 onMouseDown 里阻止默认行为：
 * 点按钮不抢编辑器焦点、不收起软键盘，插入符号因此落在用户最后停留的
 * 光标/选区位置（CodeMirror 失焦仍保留 state.selection）。
 */
import { AppIcon } from '../../components/AppIcon'
import type { EditorCommandApi } from './EditorMirror'

/** 铁锈配置里高频但手机键盘不好打的符号 */
const SYMBOLS = ['[', ']', ':', '_', '=', ','] as const

interface EditorToolbarProps {
  api: EditorCommandApi | null
}

export function EditorToolbar({ api }: EditorToolbarProps) {
  const keepFocus = (e: React.MouseEvent) => e.preventDefault()
  const run = (fn: (a: EditorCommandApi) => void) => () => {
    if (api) fn(api)
  }

  return (
    <div className="m-editor-toolbar" role="toolbar" aria-label="编辑工具">
      <button className="m-tool-btn" onMouseDown={keepFocus} onClick={run((a) => a.undo())} disabled={!api} aria-label="撤销">
        <AppIcon name="undo" size={16} />
      </button>
      <button className="m-tool-btn" onMouseDown={keepFocus} onClick={run((a) => a.redo())} disabled={!api} aria-label="重做">
        <AppIcon name="redo" size={16} />
      </button>
      <button className="m-tool-btn" onMouseDown={keepFocus} onClick={run((a) => a.openSearch())} disabled={!api} aria-label="搜索替换">
        <AppIcon name="search" size={16} />
      </button>
      <button className="m-tool-btn" onMouseDown={keepFocus} onClick={run((a) => a.indent())} disabled={!api} aria-label="增加缩进">
        <AppIcon name="layout" size={16} />
      </button>
      <span className="m-tool-sep" aria-hidden="true" />
      {SYMBOLS.map((symbol) => (
        <button
          key={symbol}
          className="m-tool-btn symbol"
          onMouseDown={keepFocus}
          onClick={run((a) => a.insertText(symbol))}
          disabled={!api}
          aria-label={`插入 ${symbol}`}
        >
          {symbol}
        </button>
      ))}
      <span className="m-tool-sep" aria-hidden="true" />
      <button className="m-tool-btn" onMouseDown={keepFocus} onClick={run((a) => a.triggerCompletion())} disabled={!api} aria-label="触发补全">
        <AppIcon name="sparkle" size={16} />
      </button>
    </div>
  )
}
