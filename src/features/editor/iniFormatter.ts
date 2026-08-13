/** 保守 INI 格式化：不排序、不删除、不修改引号内内容。 */

export function formatIni(text: string, newline = text.includes('\r\n') ? '\r\n' : '\n'): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || /^\[.*\]$/.test(trimmed)) return line.trimEnd()
    const separator = findSeparator(trimmed)
    if (!separator) return line.trimEnd()
    const key = trimmed.slice(0, separator.index).trim()
    const value = trimmed.slice(separator.index + 1).trim()
    if (!key || !value) return line.trimEnd()
    // 铁锈战争 INI 惯例：冒号前无空格。冒号后保留原风格——
    // 原文有空格则保留一个，没有就不加（避免 名称:零级限制 变成 名称: 零级限制）
    const hadSpace = /\s/.test(trimmed.charAt(separator.index + 1))
    return `${key}${separator.char}${hadSpace ? ' ' : ''}${value}`
  }).join(newline)
}

function findSeparator(line: string): { index: number; char: ':' | '=' } | null {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if ((char === '"' || char === "'") && line[i - 1] !== '\\') quote = quote === char ? null : quote ?? char
    if (!quote && (char === ':' || char === '=') && !isUrlEquals(line, i)) return { index: i, char }
  }
  return null
}

function isUrlEquals(line: string, index: number): boolean {
  const before = line.slice(0, index)
  return /https?:$/.test(before) || /[\\/]$/.test(before)
}
