import { Decoration, EditorView, ViewPlugin, type DecorationSet, MatchDecorator, type ViewUpdate } from '@codemirror/view'

const colorMark = Decoration.mark({ class: 'cm-color-token' })
const colorDecorator = new MatchDecorator({
  regexp: /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
  decoration: colorMark,
})

export const colorDecorationExtension = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = colorDecorator.createDeco(view) }
  update(update: ViewUpdate) {
    this.decorations = colorDecorator.updateDeco(update, this.decorations)
  }
}, { decorations: (value) => value.decorations })
