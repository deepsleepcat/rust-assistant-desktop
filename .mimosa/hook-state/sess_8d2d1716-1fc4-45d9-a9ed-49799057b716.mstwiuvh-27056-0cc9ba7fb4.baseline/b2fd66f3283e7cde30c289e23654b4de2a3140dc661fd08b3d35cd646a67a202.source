/**
 * 路径安全工具：所有文件操作必须先经过这里校验，
 * 确保目标路径一定位于已登记的项目根目录之内。
 */
import path from 'node:path'
import fs from 'node:fs/promises'

/** 规范化绝对路径（Windows 下忽略大小写，便于比较） */
export function normalizePath(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** target 是否位于 root 之内（含 root 本身）。
 * 盘符根（C:\）以单个分隔符结尾：直接拼 + path.sep 会变成双反斜杠导致永远不匹配。 */
export function isPathInside(root: string, target: string): boolean {
  const r = normalizePath(root)
  const t = normalizePath(target)
  if (t === r) return true
  const prefix = r.endsWith(path.sep) ? r : r + path.sep
  return t.startsWith(prefix)
}

/** 项目根真实路径缓存（realpath 基准） */
const realRootCache = new Map<string, string>()

/** 项目根被删除/重建/移动后调用：清掉该根的真实路径缓存 */
export function invalidateRealRoot(rootPath: string): void {
  realRootCache.delete(normalizePath(rootPath))
}

/** 项目根的真实路径（根本身是 junction/SUBST 映射盘时，用它做链接逃逸校验的基准） */
export async function realRootOf(rootPath: string): Promise<string> {
  const key = normalizePath(rootPath)
  const cached = realRootCache.get(key)
  if (cached) return cached
  let real: string
  try {
    real = await fs.realpath(rootPath)
  } catch {
    real = path.resolve(rootPath) // 根不存在（未创建）：退回词法基准
  }
  realRootCache.set(key, real)
  return real
}

/**
 * 链接逃逸校验（junction/符号链接防护）：解析「已存在的最近祖先」的真实路径，
 * 与项目根的真实路径比对——项目内链接指向根外则拒绝；根本身是链接/映射盘时
 * 以根的真实路径为基准，不误拒正常项目。只校验已存在的路径段（不存在的段不可能是链接）。
 */
export async function assertNoLinkEscape(rootPath: string, targetPath: string): Promise<void> {
  const realRoot = await realRootOf(rootPath)
  let cur = targetPath
  for (;;) {
    try {
      const real = await fs.realpath(cur)
      if (!isPathInside(realRoot, real)) {
        throw new Error('目标路径包含指向项目目录外的链接，拒绝访问')
      }
      return
    } catch (err) {
      if (err instanceof Error && err.message.includes('指向项目目录外的链接')) throw err
      const parent = path.dirname(cur)
      if (parent === cur) return // 已到文件系统根，词法校验已通过
      cur = parent
    }
  }
}
