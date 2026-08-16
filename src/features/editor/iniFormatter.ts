/** 保守 INI 格式化：不排序、不删除、不修改引号内内容。 */

export function formatIni(text: string, newline = text.includes('\r\n') ? '\r\n' : '\n'): string {
  // M32：三引号（"""）多行值块——块内行是值内容（任意文本），重排会改数据，原样保留
  let inTripleQuote = false
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim()
      if (inTripleQuote) {
        if (trimmed.includes('"""')) inTripleQuote = false
        return line
      }
      if (trimmed.includes('"""')) {
        // 单行内成对（key: """x"""）不进入块状态；奇数个才进入
        if ((trimmed.match(/"""/g) ?? []).length % 2 === 1) inTripleQuote = true
      }
      // 节头行允许行尾注释（[core] # 说明）：整行保留，注释里的 = : 不被当分隔符重排
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || /^\[.*\]\s*(?:#.*)?$/.test(trimmed)) return line.trimEnd()
      const separator = findSeparator(trimmed)
      if (!separator) return line.trimEnd()
      const key = trimmed.slice(0, separator.index).trim()
      const value = trimmed.slice(separator.index + 1).trim()
      if (!key || !value) return line.trimEnd()
      // 铁锈战争 INI 惯例：冒号前无空格。冒号后保留原风格——
      // 原文有空格则保留一个，没有就不加（避免 名称:零级限制 变成 名称: 零级限制）
      const hadSpace = /\s/.test(trimmed.charAt(separator.index + 1))
      return `${key}${separator.char}${hadSpace ? ' ' : ''}${value}`
    })
    .join(newline)
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
