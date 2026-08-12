/**
 * 路径安全工具：所有文件操作必须先经过这里校验，
 * 确保目标路径一定位于已登记的项目根目录之内。
 */
import path from 'node:path'

/** 规范化绝对路径（Windows 下忽略大小写，便于比较） */
export function normalizePath(p: string): string {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** target 是否位于 root 之内（含 root 本身） */
export function isPathInside(root: string, target: string): boolean {
  const r = normalizePath(root)
  const t = normalizePath(target)
  return t === r || t.startsWith(r + path.sep)
}
