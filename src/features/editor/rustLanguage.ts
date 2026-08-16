/**
 * 铁锈战争配置语法高亮：移植自 RustLanguage 的行内规则。
 *
 * 规则（纯行内、无跨行状态）：
 * 1. 以 # 开头 → 注释
 * 2. 行内含 : 或 = → key: value / key = value（key 高亮，分隔符与 value 常规色）
 * 3. 以 [ 开头且以 ] 结尾 → 节名（加粗）
 * 4. 其他 → 默认
 */
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/** 逐行分类：纯函数，供测试 */
export type RustKeyKind = 'animation' | 'graphic' | 'property'

export function keyKind(key: string): RustKeyKind {
  if (/^(animation_|total_frames$)/.test(key)) return 'animation'
  if (/^(image|image_|draw_|shadow|frame_|scale|teamColors)/.test(key)) return 'graphic'
  return 'property'
}

/** 键值分隔符位置：取行内先出现的 : 或 =（引擎两种写法都认；键不允许含冒号） */
function firstSepIndex(line: string): number {
  const colon = line.indexOf(':')
  const eq = line.indexOf('=')
  if (colon < 0) return eq
  if (eq < 0) return colon
  return Math.min(colon, eq)
}

export function classifyLine(line: string): { kind: 'comment' | 'section' | 'keyvalue' | 'plain'; key?: string; value?: string } {
  const trimmed = line.trim()
  if (trimmed.startsWith('#')) return { kind: 'comment' }
  // 节头允许行尾注释：[core] # 说明 仍是节（否则该节下所有键值行会被误报「不在任何节内」）；
  // 空节名 [] 不算节（与 findSectionOfLine 判定一致）
  if (/^\[[^\]]+\]\s*(?:#.*)?$/.test(trimmed)) return { kind: 'section' }
  const sep = firstSepIndex(line)
  if (sep >= 0) {
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
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
      const sep = firstSepIndex(rest)
      // 消费到分隔符（含分隔符），返回按字段类型区分的标签
      stream.pos += sep
      stream.next()
      return keyKind(classified.key ?? '')
    }
    stream.skipToEnd()
    return 'plain'
  },
  tokenTable: {
    comment: tags.comment,
    section: tags.heading,
    key: tags.propertyName,
    animation: tags.function(tags.propertyName),
    graphic: tags.labelName,
    property: tags.propertyName,
    plain: tags.content,
  },
})

/** 黑白专业配色（颜色走 CSS 变量，深浅色主题自动切换） */
export const rustConfigHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: tags.heading, color: 'var(--cm-section)', fontWeight: '700' },
  { tag: tags.propertyName, color: 'var(--cm-key)', fontWeight: '600' },
  { tag: tags.function(tags.propertyName), color: 'var(--cm-anim)', fontWeight: '650' },
  { tag: tags.labelName, color: 'var(--cm-graphic)', fontWeight: '600' },
])

export function rustConfigLanguageSupport() {
  return [rustConfigLanguage, syntaxHighlighting(rustConfigHighlightStyle)]
}

/** 当前行是否以未闭合 [ 开头（补全节名用） */
export function isUnclosedSection(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('[') && !trimmed.includes(']')
}

/** 行内键值分隔符前的 key（补全值用）；无分隔符返回 null（: 与 = 都认） */
export function keyOfLine(line: string): string | null {
  const sep = firstSepIndex(line)
  if (sep < 0) return null
  const key = line.slice(0, sep).trim()
  return key.length > 0 ? key : null
}

/** 从行数组向上扫描最近的 [节名]（允许行尾注释：[core] # 说明） */
export function findSectionOfLine(lines: string[], lineIndex: number): string {
  for (let i = lineIndex; i >= 0; i--) {
    const m = /^\s*\[(.+?)\]\s*(?:#.*)?$/.exec(lines[i])
    if (m) return m[1]
  }
  return ''
}

/** 收集当前文件所有 ${变量名}（对齐手机版 RustAnalyzer.localVariableNameList：
 * 只收简单名（支持中文），${节.键} 这类带点的引用不算变量）。 */
export function collectLocalVariables(lines: string[]): string[] {
  const set = new Set<string>()
  const re = /\$\{([A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*)\}/g
  for (const line of lines) {
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) set.add(m[1])
  }
  return [...set]
}

/** 智能换行（对齐手机版 RustLanguage NewlineHandler）：
 * 光标前文本是未闭合节头、且光标后没有内容（行尾）→ 回车自动补 ]（[turret_ 这类以 _ 结尾的补 name]）；
 * 其他情况返回 null 交给默认换行。 */
export function smartEnterInsert(before: string, after = ''): string | null {
  if (after.trim()) return null // 光标后还有内容（行中回车）：不补，避免破坏行
  const trimmed = before.trimStart()
  if (!trimmed.startsWith('[')) return null
  if (trimmed.includes(']')) return null // 已闭合，正常换行
  return trimmed.endsWith('_') ? 'name]\n' : ']\n'
}

/** Enter 智能换行绑定（展开进 EditorMirror 的 keymap.of 数组）。
 * 必须排在 defaultKeymap 之前（其 Enter 换行无条件返回 true）；
 * 补全弹窗打开时 Enter 由 autocompletion 的 Prec.highest 绑定先行确认，与本数组位置无关。 */
export const smartEnterBindings: Array<{ key: string; run: (view: import('@codemirror/view').EditorView) => boolean }> = [
  {
    key: 'Enter',
    run: (view) => {
      const sel = view.state.selection.main
      if (sel.from !== sel.to) return false // 有选区：交给默认行为
      const line = view.state.doc.lineAt(sel.from)
      const before = line.text.slice(0, sel.from - line.from)
      const after = line.text.slice(sel.from - line.from)
      const insert = smartEnterInsert(before, after)
      if (insert === null) return false
      view.dispatch({
        changes: { from: sel.from, to: sel.from, insert },
        selection: { anchor: sel.from + insert.length },
        scrollIntoView: true,
      })
      return true
    },
  },
]
