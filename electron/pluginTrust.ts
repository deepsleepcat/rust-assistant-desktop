/**
 * 插件目录信任锚（M41 插件加载逻辑）：
 * 插件资源文件的读取基准。只有经系统对话框导入流程登记过的插件目录才可读，
 * 且读取时逐次校验「目标仍在登记目录内」。
 *
 * 安全边界：锚键 PLUGIN_DIRS_KEY 只能由主进程的导入流程写入，渲染层无法伪造
 * （已加进 storeIpc 的 MAIN_PROCESS_ONLY_STORE_KEYS）。若把插件目录当作
 * 渲染层可写的普通数据，渲染层就能伪造锚值 → 把任意系统文件当插件资源读出来。
 */
import { isPathInside, normalizePath } from './paths'
import type { IpcContext } from './ipcContext'

/** 插件 id → 插件根目录（绝对路径）的主进程独占锚键 */
export const PLUGIN_DIRS_KEY = 'pluginDirs'

/** 登记插件目录并持久化锚值（仅导入流程调用；同 id 重复导入按最后一次为准） */
export function registerPluginDir(ctx: IpcContext, pluginId: string, dir: string): void {
  const id = pluginId.toLowerCase()
  ctx.pluginDirs.set(id, normalizePath(dir))
  void ctx.store.set(PLUGIN_DIRS_KEY, Object.fromEntries(ctx.pluginDirs))
}

/** 注销插件目录（卸载插件时调用，避免锚值无限增长） */
export function unregisterPluginDir(ctx: IpcContext, pluginId: string): void {
  const id = pluginId.toLowerCase()
  if (!ctx.pluginDirs.delete(id)) return
  void ctx.store.set(PLUGIN_DIRS_KEY, Object.fromEntries(ctx.pluginDirs))
}

/** 启动时从锚值恢复插件目录集合；锚值异常（非对象）时按「无插件」处理 */
export function restorePluginDirs(ctx: IpcContext): void {
  const saved = ctx.store.get(PLUGIN_DIRS_KEY)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    if (saved !== null && saved !== undefined) console.warn('[ipc] pluginDirs 锚值异常，按无插件处理:', typeof saved)
    return
  }
  for (const [id, dir] of Object.entries(saved as Record<string, unknown>)) {
    if (typeof id === 'string' && id && typeof dir === 'string' && dir) {
      ctx.pluginDirs.set(id.toLowerCase(), normalizePath(dir))
    }
  }
}

/**
 * 取某插件已登记的根目录；未登记返回 null（不比抛错，调用方给中文提示）。
 * 词法校验放在这里，真实路径校验由调用方按需追加（资源读取用 requireRealInsideRoot 同款思路）。
 */
export function pluginDirOf(ctx: IpcContext, pluginId: string): string | null {
  return ctx.pluginDirs.get(pluginId.toLowerCase()) ?? null
}

/** 目标是否落在该插件已登记的根目录内（词法层，调用方还需做真实路径校验） */
export function isInsidePluginDir(dir: string, targetPath: string): boolean {
  return isPathInside(dir, targetPath)
}
