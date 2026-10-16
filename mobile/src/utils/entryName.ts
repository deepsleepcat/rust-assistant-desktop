/**
 * 文件/目录名校验（纯函数）。
 *
 * 手机端用户手输名字，必须挡住会让文件操作失败或跨平台出问题的写法：
 * 路径分隔符、Windows 保留字符、控制字符、`.` / `..`、超长名。
 * 同名按「不区分大小写」拒绝——模组最终要在 Windows 上使用，
 * 同一目录里只差大小写的两个文件在那边会冲突。
 */

/** 路径分隔符与 Windows 保留字符、控制字符 */
const INVALID_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

/** 文件名长度上限（多数文件系统 255 字节，给中文名留足余量） */
const MAX_NAME_LENGTH = 100

export interface EntryNameCheck {
  ok: boolean
  /** 校验失败原因；ok 时为空串 */
  error: string
}

export function validateEntryName(name: string, existing: readonly string[] = []): EntryNameCheck {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: '名称不能为空' }
  if (trimmed === '.' || trimmed === '..') return { ok: false, error: '名称不能是 . 或 ..' }
  if (INVALID_CHARS.test(trimmed)) {
    return { ok: false, error: '名称不能包含 \\ / : * ? " < > | 或控制字符' }
  }
  if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, error: `名称不能超过 ${MAX_NAME_LENGTH} 个字符` }
  if (trimmed.endsWith('.')) return { ok: false, error: '名称不能以点号结尾' }
  const lower = trimmed.toLowerCase()
  if (existing.some((e) => e.toLowerCase() === lower)) return { ok: false, error: '同目录下已存在同名文件或文件夹' }
  return { ok: true, error: '' }
}

/**
 * 路径是否落在项目根内（拼接后按路径段归一，拒绝 `..` 向上逃逸）。
 * 手机端文件操作全部走应用私有目录，但仍要防 UI 传入越界路径。
 *
 * 空 rootPath / 空 targetPath 一律判为越界（fail-closed）：
 * `normalize('')` 得到空数组会让前缀检查整体跳过，退化成「只要不含 .. 就放行」。
 */
export function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  if (!rootPath || !targetPath) return false
  const normalize = (p: string): string[] =>
    p
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.')
  const rootSegs = normalize(rootPath)
  const targetSegs = normalize(targetPath)
  if (rootSegs.length === 0 || targetSegs.length < rootSegs.length) return false
  for (let i = 0; i < rootSegs.length; i += 1) {
    if (rootSegs[i] !== targetSegs[i]) return false
  }
  // 归一后仍含 `..` 说明出现了向上逃逸
  return !targetSegs.some((seg) => seg === '..')
}
