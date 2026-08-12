/** 颜色值解析：供编辑器装饰与悬停预览使用。 */
export interface ParsedColor { raw: string; hex: string; r: number; g: number; b: number; a: number }

const COLOR_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g

export function parseColor(raw: string): ParsedColor | null {
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(raw)) return null
  let hex = raw.slice(1)
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  let a = 255
  if (hex.length === 8) {
    a = Number.parseInt(hex.slice(0, 2), 16)
    hex = hex.slice(2)
  }
  return {
    raw,
    hex: `#${hex.toUpperCase()}`,
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: a / 255,
  }
}

export function findColors(text: string): Array<ParsedColor & { from: number; to: number }> {
  return [...text.matchAll(COLOR_RE)].flatMap((match) => {
    const parsed = parseColor(match[0])
    return parsed ? [{ ...parsed, from: match.index ?? 0, to: (match.index ?? 0) + match[0].length }] : []
  })
}

export function colorToRgba(color: ParsedColor): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Number(color.a.toFixed(3))})`
}
