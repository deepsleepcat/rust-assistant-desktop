/**
 * 项目内绝对路径拼接（渲染层无 node:path）：
 * AI 工具/扫描结果给的是相对项目根的写法（units/rifle.ini），而 bridge 的 fs 通道
 * 要求绝对路径（主进程按 CWD 解析相对路径会与项目根无关，必然「超出项目目录范围」）。
 * Windows-only 应用：统一正斜杠拼接（Node fs 兼容），与主进程 requireRealInsideRoot 一致。
 */
export function joinProjectPath(rootPath: string, relPath: string): string {
  const root = rootPath.replace(/[\\/]+$/, '')
  const rel = relPath.replace(/^\/+/, '').replace(/\\/g, '/').replace(/^\.\//, '')
  // 拒绝盘符写法（C:/x）：拼接后词法上会落在根内但物理上不存在（Windows 文件名
  // 不允许 :），只读通道靠 ENOENT 兜底；显式拒绝更干净，防未来被复用于写通道
  if (rel.includes(':')) throw new Error('无效的文件路径')
  return `${root}/${rel}`
}

/** 绝对路径判断：Windows 盘符 / UNC / POSIX 根 */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
}

/**
 * 打开文件路径归一化：绝对路径（文件树节点/收藏）原样返回；
 * 相对路径（单位库扫描结果等）统一按活动项目根拼接成绝对路径，
 * 避免同一调用方因路径契约不一致被 bridge 的绝对路径校验拒绝。
 */
export function normalizeOpenPath(rootPath: string, path: string): string {
  if (isAbsolutePath(path)) return path
  return joinProjectPath(rootPath, path)
}
