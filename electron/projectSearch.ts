import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoLinkEscape } from './paths'

export interface ProjectSearchEntry {
  /** 项目内绝对路径，供 openFile 直接使用。 */
  path: string
  /** POSIX 风格项目相对路径，供 UI 显示与路径匹配。 */
  relativePath: string
  name: string
}

export interface ProjectSearchResult {
  entries: ProjectSearchEntry[]
  /** 结果或扫描节点达到安全上限，搜索结果不完整。 */
  truncated: boolean
}

const MAX_DEPTH = 64
const MAX_SCANNED_ENTRIES = 50_000
const MAX_RESULTS = 2_000

function matchesQuery(name: string, relativePath: string, query: string): boolean {
  return name.toLowerCase().includes(query) || relativePath.toLowerCase().includes(query)
}

/**
 * 受限项目文件名搜索：
 * - 只递归已登记项目根内的普通文件，不读取文件内容；
 * - 不跟随符号链接/junction，避免把搜索变成根外文件名枚举通道；
 * - hidden 语义与文件树一致；
 * - 用节点/结果/深度上限防超大项目阻塞主进程。
 */
export async function searchProjectFiles(rootPath: string, rawQuery: string, showHidden: boolean): Promise<ProjectSearchResult> {
  const root = path.resolve(rootPath)
  const query = rawQuery.trim().replace(/\\/g, '/').toLowerCase()
  if (!query) return { entries: [], truncated: false }
  await assertNoLinkEscape(root, root)

  const entries: ProjectSearchEntry[] = []
  const sorted = (): ProjectSearchResult => ({
    entries: [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'zh-CN')),
    truncated: false,
  })
  const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
  let scanned = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > MAX_DEPTH) return { ...sorted(), truncated: true }
    // lstat + realpath 双重确认：目录可能在入栈后被替换成 junction/symlink；
    // readdir 前后都重校验，发现 TOCTOU 变化时丢弃该目录结果并标记不完整。
    try {
      const before = await fs.lstat(current.dir)
      if (!before.isDirectory() || before.isSymbolicLink()) return { ...sorted(), truncated: true }
      await assertNoLinkEscape(root, current.dir)
    } catch {
      return { ...sorted(), truncated: true }
    }
    const children = await fs.readdir(current.dir, { withFileTypes: true }).catch(() => null)
    if (!children) return { ...sorted(), truncated: true }
    try {
      const after = await fs.lstat(current.dir)
      if (!after.isDirectory() || after.isSymbolicLink()) return { ...sorted(), truncated: true }
      await assertNoLinkEscape(root, current.dir)
    } catch {
      return { ...sorted(), truncated: true }
    }

    for (const child of children) {
      if (++scanned > MAX_SCANNED_ENTRIES) return { ...sorted(), truncated: true }
      if (!showHidden && child.name.startsWith('.')) continue
      // readdir 将 junction/symlink 标为 symbolicLink；搜索不跟随，避免根外枚举。
      if (child.isSymbolicLink()) continue

      const abs = path.join(current.dir, child.name)
      const rel = current.rel ? `${current.rel}/${child.name}` : child.name
      if (child.isDirectory()) {
        try {
          await assertNoLinkEscape(root, abs)
          stack.push({ dir: abs, rel, depth: current.depth + 1 })
        } catch {
          // 目录在项目内但真实路径逃逸/无权限：跳过，保持其余结果可用。
        }
        continue
      }
      if (!child.isFile()) continue
      if (!matchesQuery(child.name, rel, query)) continue

      entries.push({ path: abs, relativePath: rel, name: child.name })
      if (entries.length >= MAX_RESULTS) return { ...sorted(), truncated: true }
    }
  }

  return sorted()
}
