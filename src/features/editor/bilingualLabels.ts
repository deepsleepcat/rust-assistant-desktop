import { StateEffect } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { findCodeByCode, findLogicBoolean, getAllSections, getEnToZhDict, getKeyZhToEnDict, getLogicIdentifierEnToZhDict, isPreserveValueKey, loadCodeData, normalizeSectionName } from '../../services/codeData'
import { findConfigCommentStart, findKeyValueSeparator } from '../../services/configSyntax'

interface BilingualLabel { from: number; to: number; label: string }

/** Display-only ranges: source positions, values and transactions remain unchanged. */
export function bilingualLabelForLine(line: string): BilingualLabel | null {
  const section = /^(\s*)\[([^\]\r\n]+)\]/.exec(line)
  if (section) {
    const name = section[2]
    const known = getAllSections().find((item) => item.code === normalizeSectionName(name))
    return known?.translate && known.translate !== name
      ? { from: section[1].length + 1, to: section[1].length + 1 + name.length, label: known.translate }
      : null
  }
  const key = /^(\s*)([^\s#;:=：][^:=：]*?)\s*[:=：]/.exec(line)
  if (!key) return null
  const raw = key[2].trimEnd()
  const known = findCodeByCode(raw)
  return known?.translate && known.translate !== raw
    ? { from: key[1].length, to: key[1].length + raw.length, label: known.translate }
    : null
}

/** 只给布尔和逻辑字段的值加显示标签；路径、名称、引号参数均保留原文。 */
export function bilingualLabelsForLine(line: string): BilingualLabel[] {
  const keyLabel = bilingualLabelForLine(line)
  const result = keyLabel ? [keyLabel] : []
  if (findConfigCommentStart(line) >= 0 || /^\s*(?:;|\[)/.test(line)) return result
  const sep = findKeyValueSeparator(line)
  if (sep < 0) return result
  const rawKey = line.slice(0, sep).trim()
  const key = getKeyZhToEnDict().get(rawKey) ?? rawKey
  const code = findCodeByCode(key)
  if (!code || isPreserveValueKey(key)) return result
  const types = code.type.split(',').map((type) => type.trim().toLowerCase())
  const logic = types.some((type) => type.includes('logic'))
  const boolean = types.some((type) => type === 'boolean' || type === 'bool')
  if (!logic && !boolean) return result

  const rawValue = line.slice(sep + 1)
  const from = sep + 1 + (rawValue.match(/^\s*/)?.[0].length ?? 0)
  const value = line.slice(from).trimEnd()
  if (!value || (!logic && !/^(?:true|false)$/i.test(value))) return result

  const dict = getEnToZhDict()
  const translated = value.replace(/"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*(?:\.[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*)*/g, (token, offset: number) => {
    if (token.startsWith('"') || token.startsWith("'")) return token
    const lower = token.toLowerCase()
    if (/^(?:true|false|if|and|or|not)$/.test(lower)) return dict.get(lower) ?? token
    if (lower.startsWith('self.')) {
      const name = token.slice(5)
      const known = findLogicBoolean(name)
      if (!known) return token
      return dict.get(lower) ?? getLogicIdentifierEnToZhDict().get(name) ?? token
    }
    // 普通单词只在真实函数调用处标注，参数名与 memory.xxx 等用户标识符不翻译。
    if (/^\s*\(/.test(value.slice(offset + token.length)) && findLogicBoolean(token)) return dict.get(lower) ?? token
    return token
  })
  if (translated !== value) result.push({ from, to: from + value.length, label: translated })
  return result
}

function labels(view: EditorView): DecorationSet {
  const ranges = []
  const seen = new Set<number>()
  for (const { from, to } of view.visibleRanges) {
    for (let pos = view.state.doc.lineAt(from).from; pos <= to;) {
      const line = view.state.doc.lineAt(pos)
      if (!seen.has(line.from)) {
        seen.add(line.from)
        for (const label of bilingualLabelsForLine(line.text)) ranges.push(Decoration.mark({
          class: 'cm-bilingual-key',
          attributes: { 'data-label': label.label, title: `${label.label}：${line.text.slice(label.from, label.to)}` },
        }).range(line.from + label.from, line.from + label.to))
      }
      pos = line.to + 1
    }
  }
  return Decoration.set(ranges, true)
}

const refreshLabels = StateEffect.define<null>()

export const bilingualLabels = [ViewPlugin.fromClass(class {
  decorations: DecorationSet
  destroyed = false
  constructor(view: EditorView) {
    this.decorations = labels(view)
    void loadCodeData().then(() => {
      if (!this.destroyed) view.dispatch({ effects: refreshLabels.of(null) })
    })
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshLabels)))) this.decorations = labels(update.view)
  }
  destroy() { this.destroyed = true }
}, { decorations: (plugin) => plugin.decorations }), EditorView.baseTheme({
  '.cm-bilingual-key': { display: 'inline-block', position: 'relative', paddingTop: '1em', fontSize: '0.85em', lineHeight: '1.15' },
  '.cm-bilingual-key::before': { content: 'attr(data-label)', position: 'absolute', top: '0', left: '0', fontSize: '1em', lineHeight: '1', color: 'var(--cm-label, var(--text-primary))', whiteSpace: 'nowrap', pointerEvents: 'none' },
})]
