/**
 * 本地 git 辅助 IPC（M40 巨型文件拆分批次 B2）：
 * 历史/状态/冲突/差异/回滚；root 必须已登记为项目根（git:restore 是写操作）。
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { normalizePath } from './paths'
import { conflictFiles, diffBetween, logHistory, repoInfo, restoreFile, statusFiles } from './gitTools'

/** 本地 git 辅助：历史/状态/冲突/差异/回滚（路径与哈希在主进程严格校验）。
 * 安全（M26 加固）：root 必须已登记为项目根——git:restore 是写操作（checkout），
 * 不校验会让渲染层对任意目录的 git 仓库执行回滚，与其它通道「只限已登记根」一致。 */
export function registerGitIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  function requireRegisteredRoot(root: string): void {
    if (!ctx.roots.has(normalizePath(root))) throw new Error('未登记的项目目录，拒绝访问')
  }
  ipc('git:info', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return repoInfo(root)
  })
  ipc('git:log', (_event, root: unknown, limit: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return logHistory(root, typeof limit === 'number' ? limit : 40)
  })
  ipc('git:status', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return statusFiles(root)
  })
  ipc('git:conflicts', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return conflictFiles(root)
  })
  ipc('git:diff', (_event, root: unknown, a: unknown, b: unknown, file: unknown) => {
    if (typeof root !== 'string' || typeof a !== 'string' || typeof b !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return diffBetween(root, a, b, typeof file === 'string' ? file : undefined)
  })
  ipc('git:restore', (_event, root: unknown, file: unknown, commit: unknown) => {
    if (typeof root !== 'string' || typeof file !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return restoreFile(root, file, typeof commit === 'string' ? commit : 'HEAD')
  })
}
