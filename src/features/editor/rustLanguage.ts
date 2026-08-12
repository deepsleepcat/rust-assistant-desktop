/**
 * 铁锈战争配置语法高亮：移植手机版 RustLanguage 的行内规则。
 *
 * 规则（与手机版一致，纯行内、无跨行状态）：
 * 1. 以 # 开头 → 注释
 * 2. 行内含 : → key: value（key 高亮，冒号与 value 常规色）
 * 3. 以 [ 开头且以 ] 结尾 → 节名（加粗）
 * 4. 其他 → 默认
 */
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { CompletionContext } from '@codemirror/autocomplete'

/** 逐行分类：纯函数，供测试 */
export function classifyLine(line: string): { kind: 'comment' | 'section' | 'keyvalue' | 'plain'; key?: string; value?: string } {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return { kind: 'comment' }
  if (/^\[.*\]$/.test(trimmed)) return { kind: 'section' }
  const colon = line.indexOf(':')
  if (colon >= 0) {
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key.length > 0) return { kind: 'keyvalue', key, value }
  }
  return { kind: 'plain' }
}

const rustConfigLanguage = StreamLanguage.define({
  name: 'rustConfig',
  startState: () => ({}),
  token(stream) {
    const line = stream.string
    const rest = line.slice(stream.pos)
    const classified = classifyLine(rest)
    if (classified.kind === 'comment') {
      stream.skipToEnd()
      return 'comment'
    }
    if (classified.kind === 'section') {
      stream.skipToEnd()
      return 'section'
    }
    if (classified.kind === 'keyvalue') {
      const colon = rest.indexOf(':')
      // 消费到冒号（含冒号），返回 key 标签；剩余部分下一次 tokenize
      stream.pos += colon
      stream.next()
      return 'key'
    }
    stream.skipToEnd()
    return 'plain'
  },
  tokenTable: {
    comment: tags.comment,
    section: tags.heading,
    key: tags.propertyName,
    plain: tags.content,
  },
})

/** 黑白专业配色 */
export const rustConfigHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: '#888888', fontStyle: 'italic' },
  { tag: tags.heading, color: '#111111', fontWeight: '700' },
  { tag: tags.propertyName, color: '#333333', fontWeight: '600' },
])

export function rustConfigLanguageSupport() {
  return [rustConfigLanguage, syntaxHighlighting(rustConfigHighlightStyle)]
}

/** 当前行是否以未闭合 [ 开头（补全节名用） */
export function isUnclosedSection(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('[') && !trimmed.includes(']')
}

/** 行内冒号前的 key（补全值用）；无冒号返回 null */
export function keyOfLine(line: string): string | null {
  const colon = line.indexOf(':')
  if (colon < 0) return null
  const key = line.slice(0, colon).trim()
  return key.length > 0 ? key : null
}

/** 从行数组向上扫描最近的 [节名] */
export function findSectionOfLine(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const m = /^\s*\[(.+?)\]\s*$/.exec(lines[i])
    if (m) return m[1]
  }
  return ''
}

/** 补全上下文：光标所在行 + 当前节 */
export function completionContext(context: CompletionContext): { line: string; section: string } {
  const lineInfo = context.state.doc.lineAt(context.pos)
  const lines = context.state.doc.toString().split('\n')
  const lineIndex = lineInfo.number - 1
  return { line: lineInfo.text, section: findSectionOfLine(lines, lineIndex) }
}
