import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { findCodeByCode, getAllSections, normalizeSectionName } from '../../services/codeData'

/** Display-only ranges: source positions, values and transactions remain unchanged. */
export function bilingualLabelForLine(line: string): { from: number; to: number; label: string } | null {
  const section = /^(\s*)\[([^\]\r\n]+)\]/.exec(line)
  if (section) {
    const name = section[2]
    const known = getAllSections().find((item) => item.code === normalizeSectionName(name))
    return known?.translate && known.translate !== name
      ? { from: section[1].length + 1, to: section[1].length + 1 + name.length, label: known.translate }
      : null
  }
  const key = /^(\s*)([^\s#;:=][^:=]*?)\s*[:=]/.exec(line)
  if (!key) return null
  const raw = key[2].trimEnd()
  const known = findCodeByCode(raw)
  return known?.translate && known.translate !== raw
    ? { from: key[1].length, to: key[1].length + raw.length, label: known.translate }
    : null
}

function labels(view: EditorView): DecorationSet {
  const ranges = []
  for (const { from, to } of view.visibleRanges) {
    for (let pos = view.state.doc.lineAt(from).from; pos <= to;) {
      const line = view.state.doc.lineAt(pos)
      const label = bilingualLabelForLine(line.text)
      if (label) ranges.push(Decoration.mark({
        class: 'cm-bilingual-key',
        attributes: { 'data-label': label.label, title: `${label.label} · ${line.text.slice(label.from, label.to)}` },
      }).range(line.from + label.from, line.from + label.to))
      pos = line.to + 1
    }
  }
  return Decoration.set(ranges, true)
}

export const bilingualLabels = [ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = labels(view) }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = labels(update.view)
  }
}, { decorations: (plugin) => plugin.decorations }), EditorView.baseTheme({
  '.cm-bilingual-key': { display: 'inline-block', position: 'relative', paddingTop: '1em', fontSize: '0.85em', lineHeight: '1.15' },
  '.cm-bilingual-key::before': { content: 'attr(data-label)', position: 'absolute', top: '0', left: '0', fontSize: '1em', lineHeight: '1', color: 'var(--cm-label, var(--text-primary))', whiteSpace: 'nowrap', pointerEvents: 'none' },
})]
