/**
 * 局部补丁编辑（M27-1）：unified diff 解析 + 校验 + 应用（纯函数，无 IO）。
 *
 * AI 通过 applyDiff 工具传 unified diff（标准 @@ 头格式）对已有文件做局部修改，
 * 而不是整文件覆盖。安全设计：
 * - 解析严格：diff 中每个 hunk 声明的行数与实际行数必须一致，否则整体拒绝
 *   （行号错位会导致误改，宁可让 AI 重来）；
 * - 应用前全量校验：所有 hunk 的位置与上下文行必须与目标文件匹配，
 *   全部通过才修改（原子性，不会出现「前半 hunk 生效、后半失败」的半成品文件）；
 * - 上下文行不信任 AI 提供的文本：' ' 前缀行从目标文件原样取，防止 AI 顺带篡改；
 * - 应用顺序从后往前：先应用靠后的 hunk，前面的行号不受影响。
 */

/** 单个 hunk（一个 @@ 块） */
export interface DiffHunk {
  /** 旧文件起始行（1-based） */
  oldStart: number
  /** 旧文件行数（context + delete；0 = 在文件末尾追加） */
  oldCount: number
  /** 新文件起始行（1-based；仅展示用，应用时以 oldStart 为准） */
  newStart: number
  /** 新文件行数（context + add） */
  newCount: number
  lines: Array<{ type: 'ctx' | 'del' | 'add'; text: string }>
}

/** diff 大小上限（1MB）：AI 是远程模型，超大 diff 不可能是合理编辑 */
export const MAX_DIFF_BYTES = 1024 * 1024
/** 单个 diff 允许的 hunk 数上限（防海量小 hunk 拖垮校验循环） */
export const MAX_HUNKS = 200
/** 目标文件大小上限（与 writeFile/readFile 的 64MB 对称） */
export const MAX_TARGET_BYTES = 64 * 1024 * 1024

export type ApplyResult = { ok: true; text: string } | { ok: false; error: string }

/**
 * 解析 unified diff 文本 → hunk 列表。
 * 非法格式抛 Error（工具层转成 AI 可见的错误消息）。
 */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
  if (typeof diff !== 'string' || diff.length === 0) throw new Error('diff 内容为空')
  if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
    throw new Error(`diff 过大（超过 ${MAX_DIFF_BYTES / 1024 / 1024}MB 上限）`)
  }

  const rawLines = diff.replace(/\r\n/g, '\n').split('\n')
  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let headerSeen = false

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
      if (!m) throw new Error(`无法解析 hunk 头：${raw.slice(0, 80)}`)
      if (current) hunks.push(current)
      current = {
        oldStart: Number(m[1]),
        oldCount: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newCount: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      }
      headerSeen = true
      continue
    }
    if (!current) {
      // 头之前只允许空行/说明行（部分模型会带文件头）；其余一律拒绝
      if (raw.trim() === '') continue
      throw new Error('diff 缺少 @@ hunk 头（首个内容行不是行块）')
    }
    const prefix = raw[0]
    if (raw === '') {
      // 裸空行（尾随换行/格式噪音）：diff 语义的空行必须是 ' ' 前缀，这里直接跳过
      continue
    }
    if (prefix === ' ' || prefix === '-' || prefix === '+') {
      current.lines.push({ type: prefix === '-' ? 'del' : prefix === '+' ? 'add' : 'ctx', text: raw.slice(1) })
    } else if (prefix === '\\') {
      // '\ No newline at end of file'：无内容行，忽略
      continue
    } else {
      throw new Error(`行块前缀非法（必须是 空格/-/+，遇到：${JSON.stringify(prefix)}）`)
    }
  }
  if (current) hunks.push(current)
  if (!headerSeen) throw new Error('diff 中没有任何 hunk（@@ 头）')

  // 行数与声明必须一致（严格模式）：ctx+del = oldCount，ctx+add = newCount
  for (const h of hunks) {
    const ctx = h.lines.filter((l) => l.type === 'ctx').length
    const del = h.lines.filter((l) => l.type === 'del').length
    const add = h.lines.filter((l) => l.type === 'add').length
    if (ctx + del !== h.oldCount) {
      throw new Error(
        `hunk 行数不符：声明旧文件 ${h.oldCount} 行，实际上下文+删除 ${ctx + del} 行（请修正 @@ 头或行块）`,
      )
    }
    if (ctx + add !== h.newCount) {
      throw new Error(
        `hunk 行数不符：声明新文件 ${h.newCount} 行，实际上下文+新增 ${ctx + add} 行（请修正 @@ 头或行块）`,
      )
    }
  }
  return hunks
}

/** 拆行（兼容 \r\n 与 \n；保留原始行内容，不剥离空尾行） */
function splitKeepEmpty(text: string): string[] {
  return text.split(/\r?\n/)
}

/** 旧文本的换行符（\r\n 或 \n，默认 \n）与是否以换行结尾——应用后保持原样 */
function lineEndingOf(text: string): { sep: string; trailing: boolean } {
  const sep = text.includes('\r\n') ? '\r\n' : '\n'
  return { sep, trailing: text.endsWith('\n') || text.endsWith('\r\n') }
}

/**
 * 校验 + 应用 diff 到目标文本。
 * 先全量校验（所有 hunk 的位置、上下文、删除行都匹配），全部通过才修改——
 * 任何一个 hunk 不匹配都整体失败，文件保持不变。
 */
export function applyUnifiedDiff(oldText: string, hunks: DiffHunk[]): ApplyResult {
  if (hunks.length === 0) return { ok: false, error: 'diff 中没有可应用的修改（hunk 数为 0）' }
  const lines = splitKeepEmpty(oldText)
  const { sep, trailing } = lineEndingOf(oldText)

  // 阶段 0：hunk 区间重叠校验——LLM 可能生成区间重叠的多 hunk diff
  //（如先改 2-3 行又改 3-4 行）。重叠时从后往前应用会读到被前面 hunk 改过的
  // 内容，静默产生错误文件。真实 diff 工具不会产出重叠 hunk，直接整体拒绝。
  // 空区间（oldCount=0 的追加 hunk）数学上与任何区间不重叠，不参与比较——
  // 否则「追加在 N 前 + 替换 N 行」的合法组合会因输入顺序被误判重叠。
  // 但追加点若严格落在另一 hunk 区间内部（如替换 2-4 行 + 在第 3 行前插入），
  // 倒序应用时插入会占用位置导致替换 splice 错位、静默损坏文件——同样整体拒绝。
  // 放行情形：oldStart == 区间起点（追加在 N 前，与替换 N 行兼容）与
  // oldStart >= 区间终点（相邻/分离）。
  const ranges = hunks
    .filter((h) => h.oldCount > 0)
    .map((h) => ({ start: h.oldStart, end: h.oldStart + h.oldCount }))
    .sort((a, b) => a.start - b.start)
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) {
      return {
        ok: false,
        error: `diff 片段区间重叠（第 ${ranges[i - 1].start} 行与第 ${ranges[i].start} 行的片段相互覆盖），请合并为不重叠的修改`,
      }
    }
  }
  for (const a of hunks) {
    if (a.oldCount > 0) continue
    for (const r of ranges) {
      if (a.oldStart > r.start && a.oldStart < r.end) {
        return {
          ok: false,
          error: `diff 片段区间重叠（第 ${a.oldStart} 行的插入点位于第 ${r.start} 行片段的内部），请合并为不重叠的修改`,
        }
      }
    }
  }

  // 阶段 1：全量校验
  for (const h of hunks) {
    // 空文件标准格式 @@ -0,0 +1,N @@：oldStart=0 表示插入位置 0（文件开头）。
    // 仅当 oldCount=0 合法（普通文件行号从 1 起，oldStart=0 且 oldCount>0 是非法输入）
    const start = h.oldStart === 0 ? 0 : h.oldStart - 1
    if (h.oldStart === 0 && h.oldCount !== 0) {
      return { ok: false, error: `hunk 起始行非法（${h.oldStart}），行号必须从 1 起（追加用 @@ -N,0 @@ 或空文件用 @@ -0,0 @@）` }
    }
    if (start < 0 || start + h.oldCount > lines.length) {
      return {
        ok: false,
        error: `hunk（起始行 ${h.oldStart}，共 ${h.oldCount} 行）超出文件范围（文件共 ${lines.length} 行），请用 readFile 确认当前行号`,
      }
    }
    let offset = 0
    for (const l of h.lines) {
      if (l.type === 'del' || l.type === 'ctx') {
        if (lines[start + offset] !== l.text) {
          return {
            ok: false,
            error: `上下文不匹配：目标文件第 ${start + offset + 1} 行与 diff 中的内容不一致（"${truncateForError(lines[start + offset])}" ≠ "${truncateForError(l.text)}"）。文件可能已被修改，请重新 readFile 后再生成 diff`,
          }
        }
        offset++
      }
    }
  }

  // 阶段 2：按 oldStart 升序排序后从后往前应用——LLM 可能按非升序输出 hunk，
  // 若按原顺序倒序应用，先应用的低行号 hunk 会改变后续 hunk 位置处的行内容
  //（校验是对原文件逐 hunk 做的，与顺序无关，非升序输入会静默损坏文件）。
  // 同起始行时追加（oldCount=0）排在替换前面：倒序应用时替换先执行、追加后
  // 执行，追加插在替换结果之前——「追加在旧行 N 前 + 替换旧行 N」语义不受
  // 输入顺序影响（若追加先执行会占用位置导致替换 splice 删错行）。
  // 比较器对称（oldCount 升序）：稳定排序下同起始行双追加保持输入顺序。
  const ordered = [...hunks].sort((a, b) => a.oldStart - b.oldStart || a.oldCount - b.oldCount)
  const result = lines.slice()
  for (let i = ordered.length - 1; i >= 0; i--) {
    const h = ordered[i]
    const start = h.oldStart === 0 ? 0 : h.oldStart - 1
    // 新块内容：ctx 行从原文件原样取（不信任 AI 的上下文文本），add 行用 AI 的新行。
    // del 行与校验阶段一致地推进 offset——否则 del 之后的 ctx 行会读到错误位置
    const block: string[] = []
    let offset = 0
    for (const l of h.lines) {
      if (l.type === 'ctx') {
        block.push(result[start + offset])
        offset++
      } else if (l.type === 'del') {
        offset++
      } else {
        block.push(l.text)
      }
    }
    result.splice(start, h.oldCount, ...block)
  }

  let out = result.join(sep)
  if (trailing && !out.endsWith('\n')) out += sep
  if (!trailing && out.endsWith('\n')) out = out.slice(0, -sep.length)
  return { ok: true, text: out }
}

/** 错误消息里的行内容截断（避免把超长行整行塞进 AI 可见的错误） */
function truncateForError(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}
