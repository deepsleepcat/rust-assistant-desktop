/**
 * mod-info.txt 键值更新（纯函数，保留原文）。
 *
 * 旧实现按固定字段顺序重建整个文件：注释、未知键、其它节、空行、换行风格
 * 全部丢失，音乐/地图字段还会被顺手清空。模组信息是用户手写过的文件，
 * 编辑器只应该改「表单里真正动过的键」。
 *
 * 规则：
 * - 只更新传入的键；`value === null` 表示删除该键所在行；
 * - 键优先在 `[mod]` 节内查找，找不到时退回全文查找；
 * - 新键插入到 `[mod]` 节末尾（无该节则新建）；保留原有缩进与行尾风格。
 */

export interface ModInfoUpdate {
  key: string
  /** 新值；null 表示删除该键 */
  value: string | null
}

interface SectionRange {
  start: number
  end: number
  exists: boolean
}

function isSectionLine(line: string): boolean {
  return /^\s*\[/.test(line)
}

/** 定位 `[mod]` 节范围；无该节时返回全文范围并标记 exists=false */
function sectionRange(lines: readonly string[]): SectionRange {
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().toLowerCase() === '[mod]') {
      start = i
      break
    }
  }
  if (start < 0) return { start: 0, end: lines.length, exists: false }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isSectionLine(lines[i])) {
      end = i
      break
    }
  }
  return { start, end, exists: true }
}

/** 在范围内查找键所在行（跳过注释行） */
function findKeyLine(lines: readonly string[], key: string, range: SectionRange): number {
  const target = key.toLowerCase()
  for (let i = range.start; i < range.end; i += 1) {
    const line = lines[i]
    if (/^\s*[#;]/.test(line)) continue
    const m = /^\s*([A-Za-z0-9_.-]+)\s*:/.exec(line)
    if (m && m[1].toLowerCase() === target) return i
  }
  return -1
}

/**
 * 更新 mod-info.txt 文本。
 * 输入输出都是纯文本；BOM 由调用方在字节层处理。
 */
export function updateModInfoText(text: string, updates: readonly ModInfoUpdate[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const endsWithEol = text.endsWith('\n')
  const lines = text.split(/\r?\n/)
  if (endsWithEol) lines.pop()

  for (const update of updates) {
    const key = update.key.trim()
    if (!key) continue

    let range = sectionRange(lines)
    const found = findKeyLine(lines, key, range)

    if (update.value === null) {
      if (found >= 0) lines.splice(found, 1)
      continue
    }

    if (found >= 0) {
      const indent = /^\s*/.exec(lines[found])?.[0] ?? ''
      lines[found] = `${indent}${key}: ${update.value}`
      continue
    }

    // 键不存在：需要一个 [mod] 节来承载，没有就补一个
    if (!range.exists) {
      if (lines.length > 0 && lines[lines.length - 1].trim() !== '') lines.push('')
      lines.push('[mod]')
      range = sectionRange(lines)
    }
    lines.splice(range.end, 0, `${key}: ${update.value}`)
  }

  const out = lines.join(eol)
  if (out === '') return ''
  return endsWithEol ? out + eol : out
}

/** 从原文里读某个键的当前值（表单初值用；找不到返回 undefined） */
export function readModInfoKey(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/)
  const range = sectionRange(lines)
  const idx = findKeyLine(lines, key, range)
  if (idx < 0) return undefined
  const m = /^\s*[A-Za-z0-9_.-]+\s*:\s*(.*)$/.exec(lines[idx])
  return m ? m[1].trim() : undefined
}

/** 新建项目时写入的最小 mod-info.txt（其余字段留空由用户填写） */
export function minimalModInfoText(title: string): string {
  return `# 模组信息（由铁锈工坊创建）\n[mod]\ntitle: ${title}\nversion: 1.0\n`
}
