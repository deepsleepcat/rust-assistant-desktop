import { foldService } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

type FoldService = (state: EditorState, lineStart: number) => { from: number; to: number } | null

/** 按 [section] 标题折叠到下一个 section 之前，标题行本身保留。 */
export const rustSectionFoldService: FoldService = (state: EditorState, lineStart: number) => {
  const line = state.doc.lineAt(lineStart)
  if (!/^\s*\[.+?\]\s*$/.test(line.text)) return null

  let nextStart = state.doc.length
  for (let number = line.number + 1; number <= state.doc.lines; number++) {
    const next = state.doc.line(number)
    if (/^\s*\[.+?\]\s*$/.test(next.text)) {
      nextStart = next.from
      break
    }
  }
  // 没有内容可折叠
  if (nextStart <= line.to + 1) return null
  return { from: line.to + 1, to: nextStart - 1 }
}

export const rustSectionFolding = foldService.of(rustSectionFoldService)
