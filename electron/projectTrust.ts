/**
 * 项目根信任策略（M40 巨型文件拆分批次 B3）：
 * 项目根持久化信任锚的登记/恢复/校验。对话框、fs、git、mod、game、ai 各域
 * 都从这里导入，不允许互相导入对方域文件。
 * 安全边界：信任锚键只能由主进程的对话框/导入流程写入，渲染层无法伪造。
 */
import { access } from 'node:fs/promises'
import { assertNoLinkEscape, invalidateRealRoot, isPathInside, normalizePath } from './paths'
import type { IpcContext } from './ipcContext'

/** 项目根的持久化信任锚键（A 修复：只由主进程的对话框/导入流程写入，渲染层无法伪造） */
export const PROJECT_ROOTS_KEY = 'projectRoots'
/** 旧版信任迁移标志（主进程独占写入，渲染层不可写） */
export const ANCHOR_MIGRATED_KEY = 'anchorMigratedV1'

/** 登记项目根并持久化信任锚（对话框/导入流程才调用；重启后从锚恢复信任） */
export function registerRoot(ctx: IpcContext, root: string): void {
  // 重新登记时刷新真实路径缓存（项目根可能已被删除重建/移动为链接）
  invalidateRealRoot(root)
  ctx.roots.add(normalizePath(root))
  void ctx.store.set(PROJECT_ROOTS_KEY, [...ctx.roots])
}

/** 启动时恢复持久化的项目根信任集合；仅「首次升级且从未迁移过」时从旧 workspace 迁移一次 */
export function restoreProjectRoots(ctx: IpcContext): void {
  const saved = ctx.store.get(PROJECT_ROOTS_KEY)
  if (Array.isArray(saved)) {
    for (const p of saved) {
      if (typeof p === 'string' && p) ctx.roots.add(normalizePath(p))
    }
    return
  }
  // LOW-4：锚值被异常改写（非数组非 null）时按「无锚」处理
  if (saved !== null && saved !== undefined) console.warn('[ipc] projectRoots 锚值异常，按无锚处理:', typeof saved)
  // 已迁移过（或从未有旧数据）：不再迁移，保持空信任集合
  if (ctx.store.get(ANCHOR_MIGRATED_KEY) === true) return
  // 旧版本没有信任锚：workspace.projects 里的历史项目是当时经对话框打开的，
  // 作为「旧版信任」一次性迁移登记（之后只认对话框/导入流程写入）
  const ws = ctx.store.get('workspace') as { projects?: Array<{ rootPath?: unknown }> } | undefined
  for (const p of ws?.projects ?? []) {
    if (typeof p.rootPath === 'string' && p.rootPath) ctx.roots.add(normalizePath(p.rootPath))
  }
  void ctx.store.set(PROJECT_ROOTS_KEY, [...ctx.roots])
  void ctx.store.set(ANCHOR_MIGRATED_KEY, true)
}

export function requireInsideRoot(ctx: IpcContext, rootPath: string, targetPath: string): void {
  if (!ctx.roots.has(normalizePath(rootPath))) {
    throw new Error('未登记的项目目录，拒绝访问')
  }
  if (!isPathInside(rootPath, targetPath)) {
    throw new Error('目标路径超出项目目录范围，拒绝访问')
  }
}

/**
 * 路径真实性校验（H1 修复）：词法校验之外，解析「已存在的最近祖先」的真实路径，
 * 防止项目内的 junction/符号链接把读写删重定向到项目外。
 */
export async function requireRealInsideRoot(ctx: IpcContext, rootPath: string, targetPath: string): Promise<void> {
  requireInsideRoot(ctx, rootPath, targetPath)
  await assertNoLinkEscape(rootPath, targetPath)
}

/** 通用文件存在性检查（fs/mod/game 域共用的小工具） */
export async function exists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}
