/**
 * IPC 注册层（与 electron 运行时解耦）：
 * - main.ts 只负责窗口/生命周期/bootstrap，把真实能力（dialog/shell/app/updater/窗口）
 *   注入 IpcContext 后调用 registerIpc 注册全部通道；
 * - 本模块不 import electron 运行时（仅类型导入），测试可用假 ipc/假依赖直接调用
 *   各域的注册函数，对核心链路做单测；
 * - 每个 handler 保持与原 main.ts 完全一致的安全边界（路径校验/白名单/互斥/大小上限）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { App, Dialog, Shell, WebContents } from 'electron'
import type { JsonStore } from './store'
import { createKnowledgePack } from './knowledgePack'
import { getHistory } from './aiHistory'
import { assertNoLinkEscape, invalidateRealRoot, isPathInside, normalizePath } from './paths'
import { checkCommunity, checkDeepSeek, communityInfo, streamAgent } from './ai'
import {
  applyOptimization, checkMod, createMod, createUnit, createUnitFromTemplate, deleteUserTemplate,
  globalOp, importModBuffer, importTemplateFile, listTemplates, listUserTemplateKeys,
  packModBufferWithCount, readModInfo, saveFileAsTemplate, scanOptimization, scanResources,
  scanUnits, writeModInfo,
} from './modTools'
import { detectGameDir, importOfficialUnits, launchGame, openDir, preflightCheck, readGameAssetImage } from './game'
import { conflictFiles, diffBetween, logHistory, repoInfo, restoreFile, statusFiles } from './gitTools'
import type { AiApprovalResponse, AiChatParams, AiSettings } from '../src/types/ai'

/** IPC 注册函数：main.ts 传 ipcMain.handle 的真实绑定；测试传记录用假实现 */
export type RegisterHandler = (channel: string, handler: (...args: never[]) => unknown) => void

/** 各域注册函数共享的依赖与可变状态（集中在一处，可注入、可断言） */
export interface IpcContext {
  /** 本地 JSON 存储（信任锚也存这里） */
  store: JsonStore
  /** 知识包（数据文件读取/更新/回滚） */
  knowledgePack: ReturnType<typeof createKnowledgePack>
  /** 已登记允许操作的项目根目录（规范化后的绝对路径） */
  roots: Set<string>
  /** 允许读取的媒体路径集合（仅对话框/自写文件来源） */
  media: Set<string>
  /** 打包/优化/全局操作互斥（批量 IO，防并发互相覆盖） */
  packing: { active: boolean }
  /** 背景音乐源（会话内登记，mod:create 只接受集合内文件） */
  musicSources: Set<string>
  /** 本会话导入创建的目录（mod:discardImport 只清理这些） */
  importedDirs: Set<string>
  /** 退出/关闭流程共享状态 */
  lifecycle: {
    /** before-quit 已进入退出流程（installUpdate 不再弹框、close 直接放行） */
    quitting: boolean
    /** 渲染层落盘确认 resolve（app:flush-done 触发） */
    flushResolve: (() => void) | null
    /** before-quit 落盘确认超时兜底 */
    flushConfirmTimer: ReturnType<typeof setTimeout> | null
    /** 窗口 close 落盘兜底定时器 */
    closeFlushTimer: ReturnType<typeof setTimeout> | null
  }
  /** AI 流互斥与审批（ai:* 处理器共享；跨通道状态集中在 ctx 才能注入/断言） */
  ai: {
    pendingApproval: { id: string; resolve: (r: AiApprovalResponse) => void } | null
    streamActive: boolean
    cancel: { current: boolean; abort?: () => void } | null
    /** M26-3 自纠闭环：当前流的质检反馈接收器（ai:feedback → 当前流；无流时返回 false） */
    feedbackReceiver: ((message: string) => boolean) | null
  }
  /** Electron 对话框（测试注入假实现） */
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog' | 'showMessageBox'>
  /** 系统能力（测试注入假实现） */
  shell: Pick<Shell, 'trashItem'>
  /** 应用信息（测试注入假实现） */
  app: Pick<App, 'getVersion' | 'getPath'>
  /** 自动更新（依赖 electron-updater，测试注入假实现） */
  updater: {
    checkForUpdates: () => Promise<void>
    downloadUpdate: () => Promise<void>
    quitAndInstall: () => void
    isPackaged: () => boolean
  }
  /** 窗口访问（app:flush-done 销毁窗口用；测试注入假实现） */
  windows: {
    getAllWindows: () => Array<{ isDestroyed(): boolean; destroy(): void }>
  }
}

/** 组装上下文：外部传入真实/假能力，可变状态在此初始化 */
export function createIpcContext(deps: {
  store: JsonStore
  knowledgePack: ReturnType<typeof createKnowledgePack>
  dialog: IpcContext['dialog']
  shell: IpcContext['shell']
  app: IpcContext['app']
  updater: IpcContext['updater']
  windows: IpcContext['windows']
}): IpcContext {
  return {
    ...deps,
    roots: new Set<string>(),
    media: new Set<string>(),
    packing: { active: false },
    musicSources: new Set<string>(),
    importedDirs: new Set<string>(),
    lifecycle: { quitting: false, flushResolve: null, flushConfirmTimer: null, closeFlushTimer: null },
    ai: { pendingApproval: null, streamActive: false, cancel: null, feedbackReceiver: null },
  }
}

/** 项目根的持久化信任锚键（A 修复：只由主进程的对话框/导入流程写入，渲染层无法伪造） */
export const PROJECT_ROOTS_KEY = 'projectRoots'
/** 旧版信任迁移标志（主进程独占写入，渲染层不可写） */
export const ANCHOR_MIGRATED_KEY = 'anchorMigratedV1'
export const MEDIA_MIGRATED_KEY = 'mediaMigratedV1'
/** 媒体允许集合持久化键 */
export const MEDIA_ALLOWLIST_KEY = 'mediaAllowlist'

/** 文本文件读取上限（编辑器打开超大文件会拖垮界面） */
const MAX_TEXT_FILE_SIZE = 64 * 1024 * 1024

/** 图片 MIME 白名单 */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
}

/** 音频 MIME 白名单（M6.5 音频预览） */
const AUDIO_MIME: Record<string, string> = {
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac',
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

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

function requireInsideRoot(ctx: IpcContext, rootPath: string, targetPath: string): void {
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
async function requireRealInsideRoot(ctx: IpcContext, rootPath: string, targetPath: string): Promise<void> {
  requireInsideRoot(ctx, rootPath, targetPath)
  await assertNoLinkEscape(rootPath, targetPath)
}

/** 登记并持久化媒体允许路径（对话框/自写文件才调用） */
function addAllowedMedia(ctx: IpcContext, p: string): void {
  ctx.media.add(normalizePath(p))
  void ctx.store.set(MEDIA_ALLOWLIST_KEY, [...ctx.media])
}

/** 从设置中提取外观背景/头像路径：仅当该路径已在允许集合（曾由对话框产生）时才保持信任 */
export function registerMediaFromSettings(ctx: IpcContext, settings: unknown): void {
  if (!settings || typeof settings !== 'object') return
  const s = settings as { background?: { imagePath?: unknown }; avatar?: { localPath?: unknown } }
  for (const p of [s.background?.imagePath, s.avatar?.localPath]) {
    if (typeof p === 'string' && p && ctx.media.has(normalizePath(p))) {
      ctx.media.add(normalizePath(p))
    }
  }
}

/** 启动时恢复持久化的媒体允许集合；仅「首次升级且从未迁移过」时从旧设置迁移一次 */
export function restoreMediaAllowlist(ctx: IpcContext): void {
  const saved = ctx.store.get(MEDIA_ALLOWLIST_KEY)
  if (Array.isArray(saved)) {
    for (const p of saved) {
      if (typeof p === 'string' && p) ctx.media.add(normalizePath(p))
    }
    return
  }
  // LOW-4：锚值被异常改写时按「无锚」处理
  if (saved !== null && saved !== undefined) console.warn('[ipc] mediaAllowlist 锚值异常，按无锚处理:', typeof saved)
  // 已迁移过（或从未有旧数据）：不再迁移，保持空信任集合
  if (ctx.store.get(MEDIA_MIGRATED_KEY) === true) return
  // 旧版本没有 allowlist 记录：设置里已存在的背景/头像路径是当时经系统对话框选择的，
  // 作为「旧版信任」一次性迁移登记（之后只认对话框来源，不再扩张）
  const s = ctx.store.get('settings') as { background?: { imagePath?: unknown }; avatar?: { localPath?: unknown } } | undefined
  for (const p of [s?.background?.imagePath, s?.avatar?.localPath]) {
    if (typeof p === 'string' && p) ctx.media.add(normalizePath(p))
  }
  void ctx.store.set(MEDIA_ALLOWLIST_KEY, [...ctx.media])
  void ctx.store.set(MEDIA_MIGRATED_KEY, true)
}

/** 读取图片/音频为 data URL：限项目内 + 扩展名白名单 + 大小上限 */
async function readMediaAsDataUrl(ctx: IpcContext, rootPath: string, mediaPath: string, mimeByExt: Record<string, string>): Promise<string> {
  if (typeof mediaPath !== 'string' || !path.isAbsolute(mediaPath)) throw new Error('无效的文件路径')
  if (rootPath) {
    // L1：与 fs:readFile 一致做链接逃逸校验（项目内指向外部的链接不能作为预览读取通道）
    await requireRealInsideRoot(ctx, rootPath, mediaPath)
  } else if (!ctx.media.has(normalizePath(mediaPath))) {
    // 空 rootPath = 外观背景：只允许读「用户通过系统选择器选中」的文件
    throw new Error('未登记的文件，拒绝访问')
  }
  const ext = path.extname(mediaPath).toLowerCase()
  const mime = mimeByExt[ext]
  if (!mime) throw new Error('不支持的文件格式')
  const stat = await fs.stat(mediaPath)
  // 媒体预览上限 20MB：100MB 全量读入 + base64 膨胀（约 1.33x）经 IPC 传输，
  // 渲染层可反复触发形成内存压力；20MB 已覆盖正常素材（png/ogg 常见几 MB）
  if (stat.size > 20 * 1024 * 1024) throw new Error('文件超过 20MB，暂不支持预览')
  const buf = await fs.readFile(mediaPath)
  return `data:${mime};base64,${buf.toString('base64')}`
}

/** Windows 非法文件名：保留设备名（CON/NUL/AUX/COM1…）+ 非法字符 + 尾点/尾空格 */
function assertValidName(name: string, what: string): void {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..') throw new Error(`无效的${what}名`)
  // eslint-disable-next-line no-control-regex -- 控制字符在文件名里不可见且易被滥用，必须拒绝
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) throw new Error(`${what}名包含非法字符（< > : " / \\ | ? *）`)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw new Error(`「${name}」是系统保留名，无法使用`)
  if (/[. ]$/.test(name)) throw new Error(`${what}名不能以点或空格结尾`)
}

/** AI 历史路径校验：rootPath 必须已登记，relPath 必须相对且解析后在项目根内 */
function requireHistoryRelPath(ctx: IpcContext, rootPath: unknown, relPath: unknown): { root: string; rel: string } {
  if (typeof rootPath !== 'string' || typeof relPath !== 'string' || !relPath) {
    throw new Error('无效的参数')
  }
  // 与 writeFile 工具 resolveInside 对齐：剥前导斜杠（AI 可能用 /units/a.txt 写法；
  // win32 上 path.isAbsolute('/units/a.txt') === true，不剥会误拒）
  const rel = relPath.replace(/^\/+/, '')
  if (!rel || path.isAbsolute(rel) || rel.includes('..')) {
    throw new Error('无效的文件路径')
  }
  requireInsideRoot(ctx, rootPath, path.join(rootPath, rel))
  return { root: rootPath, rel }
}

/** M26-3 自纠闭环：质检反馈通道（队列 + 单等待槽）。
 * - receiver：渲染层 ai:feedback 投递；等待中直接唤醒，否则入队（上限 16 条防恶意塞爆）；
 * - wait：优先取队列（多条拼接为一次修正输入），否则挂起等待（超时/被唤醒返回 null/消息）；
 * - 被唤醒后晚到的消息入队即弃（本地队列，流结束丢弃，不跨流）。 */
export function createFeedbackChannel(): {
  receiver: (msg: string) => boolean
  wait: (timeoutMs: number) => Promise<string | null>
} {
  const queue: string[] = []
  let waiter: ((msg: string | null) => void) | null = null
  return {
    receiver: (msg) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(msg)
        return true
      }
      if (queue.length < 16) {
        queue.push(msg)
        return true
      }
      return false // 队列满：丢弃（尽力而为，渲染层忽略返回值）
    },
    wait: (timeoutMs) => {
      if (queue.length > 0) return Promise.resolve(queue.splice(0).join('\n\n'))
      if (waiter) {
        waiter(null)
        waiter = null
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiter = null
          resolve(null)
        }, timeoutMs)
        waiter = (msg) => {
          clearTimeout(timer)
          resolve(msg)
        }
      })
    },
  }
}

/** 本地状态存储：store:get / store:set（保留键与大小上限由主进程强制执行） */
export function registerStoreIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('store:get', (_event, key: string) => ctx.store.get(key))

  ipc('store:set', (_event, key: string, value: unknown) => {
    // A 修复：主进程自有信任锚键（媒体允许集合/项目根集合/迁移标志）不允许渲染层写入，防伪造
    if (key === MEDIA_ALLOWLIST_KEY || key === PROJECT_ROOTS_KEY || key === ANCHOR_MIGRATED_KEY || key === MEDIA_MIGRATED_KEY) {
      throw new Error('不允许写入系统保留键')
    }
    // M 修复：store 值大小上限，防止渲染层用超大值填满磁盘/拖垮序列化。
    // workspace 键含全部对话历史（长期使用可达数十 MB），上限放宽到 50MB；
    // 其余键（settings 等）10MB
    let size = 0
    const approx = (v: unknown): void => {
      if (typeof v === 'string') size += v.length
      else if (typeof v === 'number' || typeof v === 'boolean') size += 8
      else if (v === null || v === undefined) size += 0
      else if (Array.isArray(v)) for (const x of v) approx(x)
      else if (typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) approx(x)
    }
    approx(value)
    const limit = key === 'workspace' ? 50 * 1024 * 1024 : 10 * 1024 * 1024
    if (size > limit) throw new Error(`写入的数据过大（超过 ${Math.round(limit / 1024 / 1024)}MB），已拒绝保存`)
    // L-10：媒体信任只来自对话框/自写文件（见 addAllowedMedia），
    // 设置路径的恢复在启动时由 restoreMediaAllowlist + registerMediaFromSettings 完成
    ctx.store.set(key, value)
  })
}

/** 知识包：数据文件读取 / 更新检查 / 增量更新 / 回滚 */
export function registerKnowledgeIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('knowledge:readDataFile', (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('参数错误')
    return ctx.knowledgePack.readDataFile(name)
  })
  ipc('knowledge:info', () => ctx.knowledgePack.info())
  ipc('knowledge:checkUpdate', (_event, sourceUrl: unknown) => {
    if (typeof sourceUrl !== 'string') throw new Error('参数错误')
    return ctx.knowledgePack.checkUpdate(sourceUrl)
  })
  ipc('knowledge:update', (_event, sourceUrl: unknown) => {
    if (typeof sourceUrl !== 'string') throw new Error('参数错误')
    return ctx.knowledgePack.update(sourceUrl)
  })
  ipc('knowledge:rollback', () => ctx.knowledgePack.rollback())
}

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

/** 对话框与项目根登记 */
export function registerDialogIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('dialog:openFolder', async () => {
    const result = await ctx.dialog.showOpenDialog({ properties: ['openDirectory'], title: '打开项目文件夹' })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    registerRoot(ctx, root)
    return { rootPath: root, name: path.basename(root) }
  })

  ipc('dialog:openImage', async () => {
    const result = await ctx.dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const p = result.filePaths[0]
    // 登记为允许读取的媒体（readMediaAsDataUrl 空 rootPath 分支只认这个集合）
    addAllowedMedia(ctx, p)
    return p
  })

  // M13：另存为文本（质量报告导出用）——保存位置由用户在系统对话框中选择，
  // 主进程只写用户确认的文件（defaultName 为建议文件名）
  ipc('dialog:saveText', async (_event, title: unknown, defaultName: unknown, content: unknown) => {
    if (typeof content !== 'string') return { ok: false, message: '内容无效' }
    const name = typeof defaultName === 'string' && defaultName ? path.basename(defaultName) : 'report.txt'
    const result = await ctx.dialog.showSaveDialog({
      title: typeof title === 'string' ? title : '保存文件',
      defaultPath: name,
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      await fs.writeFile(result.filePath, content, 'utf8')
      return { ok: true, path: result.filePath }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipc('project:registerRoots', (_event, roots: string[]) => {
    // A 修复：只接受「主进程自持的持久化信任锚」中的项目根（对话框/导入流程写入）——
    // 渲染层无法通过伪造 workspace 数据凭空登记任意目录为项目根
    const saved = ctx.store.get(PROJECT_ROOTS_KEY)
    const known = new Set(
      (Array.isArray(saved) ? saved : [])
        .map((p) => (typeof p === 'string' ? normalizePath(p) : ''))
        .filter(Boolean),
    )
    for (const root of roots) {
      if (typeof root === 'string' && root.length > 0 && known.has(normalizePath(root))) registerRoot(ctx, root)
    }
  })
}

/** 文件系统：读目录/读文件/写文件/新建/重命名/删除 + 图片/音频预览 */
export function registerFsIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('fs:readDir', async (_event, rootPath: string, dirPath: string, showHidden = false) => {
    await requireRealInsideRoot(ctx, rootPath, dirPath)
    const all = await fs.readdir(dirPath, { withFileTypes: true })
    // M8：显示隐藏文件开关（默认隐藏 . 开头条目；.nomedia 这类游戏文件默认不打扰）
    const entries = showHidden ? all : all.filter((e) => !e.name.startsWith('.'))
    const out = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dirPath, entry.name)
        let size = 0
        let mtimeMs = 0
        let isDirectory = entry.isDirectory()
        if (entry.isSymbolicLink()) {
          // 链接：目标在项目内才跟随 stat（链接目录正常显示为文件夹）；
          // 指向项目外/失效的链接跳过 stat（防根外文件元数据泄漏），按普通条目返回
          try {
            await assertNoLinkEscape(rootPath, full)
            const stat = await fs.stat(full)
            size = stat.size
            mtimeMs = stat.mtimeMs
            // L1：junction/符号链接在 readdir 下 isDirectory=false——按真实目标判定，
            // 链接目录在树里显示为文件夹（否则显示成文件、点击报 EISDIR）
            isDirectory = stat.isDirectory()
          } catch {
            // 根外链接/悬空链接：不返回目标元数据
          }
        } else {
          try {
            const stat = await fs.stat(full)
            size = stat.size
            mtimeMs = stat.mtimeMs
          } catch {
            // 无权限等场景：尽力读取目录信息即可
          }
        }
        return { name: entry.name, path: full, isDirectory, size, mtimeMs }
      }),
    )
    // 文件夹优先，其次按名称排序（中文按拼音浏览器区域规则排）
    out.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return out
  })

  ipc('fs:readFile', async (_event, rootPath: string, filePath: string) => {
    await requireRealInsideRoot(ctx, rootPath, filePath)
    const stat = await fs.stat(filePath)
    // L3：超大文本文件直接报错（几 GB 的文件读进内存会拖垮主进程）
    if (stat.size > MAX_TEXT_FILE_SIZE) throw new Error('文件超过 64MB，暂不支持在编辑器中打开')
    const buf = await fs.readFile(filePath)
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    const content = hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
    return { content, hasBom, mtimeMs: stat.mtimeMs, size: stat.size }
  })

  // 只读元数据（mtime/size）：外部修改轮询用，避免每 3 秒全量读盘
  ipc('fs:stat', async (_event, rootPath: string, filePath: string) => {
    await requireRealInsideRoot(ctx, rootPath, filePath)
    const stat = await fs.stat(filePath)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  })

  ipc('fs:writeFile', async (_event, rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }) => {
    await requireRealInsideRoot(ctx, rootPath, filePath)
    // L7：按 UTF-8 字节数限制（与读取上限对称；中文内容按字符数会低估体积）
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_FILE_SIZE) throw new Error('写入内容过大（超过 64MB）')
    const body = opts?.hasBom ? `\uFEFF${content}` : content
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.ra-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(tmp, body, 'utf8')
      await fs.rename(tmp, filePath)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
  })

  ipc('fs:createFile', async (_event, rootPath: string, dirPath: string, name: string) => {
    assertValidName(name, '文件')
    await requireRealInsideRoot(ctx, rootPath, dirPath)
    // name 也可能带路径分隔符（..\ 穿越）：连同拼接结果一起校验，双保险
    const target = path.join(dirPath, name)
    await requireRealInsideRoot(ctx, rootPath, target)
    // M2：已存在同名文件时拒绝（writeFile 会截断覆盖已有内容）
    if (await exists(target)) throw new Error('已存在同名文件，不会覆盖')
    await fs.writeFile(target, '', 'utf8')
  })

  ipc('fs:createFolder', async (_event, rootPath: string, dirPath: string, name: string) => {
    assertValidName(name, '文件夹')
    await requireRealInsideRoot(ctx, rootPath, dirPath)
    await requireRealInsideRoot(ctx, rootPath, path.join(dirPath, name))
    await fs.mkdir(path.join(dirPath, name), { recursive: false })
  })

  ipc('fs:rename', async (_event, rootPath: string, oldPath: string, newPath: string) => {
    // LOW：重命名的新名字也走非法名校验（与新建一致，避免 CON/非法字符等到系统层才报错）
    assertValidName(path.basename(newPath), '文件')
    // LOW-3：链接条目重命名只改链接本身（不触碰目标内容），词法校验即可
    let isLinkEntry = false
    try {
      isLinkEntry = (await fs.lstat(oldPath)).isSymbolicLink()
    } catch {
      /* 目标不存在：交给后续校验报错 */
    }
    if (isLinkEntry) {
      requireInsideRoot(ctx, rootPath, oldPath)
      requireInsideRoot(ctx, rootPath, newPath)
      // B：目标父目录可能经 junction 指向根外——链接条目不能创建/移动到根外目录；
      // LOW-1：源侧父目录同样校验（根外目录里的链接条目不能被移走）
      await assertNoLinkEscape(rootPath, path.dirname(oldPath))
      await assertNoLinkEscape(rootPath, path.dirname(newPath))
    } else {
      await requireRealInsideRoot(ctx, rootPath, oldPath)
      await requireRealInsideRoot(ctx, rootPath, newPath)
    }
    // M2：目标已存在时拒绝（Windows rename 会静默覆盖，与「已存在不覆盖」原则一致）。
    // 纯大小写改名（a.txt → A.txt）在大小写不敏感文件系统上 exists(newPath) 会命中
    // oldPath 自身——比较 lstat 的 dev+ino：同一文件放行，不同文件（Linux 真实冲突）仍拒绝
    const caseOnly = path.resolve(oldPath).toLowerCase() === path.resolve(newPath).toLowerCase() && oldPath !== newPath
    let sameTarget = false
    if (caseOnly) {
      try {
        // C：优先用 realpath 判定——大小写不敏感文件系统上两个路径解析到同一真实路径
        // 即同一文件（网络盘 ino 恒 0 时 realpath 仍可靠）；realpath 不一致再用 ino 辅助
        const [ra, rb] = await Promise.all([fs.realpath(oldPath), fs.realpath(newPath)])
        if (ra.toLowerCase() === rb.toLowerCase()) {
          sameTarget = true
        } else {
          const [a, b] = await Promise.all([fs.lstat(oldPath), fs.lstat(newPath)])
          // ino 非零才可信（个别网络盘 nFileIndex 恒 0，0===0 会把不同文件误判为同一目标）
          sameTarget = a.dev === b.dev && a.ino !== 0 && a.ino === b.ino
        }
      } catch {
        // realpath 失败（个别 Windows 配置/网络盘）：退回 lstat dev+ino 兜底判定，
        // 避免纯大小写改名被误报「已存在同名文件」
        try {
          const [a, b] = await Promise.all([fs.lstat(oldPath), fs.lstat(newPath)])
          sameTarget = a.dev === b.dev && a.ino !== 0 && a.ino === b.ino
        } catch {
          /* newPath 不存在（正常改名）：非同一目标 */
        }
      }
    }
    if (!sameTarget && (await exists(newPath))) throw new Error('已存在同名文件/文件夹，不会覆盖')
    await fs.rename(oldPath, newPath)
  })

  ipc('fs:delete', async (_event, rootPath: string, targetPath: string) => {
    // LOW-3：符号链接/junction 条目本身可以删除（不触碰目标内容）——
    // 用 lstat 判定：链接条目只做词法校验；真实文件/目录走完整链接逃逸校验
    let isLinkEntry = false
    try {
      isLinkEntry = (await fs.lstat(targetPath)).isSymbolicLink()
    } catch {
      /* 目标不存在：交给后续校验报错 */
    }
    if (!isLinkEntry) await requireRealInsideRoot(ctx, rootPath, targetPath)
    else {
      requireInsideRoot(ctx, rootPath, targetPath)
      // B：父目录可能经 junction 指向根外——链接条目不能从根外目录删除
      await assertNoLinkEscape(rootPath, path.dirname(targetPath))
    }
    // 优先移入系统回收站；回收站失败时不静默永久删除，直接报错
    await ctx.shell.trashItem(targetPath)
  })

  ipc('image:readAsDataUrl', async (_event, rootPath: string, imagePath: string) => {
    return readMediaAsDataUrl(ctx, rootPath, imagePath, IMAGE_MIME)
  })

  // M6.5 音频预览：与图片同一套安全校验（限项目内 + 白名单 + 大小上限）
  ipc('media:readAsDataUrl', async (_event, rootPath: string, mediaPath: string) => {
    return readMediaAsDataUrl(ctx, rootPath, mediaPath, AUDIO_MIME)
  })
}

/** 模组工具与模板库 */
export function registerModIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  // M6.5 模板系统：模板列表 / 基于模板创建单位
  // M7：模板列表合并用户模板目录（userData/templates），并支持把单位文件保存为模板
  const userTemplatesDir = path.join(ctx.app.getPath('userData'), 'templates')

  ipc('mod:create', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    const p = (params ?? {}) as { musicFiles?: unknown }
    // L11：背景音乐源文件必须来自「选择音乐」对话框（会话内登记），拒绝渲染层传入任意路径
    if (Array.isArray(p.musicFiles)) {
      for (const f of p.musicFiles) {
        if (typeof f !== 'string' || !ctx.musicSources.has(normalizePath(f))) {
          throw new Error('包含未经选择的音频文件，已拒绝转换（请重新通过「选择音乐」添加）')
        }
      }
    }
    return createMod(rootPath, params as import('./modTools').CreateModParams)
  })

  ipc('mod:createUnit', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return createUnit(rootPath, params as { name: string; displayName?: string; folder?: string })
  })

  ipc('mod:listTemplates', async () => listTemplates([userTemplatesDir]))

  // M23 模板库管理：导入（文件对话框 → 校验 → 复制进用户目录）/ 删除用户模板 / 用户模板 key 列表
  ipc('template:import', async () => {
    const picked = await ctx.dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '模板文件（JSON）', extensions: ['json'] }] })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return importTemplateFile(userTemplatesDir, picked.filePaths[0])
  })
  ipc('template:deleteUser', async (_event, key: unknown) => {
    if (typeof key !== 'string') return { ok: false, message: '参数错误' }
    return deleteUserTemplate(userTemplatesDir, key)
  })
  ipc('template:listUserKeys', async () => listUserTemplateKeys(userTemplatesDir))
  ipc('mod:saveFileAsTemplate', async (_event, rootPath: string, filePath: string, templateName: string, content?: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return saveFileAsTemplate(rootPath, filePath, templateName, userTemplatesDir, content)
  })
  ipc('mod:createUnitFromTemplate', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return createUnitFromTemplate(rootPath, params as { name: string; folder?: string; templateKey: string; values: Record<string, string> }, [userTemplatesDir])
  })

  // 写操作互斥：打包/全局操作都是批量 IO + 可能改写文件，并发会让内容互相覆盖。
  // 打包是全程内存 + 大量 IO 操作，并发两次会让内存翻倍且内容可能不一致
  ipc('mod:pack', async (_event, rootPath: string, options?: import('./modTools').PackOptions) => {
    if (ctx.packing.active) throw new Error('已有打包任务正在进行，请稍候')
    ctx.packing.active = true
    try {
      requireInsideRoot(ctx, rootPath, rootPath)
      // 只打包一次（避免打包两次之间文件变化导致 size/files 与写入内容不一致，也省一半 CPU）
      const { buffer, files, skippedLinks } = await packModBufferWithCount(rootPath, options ?? {})
      const suggested = path.join(path.dirname(rootPath), `${path.basename(rootPath)}.rwmod`)
      const result = await ctx.dialog.showSaveDialog({
        title: '保存打包文件',
        defaultPath: suggested,
        filters: [{ name: '铁锈战争模组包', extensions: ['rwmod'] }, { name: '压缩包', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await fs.writeFile(result.filePath, buffer)
      return { canceled: false, filePath: result.filePath, size: buffer.byteLength, files, skippedLinks }
    } finally {
      ctx.packing.active = false
    }
  })

  // mod:pack 已合并为单次打包（见上）；未暴露给界面的 packTo 已移除（最小特权）

  ipc('mod:check', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return checkMod(rootPath)
  })

  // 模组自述文件：读取（不存在返回 null）/ 写回（覆盖式）
  ipc('mod:readModInfo', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return readModInfo(rootPath)
  })
  ipc('mod:writeModInfo', async (_event, rootPath: string, data: import('./modTools').ModInfoData) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    if (!data || typeof data !== 'object' || typeof data.title !== 'string') {
      throw new Error('写入自述文件失败：参数不完整')
    }
    await writeModInfo(rootPath, data)
    return { ok: true }
  })

  // 扫描项目资源（文件列表 + 单位名），供编辑器补全联想
  ipc('mod:scanResources', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return scanResources(rootPath)
  })

  // 单位库：扫描项目内全部单位概要
  ipc('mod:scanUnits', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return scanUnits(rootPath)
  })

  // 优化工具：扫描可优化项 / 执行优化
  ipc('mod:optimizeScan', async (_event, rootPath: string) => {
    requireInsideRoot(ctx, rootPath, rootPath)
    return scanOptimization(rootPath)
  })
  ipc('mod:optimizeApply', async (_event, rootPath: string, ids: string[]) => {
    // 优化（删文件/重写空行注释）与打包/全局操作都是批量改写，纳入同一互斥域
    if (ctx.packing.active) throw new Error('已有打包/全局操作正在进行，请稍候')
    ctx.packing.active = true
    try {
      requireInsideRoot(ctx, rootPath, rootPath)
      if (!Array.isArray(ids)) throw new Error('优化参数错误：缺少项目 id 列表')
      return await applyOptimization(rootPath, ids)
    } finally {
      ctx.packing.active = false
    }
  })

  // 全局操作：对整个模组源文件批量替换/头部附加/尾部附加（M 补齐手机版功能）
  ipc('mod:globalOp', async (_event, rootPath: string, params: import('./modTools').GlobalOpParams) => {
    if (ctx.packing.active) throw new Error('已有打包/全局操作正在进行，请稍候')
    ctx.packing.active = true
    try {
      requireInsideRoot(ctx, rootPath, rootPath)
      if (!params || typeof params !== 'object') throw new Error('全局操作参数错误')
      // 文本长度上限（防注入大文本刷盘）
      if (typeof params.text === 'string' && Buffer.byteLength(params.text, 'utf8') > 1024 * 1024) {
        throw new Error('文本过长（超过 1MB），已拒绝执行')
      }
      if (typeof params.find === 'string' && Buffer.byteLength(params.find, 'utf8') > 1024 * 1024) {
        throw new Error('查找文本过长（超过 1MB），已拒绝执行')
      }
      return await globalOp(rootPath, params)
    } finally {
      ctx.packing.active = false
    }
  })

  // M6.5 背景音乐：多选音频文件（mp3/wav/flac/m4a/ogg，转码在 createMod 时进行）
  // L11：返回的路径登记为「允许转码的音频源」，mod:create 只接受这个集合内的文件
  ipc('mod:chooseMusic', async () => {
    const result = await ctx.dialog.showOpenDialog({
      title: '选择背景音乐（可多选，将转换为 ogg）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    for (const p of result.filePaths) ctx.musicSources.add(normalizePath(p))
    return result.filePaths
  })

  // M6.5 导入模组：导入类型由应用内模态框明确传入。Windows/Linux 上一次系统对话框
  // 不能同时选文件和文件夹，所以主进程只打开与导入类型对应的一种原生选择器。
  ipc('mod:import', async (_event, kind: unknown) => {
    if (kind !== 'archive' && kind !== 'folder') throw new Error('无效的模组导入类型')
    if (kind === 'folder') {
      const pick = await ctx.dialog.showOpenDialog({ title: '选择模组文件夹', properties: ['openDirectory'] })
      if (pick.canceled || pick.filePaths.length === 0) return null
      const selected = pick.filePaths[0]
      registerRoot(ctx, selected)
      return { rootPath: selected, name: path.basename(selected) }
    }

    // 文件包：.rwmod/.zip（rwmod 即 zip 容器）
    const pick = await ctx.dialog.showOpenDialog({
      title: '选择模组文件（.rwmod / .zip）',
      properties: ['openFile'],
      filters: [{ name: '模组包', extensions: ['rwmod', 'zip'] }, { name: '所有文件', extensions: ['*'] }],
    })
    if (pick.canceled || pick.filePaths.length === 0) return null
    const selected = pick.filePaths[0]

    const dest = await ctx.dialog.showOpenDialog({
      title: '选择导入位置（将自动解压到该目录下）',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (dest.canceled || dest.filePaths.length === 0) return null
    // baseName 清洗：非法字符 + 首尾点/空格（`...zip` 的 baseName 是 `..`，会路径穿越到父目录）
    let baseName = path.basename(selected, path.extname(selected)).replace(/[/:*?"<>|]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '')
    if (!baseName || baseName === '.' || baseName === '..') baseName = 'imported-mod'
    let destRoot = path.join(dest.filePaths[0], baseName)
    for (let suffix = 2; await exists(destRoot); suffix++) destRoot = path.join(dest.filePaths[0], `${baseName}-${suffix}`)
    // 原始包大小预检：超过 1GB 拒绝（全量读入内存的解压导入，超大包会 OOM）
    const pkgStat = await fs.stat(selected)
    if (pkgStat.size > 1024 * 1024 * 1024) {
      throw new Error(`导入包过大（${(pkgStat.size / 1024 / 1024 / 1024).toFixed(1)}GB，上限 1GB），请拆分后导入`)
    }
    // 解压写盘前检查批量任务互斥（不占锁——前面有两次系统对话框，占锁会长时间阻塞其它操作）
    if (ctx.packing.active) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
    const buf = await fs.readFile(selected)
    let files: number
    try {
      ;({ files } = await importModBuffer(buf, destRoot))
    } catch (err) {
      // 解压中途失败：清理半成品目录（不留残留），再抛给渲染层提示
      await fs.rm(destRoot, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    registerRoot(ctx, destRoot)
    // 登记为「本次会话导入创建」：用户取消确认时可由 mod:discardImport 清理
    ctx.importedDirs.add(normalizePath(destRoot))
    return { rootPath: destRoot, name: path.basename(destRoot), files }
  })

  // 撤销导入：用户对「未保存编辑确认」点取消后，清理刚解压但未使用的目录（不留半导入残留）。
  // 只接受本会话 mod:import 刚创建的目录（importedDirs 登记），删除后从信任锚移除。
  ipc('mod:discardImport', async (_event, rootPath: string) => {
    const norm = normalizePath(rootPath)
    if (!ctx.importedDirs.has(norm)) return { ok: false } // 不是本次会话导入的：不动
    await fs.rm(rootPath, { recursive: true, force: true }).catch(() => undefined)
    ctx.roots.delete(norm)
    void ctx.store.set(PROJECT_ROOTS_KEY, [...ctx.roots])
    ctx.importedDirs.delete(norm)
    return { ok: true }
  })
}

/** 游戏集成：检测 / 导入官方单位 / 导入已装模组 / 启动 / 运行前检查 / 资产图片 */
export function registerGameIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('game:detect', async (_event, configuredPath?: string) => {
    return detectGameDir(typeof configuredPath === 'string' && configuredPath ? configuredPath : undefined)
  })

  ipc('game:importSample', async (_event, gamePath: string, targetRoot: string, opts: { title?: string; description?: string } | null) => {
    if (typeof targetRoot !== 'string' || !ctx.roots.has(normalizePath(targetRoot))) {
      throw new Error('目标目录未登记，请重新选择文件夹')
    }
    const detected = await detectGameDir(typeof gamePath === 'string' ? gamePath : undefined)
    if (!detected.found || !detected.gamePath) throw new Error('未找到铁锈战争安装目录，请先在设置中配置游戏目录')
    if (ctx.packing.active) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
    const meta = opts ?? {}
    const result = await importOfficialUnits(detected.gamePath, targetRoot, detected.units, {
      title: typeof meta.title === 'string' && meta.title ? meta.title : '官方单位示例',
      description:
        typeof meta.description === 'string' && meta.description
          ? meta.description
          : `由铁锈助手从游戏安装目录导入的 ${detected.units.length} 个官方单位（仅供学习参考）`,
      author: 'Rusted Warfare 官方',
      version: '1.0',
    })
    registerRoot(ctx, targetRoot)
    return { rootPath: targetRoot, ...result }
  })

  ipc('game:importMod', async (_event, gamePath: string, fileName: string, targetRoot: string) => {
    if (typeof targetRoot !== 'string' || !ctx.roots.has(normalizePath(targetRoot))) {
      throw new Error('目标目录未登记，请重新选择文件夹')
    }
    const detected = await detectGameDir(typeof gamePath === 'string' ? gamePath : undefined)
    if (!detected.found || !detected.gamePath) throw new Error('未找到铁锈战争安装目录，请先在设置中配置游戏目录')
    // 文件名白名单：只接受 mods/units 下实际存在的 .rwmod（防路径穿越）
    if (typeof fileName !== 'string' || fileName !== path.basename(fileName) || !detected.mods.includes(fileName)) {
      throw new Error('无效的模组包文件名')
    }
    if (ctx.packing.active) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
    const pkg = path.join(detected.gamePath, 'mods', 'units', fileName)
    const pkgStat = await fs.stat(pkg)
    if (pkgStat.size > 1024 * 1024 * 1024) {
      throw new Error(`模组包过大（${(pkgStat.size / 1024 / 1024 / 1024).toFixed(1)}GB，上限 1GB），无法导入`)
    }
    // 在用户选定的目录下创建唯一子目录解压（与 mod:import 同款命名/去重），
    // 绝不直接解压进用户既有目录——解压失败清理也只针对本次创建的子目录，避免误删用户数据
    let baseName = path.basename(fileName, path.extname(fileName)).replace(/[/:*?"<>|]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '')
    if (!baseName || baseName === '.' || baseName === '..') baseName = 'imported-mod'
    // Windows 保留名（CON/NUL/PRN/AUX/COM1-9/LPT1-9）：mkdir 会抛 EINVAL，加后缀避开
    if (/^(con|nul|prn|aux|com[1-9]|lpt[1-9])$/i.test(baseName)) baseName += '-mod'
    let destRoot = path.join(targetRoot, baseName)
    for (let suffix = 2; await exists(destRoot); suffix++) destRoot = path.join(targetRoot, `${baseName}-${suffix}`)
    const buf = await fs.readFile(pkg)
    let files: number
    try {
      // 解压写盘前创建目录（放 try 内：读包/建目录失败都会清理，不留空目录）
      await fs.mkdir(destRoot, { recursive: true })
      ;({ files } = await importModBuffer(buf, destRoot))
    } catch (err) {
      // 解压中途失败：只清理本次创建的子目录（不留残留），用户选择的父目录不受影响
      await fs.rm(destRoot, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    registerRoot(ctx, destRoot)
    // 登记为「本次会话创建」：语义与 mod:import 一致（只针对本次创建的目录）
    ctx.importedDirs.add(normalizePath(destRoot))
    return { rootPath: destRoot, files }
  })

  // M12 试玩联动：启动游戏 / 打开目录 / 运行前检查。
  // 安全：launchGame 只接受通过 looksLikeGameDir 校验的目录；openDir 只接受
  // 已登记的项目根（打开任意目录无写风险，但保持「限制项目根」的一致性）
  ipc('game:launch', async (_event, gamePath: unknown) => {
    if (typeof gamePath !== 'string' || !gamePath) return { ok: false, message: '请先在设置中配置游戏安装目录' }
    return launchGame(gamePath)
  })

  ipc('game:openDir', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) return { ok: false, message: '目录为空' }
    const normalized = normalizePath(rootPath)
    if (!ctx.roots.has(normalized)) return { ok: false, message: '目录未登记，无法打开' }
    return openDir(normalized)
  })

  ipc('game:preflight', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) return { ok: false, issues: [{ severity: 'error' as const, message: '项目目录为空' }] }
    const normalized = normalizePath(rootPath)
    if (!ctx.roots.has(normalized)) return { ok: false, issues: [{ severity: 'error' as const, message: '项目目录未登记，无法检查' }] }
    return preflightCheck(normalized)
  })

  // M22 单位预览：读游戏资产图片（CORE:/ROOT: 官方贴图；gamePath 需通过游戏目录校验）
  ipc('game:readAssetImage', async (_event, gamePath: unknown, relPath: unknown) => {
    if (typeof gamePath !== 'string' || typeof relPath !== 'string') throw new Error('参数错误')
    return readGameAssetImage(gamePath, relPath)
  })
}

/** 应用信息 / 更新 / 头像 */
export function registerAppIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('app:info', () => ({ version: ctx.app.getVersion(), platform: process.platform }))

  // 渲染层完成退出前落盘后的确认：
  // - before-quit 路径：resolve 等待（before-quit 流程随后 flush + quit）
  // - 窗口 close 路径：销毁窗口进入正常退出流程
  ipc('app:flush-done', () => {
    if (ctx.lifecycle.flushResolve) {
      if (ctx.lifecycle.flushConfirmTimer) clearTimeout(ctx.lifecycle.flushConfirmTimer)
      const r = ctx.lifecycle.flushResolve
      ctx.lifecycle.flushResolve = null
      r()
      return true
    }
    if (ctx.lifecycle.closeFlushTimer) {
      clearTimeout(ctx.lifecycle.closeFlushTimer)
      ctx.lifecycle.closeFlushTimer = null
    }
    const win = ctx.windows.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.destroy()
    return true
  })

  // ===== M6 自动更新（更新包托管在 GitHub Releases）=====
  // 事件统一推送到 'app:update' 通道；dev 模式下检查会返回提示
  ipc('app:checkUpdate', async () => {
    if (!ctx.updater.isPackaged()) {
      return { skipped: true, message: '开发模式不检查更新' }
    }
    await ctx.updater.checkForUpdates()
    return { skipped: false }
  })
  ipc('app:downloadUpdate', async () => {
    if (!ctx.updater.isPackaged()) return { skipped: true }
    await ctx.updater.downloadUpdate()
    return { skipped: false }
  })
  ipc('app:installUpdate', async () => {
    // L3：退出流程已在进行（双击「重启并安装」）时忽略，避免截断在途的落盘写入
    if (ctx.lifecycle.quitting) return false
    // 安装=下载并执行新代码：渲染层被 XSS 后可静默触发 IPC，这里由主进程
    // 弹系统确认框（对话框不可被渲染层伪造），用户点「重启并安装」才执行
    const { response } = await ctx.dialog.showMessageBox({
      type: 'question',
      title: '重启并安装更新',
      message: '更新已下载完成，是否立即重启并安装？',
      detail: '安装期间应用会短暂退出，未保存的修改会先自动保存。',
      buttons: ['稍后再说', '重启并安装'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (response !== 1) return false
    ctx.updater.quitAndInstall()
    return true
  })

  ipc('avatar:chooseLocal', async () => {
    const result = await ctx.dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择头像图片',
      filters: [{ name: '头像图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const p = result.filePaths[0]
    // 登记为允许读取的媒体（readMediaAsDataUrl 空 rootPath 分支只认这个集合）
    addAllowedMedia(ctx, p)
    return p
  })
  // 头像裁切（M8）：渲染端 canvas 生成 PNG data URL → 写入 userData/avatar.png 并登记
  // （固定文件名覆盖式：同一用户的头像始终是这一个文件，重启后从设置自动恢复登记）
  ipc('avatar:saveCropped', async (_event, dataUrl: string) => {
    const PREFIX = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) throw new Error('无效的头像数据')
    // L2：先按字符串长度拦截超大输入（避免先解码出几百 MB 缓冲再被拒绝）
    if (dataUrl.length > 7 * 1024 * 1024) throw new Error('头像图片过大（超过 5MB）')
    const buf = Buffer.from(dataUrl.slice(PREFIX.length), 'base64')
    // 校验 PNG 魔数，拒绝伪造/损坏数据
    if (buf.byteLength < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
      throw new Error('头像数据不是有效的 PNG 图片')
    }
    if (buf.byteLength > 5 * 1024 * 1024) throw new Error('头像图片过大（超过 5MB）')
    const file = path.join(ctx.app.getPath('userData'), 'avatar.png')
    await fs.writeFile(file, buf)
    addAllowedMedia(ctx, file)
    return file
  })
  ipc('avatar:uploadCommunity', () => ({ ok: false, message: '社区头像服务即将上线' }))
}

/** AI 服务：检查 / 审批 / 中止 / 历史 / 流式对话 */
export function registerAiIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  ipc('ai:check', async (_event, settings: AiSettings) => {
    if (settings.provider === 'deepseek') {
      return checkDeepSeek({ apiKey: settings.deepseekApiKey, model: settings.deepseekModel })
    }
    if (settings.provider === 'community') {
      return checkCommunity({ endpoint: settings.communityEndpoint, token: settings.communityToken })
    }
    return { ok: false, message: '未知的 AI 提供者' }
  })

  ipc('ai:info', async () => {
    return {
      providers: [
        { type: 'deepseek', name: 'DeepSeek', description: '使用你自己的 DeepSeek API Key', available: true, models: ['deepseek-v4-flash', 'deepseek-v4-pro'] },
        { ...communityInfo(), description: '我们提供的社区 AI 服务（即将上线）' },
      ],
    }
  })

  // AI 审批：界面响应写文件请求（resolver 由 ai:stream 的 beforeToolCall 挂起等待）。
  // 审批与互斥锁都归属「当前活动流」：旧流结束的 finally 只在仍持有所有权时清理，
  // 防止 abort 后新流的状态被旧流 finally 踩踏
  ipc('ai:approval:respond', (_event, response: AiApprovalResponse) => {
    // L6：只接受「当前待审批请求」的响应；过期弹窗/旧请求的响应一律忽略。
    // 返回是否被接受——渲染层据此提示「审批已过期」，避免 120s 边缘点击被静默忽略
    if (ctx.ai.pendingApproval && response && typeof response.id === 'string' && response.id === ctx.ai.pendingApproval.id) {
      ctx.ai.pendingApproval.resolve(response)
      ctx.ai.pendingApproval = null
      return true
    }
    return false
  })

  // 渲染层看门狗触发后中止当前流：置流级取消标志（旧流事件静默 + 工具调用全拒 +
  // AbortController 硬停止在途模型请求），拒绝在途审批、释放 AI 锁
  ipc('ai:stream:abort', () => {
    if (!ctx.ai.streamActive || !ctx.ai.cancel) return { aborted: false }
    ctx.ai.cancel.current = true
    ctx.ai.cancel.abort?.() // 硬停止：中断在途模型请求（停止计费）
    ctx.ai.cancel = null
    // 唤醒质检反馈等待（空串 = 不修正）+ 清掉接收器（防残留窗口吞掉新流前的消息）
    ctx.ai.feedbackReceiver?.('')
    ctx.ai.feedbackReceiver = null
    if (ctx.ai.pendingApproval) {
      ctx.ai.pendingApproval.resolve({ id: ctx.ai.pendingApproval.id, approved: false })
      ctx.ai.pendingApproval = null
    }
    ctx.ai.streamActive = false
    return { aborted: true }
  })

  // M26-3 自纠闭环：渲染层写后质检结果回传（空串 = 无问题）。
  // 只投递给「当前活动流」的等待窗口；无流/已结束返回 false（渲染层忽略）。
  // 消息上限 8KB：防恶意渲染层塞大文本进模型上下文（有费用）
  ipc('ai:feedback', (_event, message: unknown) => {
    if (typeof message !== 'string' || message.length > 8 * 1024) throw new Error('参数错误')
    if (!ctx.ai.feedbackReceiver) return false
    return ctx.ai.feedbackReceiver(message)
  })

  // AI 修改历史（任务 2）：快照在 writeFile 工具内记录（rustAgentTools），
  // 这里的两个通道只做「列出 / 恢复」。安全边界与 fs 通道一致：
  // rootPath 必须已登记，relPath 必须相对且解析后在项目根内。
  ipc('ai:history:list', async (_event, rootPath: unknown, relPath: unknown) => {
    const { root, rel } = requireHistoryRelPath(ctx, rootPath, relPath)
    return getHistory().listHistory(root, rel)
  })

  ipc('ai:history:restore', async (_event, rootPath: unknown, relPath: unknown, snapshotId: unknown) => {
    const { root, rel } = requireHistoryRelPath(ctx, rootPath, relPath)
    if (typeof snapshotId !== 'string' || !snapshotId) {
      return { ok: false, message: '无效的历史版本' }
    }
    const entry = await getHistory().getEntry(root, rel, snapshotId)
    if (!entry) {
      return { ok: false, message: '历史版本不存在或已被清理（超过保留上限）' }
    }
    const abs = path.join(root, rel)
    await requireRealInsideRoot(ctx, root, abs)
    if (entry.content === null) {
      // 快照时文件不存在（AI 新建）：恢复 = 删除该文件
      await fs.rm(abs, { force: true })
      return { ok: true, deleted: true }
    }
    // 原子写回（与 fs:writeFile 同一模式：临时文件 + rename，不破坏原文件）
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.ra-h-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(tmp, entry.content, 'utf8')
      await fs.rename(tmp, abs)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    }
    return { ok: true }
  })

  ipc('ai:stream', async (event: { sender: { isDestroyed(): boolean; send(channel: string, data: unknown): void } }, params: AiChatParams, settings: AiSettings, projectRoot: unknown) => {
    if (ctx.ai.streamActive) throw new Error('已有 AI 请求正在处理，请稍候再试')
    ctx.ai.streamActive = true
    // 每次流独立的取消标志：abort 只影响本流，新流不受旧流状态影响
    const cancelled: { current: boolean; abort?: () => void } = { current: false }
    ctx.ai.cancel = cancelled
    // M26-3 自纠闭环：本流的质检反馈等待窗口（渲染层 ai:feedback 投递到这里）
    const feedbackChannel = createFeedbackChannel()
    ctx.ai.feedbackReceiver = feedbackChannel.receiver
    // 主进程总时长兜底（15 分钟）：渲染层看门狗是 5 分钟无事件；若渲染层崩溃/关闭，
    // 旧流会永远占着 AI 锁——此处强制置取消 + 释放锁（工具全拒、事件静默，无副作用）
    const hardKill = setTimeout(() => {
      if (ctx.ai.cancel !== cancelled) return // 已被 abort/结束：跳过
      cancelled.current = true
      cancelled.abort?.() // 硬停止在途模型请求
      ctx.ai.cancel = null
      // 唤醒质检反馈等待（空串 = 不修正），避免 finally 被等待卡住、AI 锁迟迟不释放
      ctx.ai.feedbackReceiver?.('')
      ctx.ai.feedbackReceiver = null
      if (ctx.ai.pendingApproval) {
        ctx.ai.pendingApproval.resolve({ id: ctx.ai.pendingApproval.id, approved: false })
        ctx.ai.pendingApproval = null
      }
      ctx.ai.streamActive = false
    }, 15 * 60 * 1000)
    try {
      const sender = event.sender
      // 固定通道：单窗口应用，事件只推给发起请求的窗口
      const channel = 'ai:stream'
      // 项目根由渲染进程显式传入（持久化是防抖 300ms 写入，主进程读 store 可能拿到旧项目）。
      // 路径不可信，但只能指向用户打开过并已登记的项目。
      if (typeof projectRoot !== 'string' || !ctx.roots.has(normalizePath(projectRoot))) {
        throw new Error('项目未登记，无法使用 AI 工具，请重新打开项目')
      }
      // 消息体上限：恶意渲染层可传超大历史（内存 + API 费用）；200 条 / 2MB
      const messages = Array.isArray(params?.messages) ? params.messages : []
      if (messages.length > 200) throw new Error('对话历史过长（超过 200 条），请新建对话')
      let totalChars = 0
      for (const m of messages) {
        if (m && typeof m === 'object' && 'content' in m) totalChars += String((m as { content: unknown }).content ?? '').length
      }
      if (totalChars > 2 * 1024 * 1024) throw new Error('对话历史过大（超过 2MB），请新建对话')
      if (settings.provider === 'deepseek') {
        await streamAgent(
          sender as unknown as WebContents,
          channel,
          params,
          { apiKey: settings.deepseekApiKey, model: settings.deepseekModel },
          projectRoot,
          (id, resolve) => {
            // beforeToolCall 提供请求 id 与 resolve；approval:respond 按 id 匹配。
            // 本流已取消：新到的审批请求直接拒绝，不挂 UI
            if (cancelled.current) {
              resolve({ id, approved: false })
              return () => undefined
            }
            ctx.ai.pendingApproval = { id, resolve }
            // 返回清除回调：审批超时（ai.ts 120s）时清掉单槽 pendingApproval，
            // 防止过期响应命中旧 id 被误报「已批准」
            return () => {
              if (ctx.ai.pendingApproval?.id === id) ctx.ai.pendingApproval = null
            }
          },
          cancelled,
          feedbackChannel,
        )
      } else {
        // 流已取消则不发送（与 emit 静默一致，防旧流 error 命中新流监听器）
        if (!cancelled.current && !sender.isDestroyed()) sender.send(channel, { type: 'error', message: '社区 AI 服务即将上线' })
      }
      return channel
    } finally {
      clearTimeout(hardKill) // 流结束：取消强杀计时器
      // 所有权判断：只有本流仍是「当前活动流」时才清理全局状态——
      // abort 后用户已启动新流时，旧流的 finally 不能踩踏新流的审批/锁
      if (ctx.ai.cancel === cancelled) {
        ctx.ai.cancel = null
        ctx.ai.streamActive = false
        ctx.ai.pendingApproval = null
        ctx.ai.feedbackReceiver = null
      }
    }
  })
}

/** 注册全部 IPC 通道（按域拆分，便于测试与维护） */
export function registerIpc(ctx: IpcContext, ipc: RegisterHandler): void {
  registerStoreIpc(ctx, ipc)
  registerKnowledgeIpc(ctx, ipc)
  registerGitIpc(ctx, ipc)
  registerDialogIpc(ctx, ipc)
  registerFsIpc(ctx, ipc)
  registerModIpc(ctx, ipc)
  registerGameIpc(ctx, ipc)
  registerAppIpc(ctx, ipc)
  registerAiIpc(ctx, ipc)
}
