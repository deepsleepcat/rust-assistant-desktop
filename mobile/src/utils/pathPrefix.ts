/**
 * 路径前缀工具（从桌面版 stores/slices/projectSlice 抽取的纯函数）：
 * 标签改名/删除时判断路径归属与替换前缀。分隔符与大小写不敏感。
 */

/** 路径归一化（分隔符 → /，小写）：用于前缀匹配与替换定位（\\/ 与大小写均为 1:1 映射，
 * 归一化后的长度与原串一致，slice 索引可直接用于原串） */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 路径前缀匹配（目录 target 匹配自身与子路径；分隔符/大小写不敏感） */
export function pathStartsWith(path: string, target: string): boolean {
  if (path === target) return true
  return normPath(path).startsWith(normPath(target) + '/')
}

/** 替换路径前缀（target 匹配到的最前位置；分隔符/大小写不敏感，替换段保持 replacement 原文） */
export function replacePathPrefix(path: string, target: string, replacement: string): string {
  const idx = normPath(path).indexOf(normPath(target))
  if (idx < 0) return path
  return path.slice(0, idx) + replacement + path.slice(idx + target.length)
}
