/**
 * 路径展示工具（纯函数，不访问文件系统，可在浏览器与 Electron 中通用）。
 * 路径分隔符统一按 Windows 习惯的 \ 处理（本项目只面向 Windows）。
 */

export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

export function extname(p: string): string {
  const name = basename(p)
  const i = name.lastIndexOf('.')
  if (i <= 0) return ''
  return name.slice(i).toLowerCase()
}

/** 判断是否是铁锈战争常见的配置文件扩展名 */
export function isRustConfigFile(p: string): boolean {
  return ['.txt', '.ini', '.cfg', '.conf', '.rc', '.template'].includes(extname(p))
}

/** M3 视觉阶段支持预览的图片格式 */
export function isPreviewableImage(p: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(extname(p))
}

/** 截断长路径用于展示（省略号计入长度） */
export function truncateMiddle(p: string, max = 60): string {
  if (p.length <= max) return p
  if (max <= 1) return '…'
  const tailLen = Math.floor(max * 0.45)
  const headLen = max - tailLen - 1
  const head = p.slice(0, headLen)
  const tail = p.slice(-tailLen)
  return `${head}…${tail}`
}
