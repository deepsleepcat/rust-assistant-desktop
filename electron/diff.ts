/**
 * 行级文本 diff（纯函数，无外部依赖）：
 * - LCS 动态规划求最小编辑路径（同类型行合并为连续段）；
 * - 前后公共行裁剪 + 仅保留改动附近的上下文行（默认 ±3），长段未改动内容折叠为
 *   「省略 N 行」标记——大文件也能一屏看清「AI 到底改了哪几行」；
 * - 中部规模超限（1500×1500 单元格）时回退为整段替换——结果仍然正确，只是粒度变粗；
 * - 输出总行数有上限（默认 400），超出后保留首尾、中间折叠。
 */
import type { DiffLine, DiffSummary } from '../src/types/diff'

export interface DiffOptions {
  /** 每个改动块保留的上下文行数（默认 3） */
  context?: number
  /** 输出总行数上限（默认 400，超出后中间折叠） */
  maxLines?: number
}

const DEFAULT_CONTEXT = 3
const DEFAULT_MAX_LINES = 400
/** LCS 单元格上限：1500×1500 ≈ 2.25M，Int32 表约 9MB，一次性计算可接受 */
const LCS_CELL_LIMIT = 2_250_000

/** 按行拆分（兼容 \r\n 与 \n；结尾换行不产生空尾行；空串 → 空数组） */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '' && /(?:\r?\n)$/.test(text)) {
    lines.pop()
  }
  return lines
}

/** LCS 最短编辑路径：返回中部（裁剪后）的逐行操作序列 */
function lcsOps(a: string[], b: string[]): Array<'same' | 'add' | 'del'> {
  const n = a.length
  const m = b.length
  const stride = m + 1
  const dp = new Int32Array((n + 1) * stride)
  for (let i = n - 1; i >= 0; i--) {
    const row = i * stride
    const next = (i + 1) * stride
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j] ? dp[next + j + 1] + 1 : Math.max(dp[next + j], dp[row + j + 1])
    }
  }
  const ops: Array<'same' | 'add' | 'del'> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('same')
      i++
      j++
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      ops.push('del')
      i++
    } else {
      ops.push('add')
      j++
    }
  }
  while (i < n) {
    ops.push('del')
    i++
  }
  while (j < m) {
    ops.push('add')
    j++
  }
  return ops
}

/** 上下文裁剪：只保留距离任一改动 ≤ context 的 same 行，其余折叠为 omit 标记 */
function withContext(lines: DiffLine[], context: number): DiffLine[] {
  if (context <= 0) return lines
  const changed = new Set<number>()
  lines.forEach((l, i) => {
    if (l.type === 'add' || l.type === 'del') changed.add(i)
  })
  if (changed.size === 0) return lines
  const keep = new Set<number>()
  for (const c of changed) {
    for (let k = Math.max(0, c - context); k <= Math.min(lines.length - 1, c + context); k++) keep.add(k)
  }
  const out: DiffLine[] = []
  let omitted = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === 'same' && !keep.has(i)) {
      omitted++
      continue
    }
    if (omitted > 0) {
      out.push({ type: 'omit', text: `… 省略 ${omitted} 行未改动内容 …` })
      omitted = 0
    }
    out.push(lines[i])
  }
  if (omitted > 0) out.push({ type: 'omit', text: `… 省略 ${omitted} 行未改动内容 …` })
  return out
}

/** 输出行数上限：保留首尾，中间折叠（省略标记占 1 行，保证总行数 ≤ max） */
function capLines(lines: DiffLine[], max: number): DiffLine[] {
  if (lines.length <= max) return lines
  const omitted = lines.length - max + 1
  const half = Math.floor((max - 1) / 2)
  const head = lines.slice(0, half)
  const tail = lines.slice(lines.length - (max - 1 - half))
  return [...head, { type: 'omit', text: `… 中间省略 ${omitted} 行 …` }, ...tail]
}

/**
 * 行级 diff：oldText → newText。
 * 返回的 same 行已按上下文裁剪；add/del 为实际改动行。
 * 内容完全一致时返回空数组（调用方据此显示「无改动」）。
 */
export function diffLines(oldText: string, newText: string, opts?: DiffOptions): DiffLine[] {
  const context = opts?.context ?? DEFAULT_CONTEXT
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  if (oldLines.length === newLines.length && oldLines.every((l, i) => l === newLines[i])) {
    return []
  }

  // 公共前缀/后缀裁剪：绝大多数情况下文件只有一小段被改，避免 LCS 全表计算
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  const midOld = oldLines.slice(start, endOld)
  const midNew = newLines.slice(start, endNew)

  const ops =
    midOld.length * midNew.length <= LCS_CELL_LIMIT
      ? lcsOps(midOld, midNew)
      : [...midOld.map(() => 'del' as const), ...midNew.map(() => 'add' as const)]

  const lines: DiffLine[] = []
  for (const l of oldLines.slice(0, start)) lines.push({ type: 'same', text: l })
  let oi = 0
  let ni = 0
  for (const op of ops) {
    if (op === 'same') {
      lines.push({ type: 'same', text: midOld[oi] })
      oi++
      ni++
    } else if (op === 'del') {
      lines.push({ type: 'del', text: midOld[oi] })
      oi++
    } else {
      lines.push({ type: 'add', text: midNew[ni] })
      ni++
    }
  }
  for (const l of oldLines.slice(endOld)) lines.push({ type: 'same', text: l })

  return capLines(withContext(lines, context), maxLines)
}

/** 统计新增/删除行数（omit/same 不计） */
export function summarizeDiff(diff: DiffLine[]): DiffSummary {
  let added = 0
  let deleted = 0
  for (const l of diff) {
    if (l.type === 'add') added++
    else if (l.type === 'del') deleted++
  }
  return { added, deleted }
}
