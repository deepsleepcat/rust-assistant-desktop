/** 配置中的图片路径解析：支持 image/icon/texture + :/= + ROOT:。 */
import { isPreviewableImage } from '../../utils/paths'

function dirname(p: string): string { return p.replace(/[\\/][^\\/]*$/, '') }
function join(base: string, child: string): string { return `${base.replace(/[\\/]$/, '')}\\${child.replace(/^[/\\]+/, '').replace(/\//g, '\\')}` }

export function imagePathFromLine(line: string): string | null {
  const match = /^\s*(?:image|icon|texture|shadow|preview)\s*[:=]\s*["']?([^"'\s#]+)["']?\s*$/i.exec(line)
  return match?.[1] ?? null
}

export function resolveProjectImagePath(value: string, filePath: string, rootPath: string): string | null {
  if (!isPreviewableImage(value)) return null
  const isRoot = /^ROOT:/i.test(value)
  const normalized = value.replace(/^ROOT:/i, '').replace(/[\\/]+/g, '\\')
  const resolved = join(isRoot ? rootPath : dirname(filePath), normalized)
  const lowerRoot = rootPath.toLowerCase().replace(/[\\/]$/, '')
  const lowerResolved = resolved.toLowerCase()
  if (lowerResolved !== lowerRoot && !lowerResolved.startsWith(`${lowerRoot}\\`)) return null
  return resolved
}

export function imageHoverInfo(line: string, filePath: string, rootPath: string): { value: string; resolvedPath: string } | null {
  const value = imagePathFromLine(line)
  if (!value) return null
  const resolvedPath = resolveProjectImagePath(value, filePath, rootPath)
  return resolvedPath ? { value, resolvedPath } : null
}
