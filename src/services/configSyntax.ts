/** Rusted Warfare 配置语法中输入法标点的统一处理。 */

/** 键值分隔符：游戏接受 ASCII 冒号/等号；编辑器额外兼容中文全角冒号。 */
export const KEY_VALUE_RE = /^(\s*)([^:=：]*?)(\s*)([:=：])(.*?)$/
export function isKeyValueSeparator(char: string): boolean {
  return char === ':' || char === '=' || char === '：'
}

/** 返回行内第一个键值分隔符位置；不存在时返回 -1。 */
export function findKeyValueSeparator(line: string): number {
  for (let i = 0; i < line.length; i++) {
    if (isKeyValueSeparator(line[i])) return i
  }
  return -1
}

/** 按顶层逗号分段；括号内逗号（包括中文逗号）属于参数内容。 */
export function splitTopLevelConfigValue(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '(') depth++
    else if (char === ')') depth = Math.max(0, depth - 1)
    else if ((char === ',' || char === '，') && depth === 0) {
      parts.push(value.slice(start, i))
      start = i + 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

/** 保存到游戏文件时只规范化全角键值冒号，保留自由文本中的全角逗号。 */
export function normalizeKeyValueSeparators(text: string): string {
  let inMultiline = false
  return text.split(/(\r?\n)/).map((part) => {
    if (part === '\n' || part === '\r\n') return part
    const tripleCount = (part.match(/"""/g) ?? []).length
    if (inMultiline) {
      if (tripleCount % 2 === 1) inMultiline = false
      return part
    }
    const trimmed = part.trimStart()
    const skip = trimmed.startsWith('#') || trimmed.startsWith('[')
    const match = skip ? null : KEY_VALUE_RE.exec(part)
    const normalized = match && match[4] === '：' ? `${match[1]}${match[2]}${match[3]}:${match[5]}` : part
    if (tripleCount % 2 === 1) inMultiline = true
    return normalized
  }).join('')
}
