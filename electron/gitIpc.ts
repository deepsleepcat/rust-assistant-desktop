/**
 * 本地 git 辅助 IPC（M40 巨型文件拆分批次 B2；feat/git-visual-center 扩展写操作）：
 * 历史/状态/冲突/差异/回滚 + 暂存/提交/分支/初始化/行数统计/配置；
 * root 必须已登记为项目根（restore/stage/commit/branch/init 均是写操作）。
 */
import type { IpcContext } from './ipcContext'
import type { RegisterHandler } from './ipcTypes'
import { normalizePath } from './paths'
import {
  checkoutBranch,
  commitFiles,
  conflictFiles,
  createBranch,
  deleteBranch,
  diffBetween,
  diffNumstat,
  discardFileWorktree,
  getRepoConfig,
  initRepo,
  logHistory,
  repoInfo,
  restoreFile,
  setRepoConfig,
  stageAllFiles,
  stageFiles,
  statusDetailed,
  statusFiles,
  unstageFiles,
} from './gitTools'

/** 路径数组参数校验（全部为合法相对路径才放行） */
function requirePathArray(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 500) throw new Error('参数错误')
  return paths.map((p) => {
    if (typeof p !== 'string' || !p) throw new Error('参数错误')
    return p
  })
}

/** 本地 git 辅助：历史/状态/冲突/差异/回滚 + 暂存/提交/分支/初始化（路径与哈希在主进程严格校验）。
 * 安全（M26 加固）：root 必须已登记为项目根——restore/stage/commit/branch/init 是写操作，
 * 不校验会让渲染层对任意目录的 git 仓库执行写操作，与其它通道「只限已登记根」一致。 */
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
  ipc('git:statusDetailed', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return statusDetailed(root)
  })
  ipc('git:numstat', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return diffNumstat(root)
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
  // ── Git 可视化中心写操作（全部要求已登记根；结果对象不抛错）──────────────
  ipc('git:stage', (_event, root: unknown, paths: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return stageFiles(root, requirePathArray(paths))
  })
  ipc('git:stageAll', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return stageAllFiles(root)
  })
  ipc('git:unstage', (_event, root: unknown, paths: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return unstageFiles(root, requirePathArray(paths))
  })
  ipc('git:discard', (_event, root: unknown, file: unknown) => {
    if (typeof root !== 'string' || typeof file !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return discardFileWorktree(root, file)
  })
  ipc('git:commit', (_event, root: unknown, message: unknown) => {
    if (typeof root !== 'string' || typeof message !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return commitFiles(root, message)
  })
  ipc('git:checkout', (_event, root: unknown, branch: unknown) => {
    if (typeof root !== 'string' || typeof branch !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return checkoutBranch(root, branch)
  })
  ipc('git:createBranch', (_event, root: unknown, branch: unknown, checkout: unknown) => {
    if (typeof root !== 'string' || typeof branch !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return createBranch(root, branch, checkout === true)
  })
  ipc('git:deleteBranch', (_event, root: unknown, branch: unknown, force: unknown) => {
    if (typeof root !== 'string' || typeof branch !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return deleteBranch(root, branch, force === true)
  })
  ipc('git:init', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    requireRegisteredRoot(root)
    return initRepo(root)
  })
  ipc('git:configGet', (_event, root: unknown, key: unknown) => {
    if (typeof root !== 'string' || typeof key !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return getRepoConfig(root, key)
  })
  ipc('git:configSet', (_event, root: unknown, key: unknown, value: unknown) => {
    if (typeof root !== 'string' || typeof key !== 'string' || typeof value !== 'string') throw new Error('参数错误')
    requireRegisteredRoot(root)
    return setRepoConfig(root, key, value)
  })
}
