/**
 * git 冲突标记解析（M25）：纯函数，渲染层与主进程共用（无 node 依赖）。
 * 解析 <<<<<<< ours ======= theirs >>>>>>> 冲突块，供冲突预览与「选择 A/B」解决。
 */

export interface ConflictBlock {
  ours: string
  theirs: string
  startLine: number
}

export function conflictMarkers(content: string): ConflictBlock[] {
  const lines = content.split(/\r?\n/)
  const blocks: ConflictBlock[] = []
  let i = 0
  while (i < lines.length) {
    if (/^<{7}/.test(lines[i])) {
      const start = i + 1
      let sep = -1
      let end = -1
      for (let j = start; j < lines.length; j++) {
        if (/^={7}/.test(lines[j])) sep = j
        else if (/^>{7}/.test(lines[j])) {
          end = j
          break
        }
      }
      if (sep >= 0 && end > sep) {
        blocks.push({
          ours: lines.slice(start, sep).join('\n'),
          theirs: lines.slice(sep + 1, end).join('\n'),
          startLine: i + 1,
        })
        i = end + 1
        continue
      }
    }
    i++
  }
  return blocks
}
