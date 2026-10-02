/** 按 [section] 标题计算折叠范围和大纲条目。 */
export interface SectionOutline { name: string; line: number; from: number }
export interface FoldRange { from: number; to: number }

const SECTION_RE = /^\s*\[(.+?)\]\s*$/

export function scanSections(text: string): SectionOutline[] {
  const sections: SectionOutline[] = []
  let offset = 0
  text.split('\n').forEach((line, index) => {
    const match = SECTION_RE.exec(line)
    if (match) sections.push({ name: match[1], line: index + 1, from: offset })
    offset += line.length + 1
  })
  return sections
}

export function sectionFoldRanges(text: string): FoldRange[] {
  const lines = text.split('\n')
  const sections = scanSections(text)
  return sections.flatMap((section, index) => {
    const endLine = index + 1 < sections.length ? sections[index + 1].line - 1 : lines.length
    if (endLine <= section.line) return []
    let from = 0
    for (let i = 0; i < section.line; i++) from += lines[i].length + 1
    let to = from
    for (let i = section.line; i < endLine; i++) to += lines[i].length + 1
    return [{ from, to: Math.max(from, to - 1) }]
  })
}
