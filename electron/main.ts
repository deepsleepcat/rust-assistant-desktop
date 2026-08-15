/**
 * Electron 主进程：
 * - 创建桌面窗口（隐藏系统标题栏，保留原生窗口控制按钮）
 * - 通过 IPC 向界面提供受限能力：文件读写（仅限已登记的项目目录）、
 *   目录选择、图片读取、本地状态存储
 * - 界面进程永远无法直接访问 Node，只能调用这里暴露的命令
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createStore } from './store'
import { getHistory, initAiHistory } from './aiHistory'
import { assertNoLinkEscape, invalidateRealRoot, isPathInside, normalizePath } from './paths'
import { checkCommunity, checkDeepSeek, communityInfo, streamAgent } from './ai'
import { applyOptimization, checkMod, createMod, createUnit, createUnitFromTemplate, deleteUserTemplate, globalOp, importModBuffer, importTemplateFile, listTemplates, listUserTemplateKeys, packModBufferWithCount, readModInfo, saveFileAsTemplate, scanOptimization, scanResources, scanUnits, writeModInfo } from './modTools'
import { detectGameDir, importOfficialUnits, launchGame, openDir, preflightCheck, readGameAssetImage } from './game'
import { checkForUpdates, downloadUpdate, isPackaged, quitAndInstall, setupUpdater } from './updater'
import { createKnowledgePack } from './knowledgePack'
import { conflictFiles, diffBetween, logHistory, repoInfo, restoreFile, statusFiles } from './gitTools'
import type { AiChatParams, AiSettings } from '../src/types/ai'

const devUrl = process.env.VITE_DEV_SERVER_URL

/** 窗口关闭落盘确认的兜底定时器（模块级：close handler 与 app:flush-done 共用） */
let closeFlushTimer: ReturnType<typeof setTimeout> | null = null

/** 已登记允许操作的项目根目录（规范化后的绝对路径） */
const allowedRoots = new Set<string>()
/** 项目根的持久化信任锚（A 修复：只由主进程的对话框/导入流程写入，渲染层无法伪造） */
const PROJECT_ROOTS_KEY = 'projectRoots'
/**
 * 旧版信任迁移标志（主进程独占写入，渲染层不可写）。
 * 无锚且无此标志时执行一次「旧版迁移」；之后即使锚被清空也不再从渲染层数据迁移，
 * 防止渲染层改 store 后重启反复触发迁移、把任意路径登记进信任锚。
 * 注意：项目根与媒体各自独立标志——若共用，先跑的媒体迁移会置位后，
 * 项目根迁移被跳过，老用户升级后所有历史项目失去信任。
 */
const ANCHOR_MIGRATED_KEY = 'anchorMigratedV1'
const MEDIA_MIGRATED_KEY = 'mediaMigratedV1'

function registerRoot(root: string): void {
  // 重新登记时刷新真实路径缓存（项目根可能已被删除重建/移动为链接）
  invalidateRealRoot(root)
  allowedRoots.add(normalizePath(root))
  // 持久化信任锚：重启后 registerRoots 从这里恢复信任
  void store.set(PROJECT_ROOTS_KEY, [...allowedRoots])
}

/** 启动时恢复持久化的项目根信任集合；仅「首次升级且从未迁移过」时从旧 workspace 迁移一次 */
function restoreProjectRoots(): void {
  const saved = store.get(PROJECT_ROOTS_KEY)
  if (Array.isArray(saved)) {
    for (const p of saved) {
      if (typeof p === 'string' && p) allowedRoots.add(normalizePath(p))
    }
    return
  }
  // LOW-4：锚值被异常改写（非数组非 null）时按「无锚」处理
  if (saved !== null && saved !== undefined) console.warn('[main] projectRoots 锚值异常，按无锚处理:', typeof saved)
  // 已迁移过（或从未有旧数据）：不再迁移，保持空信任集合
  if (store.get(ANCHOR_MIGRATED_KEY) === true) return
  // 旧版本没有信任锚：workspace.projects 里的历史项目是当时经对话框打开的，
  // 作为「旧版信任」一次性迁移登记（之后只认对话框/导入流程写入）
  const ws = store.get('workspace') as { projects?: Array<{ rootPath?: unknown }> } | undefined
  for (const p of ws?.projects ?? []) {
    if (typeof p.rootPath === 'string' && p.rootPath) allowedRoots.add(normalizePath(p.rootPath))
  }
  void store.set(PROJECT_ROOTS_KEY, [...allowedRoots])
  void store.set(ANCHOR_MIGRATED_KEY, true)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function requireInsideRoot(rootPath: string, targetPath: string): void {
  if (!allowedRoots.has(normalizePath(rootPath))) {
    throw new Error('未登记的项目目录，拒绝访问')
  }
  if (!isPathInside(rootPath, targetPath)) {
    throw new Error('目标路径超出项目目录范围，拒绝访问')
  }
}

/**
 * 路径真实性校验（H1 修复）：词法校验之外，解析「已存在的最近祖先」的真实路径，
 * 防止项目内的 junction/符号链接把读写删重定向到项目外。
 * 实现与基准逻辑见 paths.ts 的 assertNoLinkEscape（项目根真实路径做基准，不误拒链接根）。
 */
async function requireRealInsideRoot(rootPath: string, targetPath: string): Promise<void> {
  requireInsideRoot(rootPath, targetPath)
  await assertNoLinkEscape(rootPath, targetPath)
}

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

/**
 * 允许读取的媒体路径集合（M3 修复：持久化 + 信任不扩张）。
 * 只信任两条来源：①系统对话框返回的路径（dialog:openImage / avatar:chooseLocal）；
 * ②应用自己写入的头像文件（avatar:saveCropped）。集合持久化到 store，
 * 重启后从磁盘恢复——渲染层仅凭 store.set('settings', …) 无法新增信任。
 */
const allowedMedia = new Set<string>()
const MEDIA_ALLOWLIST_KEY = 'mediaAllowlist'

/** 登记并持久化（对话框/自写文件才调用） */
function addAllowedMedia(p: string): void {
  allowedMedia.add(normalizePath(p))
  void store.set(MEDIA_ALLOWLIST_KEY, [...allowedMedia])
}

/** 从设置中提取外观背景/头像路径：仅当该路径已在允许集合（曾由对话框产生）时才保持信任 */
function registerMediaFromSettings(settings: unknown): void {
  if (!settings || typeof settings !== 'object') return
  const s = settings as { background?: { imagePath?: unknown }; avatar?: { localPath?: unknown } }
  for (const p of [s.background?.imagePath, s.avatar?.localPath]) {
    if (typeof p === 'string' && p && allowedMedia.has(normalizePath(p))) {
      allowedMedia.add(normalizePath(p))
    }
  }
}

/** 启动时恢复持久化的媒体允许集合；仅「首次升级且从未迁移过」时从旧设置迁移一次 */
function restoreMediaAllowlist(): void {
  const saved = store.get(MEDIA_ALLOWLIST_KEY)
  if (Array.isArray(saved)) {
    for (const p of saved) {
      if (typeof p === 'string' && p) allowedMedia.add(normalizePath(p))
    }
    return
  }
  // LOW-4：锚值被异常改写时按「无锚」处理
  if (saved !== null && saved !== undefined) console.warn('[main] mediaAllowlist 锚值异常，按无锚处理:', typeof saved)
  // 已迁移过（或从未有旧数据）：不再迁移，保持空信任集合
  if (store.get(MEDIA_MIGRATED_KEY) === true) return
  // 旧版本没有 allowlist 记录：设置里已存在的背景/头像路径是当时经系统对话框选择的，
  // 作为「旧版信任」一次性迁移登记（之后只认对话框来源，不再扩张）
  const s = store.get('settings') as { background?: { imagePath?: unknown }; avatar?: { localPath?: unknown } } | undefined
  for (const p of [s?.background?.imagePath, s?.avatar?.localPath]) {
    if (typeof p === 'string' && p) allowedMedia.add(normalizePath(p))
  }
  void store.set(MEDIA_ALLOWLIST_KEY, [...allowedMedia])
  void store.set(MEDIA_MIGRATED_KEY, true)
}

/** 读取图片/音频为 data URL：限项目内 + 扩展名白名单 + 大小上限 */
async function readMediaAsDataUrl(rootPath: string, mediaPath: string, mimeByExt: Record<string, string>): Promise<string> {
  if (typeof mediaPath !== 'string' || !path.isAbsolute(mediaPath)) throw new Error('无效的文件路径')
  if (rootPath) {
    // L1：与 fs:readFile 一致做链接逃逸校验（项目内指向外部的链接不能作为预览读取通道）
    await requireRealInsideRoot(rootPath, mediaPath)
  } else if (!allowedMedia.has(normalizePath(mediaPath))) {
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

const store = createStore(path.join(app.getPath('userData'), 'app-state.json'))
// AI 修改历史（任务 2）：独立 JSON 文件，避免与主 store 共用导致每次设置变更重写大文件
initAiHistory(path.join(app.getPath('userData'), 'ai-history.json'))
// M18 知识包更新器：可更新数据放 userData/knowledge-pack，内置数据回退 public/data
const knowledgePack = createKnowledgePack(
  path.join(app.getPath('userData'), 'knowledge-pack'),
  path.join(__dirname, '..', '..', 'public', 'data'),
)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: '铁锈助手',
    backgroundColor: '#f6f7f9',
    // R Logo 图标（任务栏/窗口图标；打包后由 electron-builder 注入 exe）
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    // 隐藏标题栏文字，保留系统窗口控制按钮（最小化/最大化/关闭）
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f6f7f9', symbolColor: '#57606a', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  // 阻止页面跳转到外部地址，防止被导航劫持（精确匹配开发服务器 origin+path，前缀劫持一律拦截）
  win.webContents.on('will-navigate', (event, url) => {
    if (devUrl) {
      try {
        const dev = new URL(devUrl)
        const target = new URL(url)
        if (target.origin === dev.origin && target.pathname === dev.pathname) return
      } catch {
        /* 无法解析的地址一律拦截 */
      }
    }
    event.preventDefault()
  })
  // LOW-3b：窗口关闭前通知渲染层立即落盘（renderer 300ms 防抖的最后写入不丢失）。
  // 等渲染层 flush 完成确认（app:flush-done）后再销毁窗口；1s 超时兜底，避免渲染层
  // 崩溃/卡死时关不掉窗口。退出流程中（quitting）直接放行，不重复走确认链。
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    if (!win.webContents.isDestroyed()) win.webContents.send('app:before-close')
    if (closeFlushTimer) clearTimeout(closeFlushTimer)
    closeFlushTimer = setTimeout(() => win.destroy(), 1000)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }
  return win
}

function registerIpc(): void {
  // M18 知识包更新器（数据文件读取/更新检查/增量更新/回滚；源 URL 由渲染层设置提供）
  ipcMain.handle('knowledge:readDataFile', (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('参数错误')
    return knowledgePack.readDataFile(name)
  })
  ipcMain.handle('knowledge:info', () => knowledgePack.info())
  ipcMain.handle('knowledge:checkUpdate', (_event, sourceUrl: unknown) => {
    if (typeof sourceUrl !== 'string') throw new Error('参数错误')
    return knowledgePack.checkUpdate(sourceUrl)
  })
  ipcMain.handle('knowledge:update', (_event, sourceUrl: unknown) => {
    if (typeof sourceUrl !== 'string') throw new Error('参数错误')
    return knowledgePack.update(sourceUrl)
  })
  ipcMain.handle('knowledge:rollback', () => knowledgePack.rollback())
  // M25 本地 git 辅助（历史/冲突/回滚；路径与哈希在主进程严格校验）
  ipcMain.handle('git:info', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    return repoInfo(root)
  })
  ipcMain.handle('git:log', (_event, root: unknown, limit: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    return logHistory(root, typeof limit === 'number' ? limit : 40)
  })
  ipcMain.handle('git:status', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    return statusFiles(root)
  })
  ipcMain.handle('git:conflicts', (_event, root: unknown) => {
    if (typeof root !== 'string' || !root) throw new Error('参数错误')
    return conflictFiles(root)
  })
  ipcMain.handle('git:diff', (_event, root: unknown, a: unknown, b: unknown, file: unknown) => {
    if (typeof root !== 'string' || typeof a !== 'string' || typeof b !== 'string') throw new Error('参数错误')
    return diffBetween(root, a, b, typeof file === 'string' ? file : undefined)
  })
  ipcMain.handle('git:restore', (_event, root: unknown, file: unknown, commit: unknown) => {
    if (typeof root !== 'string' || typeof file !== 'string') throw new Error('参数错误')
    return restoreFile(root, file, typeof commit === 'string' ? commit : 'HEAD')
  })
  ipcMain.handle('store:get', (_event, key: string) => store.get(key))
  ipcMain.handle('store:set', (_event, key: string, value: unknown) => {
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
    store.set(key, value)
  })

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '打开项目文件夹' })
    if (result.canceled || result.filePaths.length === 0) return null
    const root = result.filePaths[0]
    registerRoot(root)
    return { rootPath: root, name: path.basename(root) }
  })

  ipcMain.handle('dialog:openImage', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const p = result.filePaths[0]
    // 登记为允许读取的媒体（readMediaAsDataUrl 空 rootPath 分支只认这个集合）
    addAllowedMedia(p)
    return p
  })

  // M13：另存为文本（质量报告导出用）——保存位置由用户在系统对话框中选择，
  // 主进程只写用户确认的文件（defaultName 为建议文件名）
  ipcMain.handle('dialog:saveText', async (_event, title: unknown, defaultName: unknown, content: unknown) => {
    if (typeof content !== 'string') return { ok: false, message: '内容无效' }
    const name = typeof defaultName === 'string' && defaultName ? path.basename(defaultName) : 'report.txt'
    const result = await dialog.showSaveDialog({
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

  ipcMain.handle('project:registerRoots', (_event, roots: string[]) => {
    // A 修复：只接受「主进程自持的持久化信任锚」中的项目根（对话框/导入流程写入）——
    // 渲染层无法通过伪造 workspace 数据凭空登记任意目录为项目根
    const saved = store.get(PROJECT_ROOTS_KEY)
    const known = new Set(
      (Array.isArray(saved) ? saved : [])
        .map((p) => (typeof p === 'string' ? normalizePath(p) : ''))
        .filter(Boolean),
    )
    for (const root of roots) {
      if (typeof root === 'string' && root.length > 0 && known.has(normalizePath(root))) registerRoot(root)
    }
  })

  ipcMain.handle('fs:readDir', async (_event, rootPath: string, dirPath: string, showHidden = false) => {
    await requireRealInsideRoot(rootPath, dirPath)
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

  ipcMain.handle('fs:readFile', async (_event, rootPath: string, filePath: string) => {
    await requireRealInsideRoot(rootPath, filePath)
    const stat = await fs.stat(filePath)
    // L3：超大文本文件直接报错（几 GB 的文件读进内存会拖垮主进程）
    if (stat.size > MAX_TEXT_FILE_SIZE) throw new Error('文件超过 64MB，暂不支持在编辑器中打开')
    const buf = await fs.readFile(filePath)
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    const content = hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
    return { content, hasBom, mtimeMs: stat.mtimeMs, size: stat.size }
  })

  // 只读元数据（mtime/size）：外部修改轮询用，避免每 3 秒全量读盘
  ipcMain.handle('fs:stat', async (_event, rootPath: string, filePath: string) => {
    await requireRealInsideRoot(rootPath, filePath)
    const stat = await fs.stat(filePath)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  })

  ipcMain.handle('fs:writeFile', async (_event, rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }) => {
    await requireRealInsideRoot(rootPath, filePath)
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

  /** Windows 非法文件名：保留设备名（CON/NUL/AUX/COM1…）+ 非法字符 + 尾点/尾空格 */
  function assertValidName(name: string, what: string): void {
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..') throw new Error(`无效的${what}名`)
    // eslint-disable-next-line no-control-regex -- 控制字符在文件名里不可见且易被滥用，必须拒绝
    if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) throw new Error(`${what}名包含非法字符（< > : " / \\ | ? *）`)
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw new Error(`「${name}」是系统保留名，无法使用`)
    if (/[. ]$/.test(name)) throw new Error(`${what}名不能以点或空格结尾`)
  }

  ipcMain.handle('fs:createFile', async (_event, rootPath: string, dirPath: string, name: string) => {
    assertValidName(name, '文件')
    await requireRealInsideRoot(rootPath, dirPath)
    // name 也可能带路径分隔符（..\ 穿越）：连同拼接结果一起校验，双保险
    const target = path.join(dirPath, name)
    await requireRealInsideRoot(rootPath, target)
    // M2：已存在同名文件时拒绝（writeFile 会截断覆盖已有内容）
    if (await exists(target)) throw new Error('已存在同名文件，不会覆盖')
    await fs.writeFile(target, '', 'utf8')
  })

  ipcMain.handle('fs:createFolder', async (_event, rootPath: string, dirPath: string, name: string) => {
    assertValidName(name, '文件夹')
    await requireRealInsideRoot(rootPath, dirPath)
    await requireRealInsideRoot(rootPath, path.join(dirPath, name))
    await fs.mkdir(path.join(dirPath, name), { recursive: false })
  })

  ipcMain.handle('fs:rename', async (_event, rootPath: string, oldPath: string, newPath: string) => {
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
      requireInsideRoot(rootPath, oldPath)
      requireInsideRoot(rootPath, newPath)
      // B：目标父目录可能经 junction 指向根外——链接条目不能创建/移动到根外目录；
      // LOW-1：源侧父目录同样校验（根外目录里的链接条目不能被移走）
      await assertNoLinkEscape(rootPath, path.dirname(oldPath))
      await assertNoLinkEscape(rootPath, path.dirname(newPath))
    } else {
      await requireRealInsideRoot(rootPath, oldPath)
      await requireRealInsideRoot(rootPath, newPath)
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

  ipcMain.handle('fs:delete', async (_event, rootPath: string, targetPath: string) => {
    // LOW-3：符号链接/junction 条目本身可以删除（不触碰目标内容）——
    // 用 lstat 判定：链接条目只做词法校验；真实文件/目录走完整链接逃逸校验
    let isLinkEntry = false
    try {
      isLinkEntry = (await fs.lstat(targetPath)).isSymbolicLink()
    } catch {
      /* 目标不存在：交给后续校验报错 */
    }
    if (!isLinkEntry) await requireRealInsideRoot(rootPath, targetPath)
    else {
      requireInsideRoot(rootPath, targetPath)
      // B：父目录可能经 junction 指向根外——链接条目不能从根外目录删除
      await assertNoLinkEscape(rootPath, path.dirname(targetPath))
    }
    // 优先移入系统回收站；回收站失败时不静默永久删除，直接报错
    await shell.trashItem(targetPath)
  })

  // M5 模组工具：新建模组 / 新建单位 / 打包 / 检查（全部限制在项目根目录内）
  ipcMain.handle('mod:create', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(rootPath, rootPath)
    const p = (params ?? {}) as { musicFiles?: unknown }
    // L11：背景音乐源文件必须来自「选择音乐」对话框（会话内登记），拒绝渲染层传入任意路径
    if (Array.isArray(p.musicFiles)) {
      for (const f of p.musicFiles) {
        if (typeof f !== 'string' || !allowedMusicSources.has(normalizePath(f))) {
          throw new Error('包含未经选择的音频文件，已拒绝转换（请重新通过「选择音乐」添加）')
        }
      }
    }
    return createMod(rootPath, params as import('./modTools').CreateModParams)
  })

  ipcMain.handle('mod:createUnit', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(rootPath, rootPath)
    return createUnit(rootPath, params as { name: string; displayName?: string; folder?: string })
  })

  // M6.5 模板系统：模板列表 / 基于模板创建单位
  // M7：模板列表合并用户模板目录（userData/templates），并支持把单位文件保存为模板
  const userTemplatesDir = path.join(app.getPath('userData'), 'templates')
  ipcMain.handle('mod:listTemplates', async () => listTemplates([userTemplatesDir]))
  // M23 模板库管理：导入（文件对话框 → 校验 → 复制进用户目录）/ 删除用户模板 / 用户模板 key 列表
  ipcMain.handle('template:import', async () => {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '模板文件（JSON）', extensions: ['json'] }] })
    if (picked.canceled || picked.filePaths.length === 0) return null
    return importTemplateFile(userTemplatesDir, picked.filePaths[0])
  })
  ipcMain.handle('template:deleteUser', async (_event, key: unknown) => {
    if (typeof key !== 'string') return { ok: false, message: '参数错误' }
    return deleteUserTemplate(userTemplatesDir, key)
  })
  ipcMain.handle('template:listUserKeys', async () => listUserTemplateKeys(userTemplatesDir))
  ipcMain.handle('mod:saveFileAsTemplate', async (_event, rootPath: string, filePath: string, templateName: string, content?: string) => {
    requireInsideRoot(rootPath, rootPath)
    return saveFileAsTemplate(rootPath, filePath, templateName, userTemplatesDir, content)
  })
  ipcMain.handle('mod:createUnitFromTemplate', async (_event, rootPath: string, params: unknown) => {
    requireInsideRoot(rootPath, rootPath)
    return createUnitFromTemplate(rootPath, params as { name: string; folder?: string; templateKey: string; values: Record<string, string> }, [userTemplatesDir])
  })

  // 写操作互斥：打包/全局操作都是批量 IO + 可能改写文件，并发会让内容互相覆盖。
  // 打包是全程内存 + 大量 IO 操作，并发两次会让内存翻倍且内容可能不一致
  let packing = false
  ipcMain.handle('mod:pack', async (_event, rootPath: string, options?: import('./modTools').PackOptions) => {
    if (packing) throw new Error('已有打包任务正在进行，请稍候')
    packing = true
    try {
      requireInsideRoot(rootPath, rootPath)
      // 只打包一次（避免打包两次之间文件变化导致 size/files 与写入内容不一致，也省一半 CPU）
      const { buffer, files, skippedLinks } = await packModBufferWithCount(rootPath, options ?? {})
      const suggested = path.join(path.dirname(rootPath), `${path.basename(rootPath)}.rwmod`)
      const result = await dialog.showSaveDialog({
        title: '保存打包文件',
        defaultPath: suggested,
        filters: [{ name: '铁锈战争模组包', extensions: ['rwmod'] }, { name: '压缩包', extensions: ['zip'] }],
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await fs.writeFile(result.filePath, buffer)
      return { canceled: false, filePath: result.filePath, size: buffer.byteLength, files, skippedLinks }
    } finally {
      packing = false
    }
  })

  // mod:pack 已合并为单次打包（见上）；未暴露给界面的 packTo 已移除（最小特权）

  ipcMain.handle('mod:check', async (_event, rootPath: string) => {
    requireInsideRoot(rootPath, rootPath)
    return checkMod(rootPath)
  })

  // 模组自述文件：读取（不存在返回 null）/ 写回（覆盖式）
  ipcMain.handle('mod:readModInfo', async (_event, rootPath: string) => {
    requireInsideRoot(rootPath, rootPath)
    return readModInfo(rootPath)
  })
  ipcMain.handle('mod:writeModInfo', async (_event, rootPath: string, data: import('./modTools').ModInfoData) => {
    requireInsideRoot(rootPath, rootPath)
    if (!data || typeof data !== 'object' || typeof data.title !== 'string') {
      throw new Error('写入自述文件失败：参数不完整')
    }
    await writeModInfo(rootPath, data)
    return { ok: true }
  })

  // 扫描项目资源（文件列表 + 单位名），供编辑器补全联想
  ipcMain.handle('mod:scanResources', async (_event, rootPath: string) => {
    requireInsideRoot(rootPath, rootPath)
    return scanResources(rootPath)
  })

  // 单位库：扫描项目内全部单位概要
  ipcMain.handle('mod:scanUnits', async (_event, rootPath: string) => {
    requireInsideRoot(rootPath, rootPath)
    return scanUnits(rootPath)
  })

  // 优化工具：扫描可优化项 / 执行优化
  ipcMain.handle('mod:optimizeScan', async (_event, rootPath: string) => {
    requireInsideRoot(rootPath, rootPath)
    return scanOptimization(rootPath)
  })
  ipcMain.handle('mod:optimizeApply', async (_event, rootPath: string, ids: string[]) => {
    // 优化（删文件/重写空行注释）与打包/全局操作都是批量改写，纳入同一互斥域
    if (packing) throw new Error('已有打包/全局操作正在进行，请稍候')
    packing = true
    try {
      requireInsideRoot(rootPath, rootPath)
      if (!Array.isArray(ids)) throw new Error('优化参数错误：缺少项目 id 列表')
      return await applyOptimization(rootPath, ids)
    } finally {
      packing = false
    }
  })

  // 全局操作：对整个模组源文件批量替换/头部附加/尾部附加（M 补齐手机版功能）
  ipcMain.handle('mod:globalOp', async (_event, rootPath: string, params: import('./modTools').GlobalOpParams) => {
    if (packing) throw new Error('已有打包/全局操作正在进行，请稍候')
    packing = true
    try {
      requireInsideRoot(rootPath, rootPath)
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
      packing = false
    }
  })

  // M6.5 背景音乐：多选音频文件（mp3/wav/flac/m4a/ogg，转码在 createMod 时进行）
  // L11：返回的路径登记为「允许转码的音频源」，mod:create 只接受这个集合内的文件
  const allowedMusicSources = new Set<string>()
  ipcMain.handle('mod:chooseMusic', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择背景音乐（可多选，将转换为 ogg）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    for (const p of result.filePaths) allowedMusicSources.add(normalizePath(p))
    return result.filePaths
  })

  // M6.5 导入 .rwmod：选文件 → 选目标目录 → 解压 → 注册为项目
  ipcMain.handle('mod:import', async () => {
    const pick = await dialog.showOpenDialog({
      title: '导入模组（文件夹或 rwmod/zip）',
      properties: ['openFile', 'openDirectory', 'createDirectory'],
      filters: [{ name: '模组包', extensions: ['rwmod', 'zip'] }, { name: '所有文件', extensions: ['*'] }],
    })
    if (pick.canceled || pick.filePaths.length === 0) return null
    const selected = pick.filePaths[0]
    const stat = await fs.stat(selected)
    if (stat.isDirectory()) {
      registerRoot(selected)
      return { rootPath: selected, name: path.basename(selected) }
    }

    const dest = await dialog.showOpenDialog({
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
    if (packing) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
    const buf = await fs.readFile(selected)
    let files: number
    try {
      ;({ files } = await importModBuffer(buf, destRoot))
    } catch (err) {
      // 解压中途失败：清理半成品目录（不留残留），再抛给渲染层提示
      await fs.rm(destRoot, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    registerRoot(destRoot)
    // 登记为「本次会话导入创建」：用户取消确认时可由 mod:discardImport 清理
    importedDirs.add(normalizePath(destRoot))
    return { rootPath: destRoot, name: path.basename(destRoot), files }
  })

  // 撤销导入：用户对「未保存编辑确认」点取消后，清理刚解压但未使用的目录（不留半导入残留）。
  // 只接受本会话 mod:import 刚创建的目录（importedDirs 登记），删除后从信任锚移除。
  const importedDirs = new Set<string>()
  ipcMain.handle('mod:discardImport', async (_event, rootPath: string) => {
    const norm = normalizePath(rootPath)
    if (!importedDirs.has(norm)) return { ok: false } // 不是本次会话导入的：不动
    await fs.rm(rootPath, { recursive: true, force: true }).catch(() => undefined)
    allowedRoots.delete(norm)
    void store.set(PROJECT_ROOTS_KEY, [...allowedRoots])
    importedDirs.delete(norm)
    return { ok: true }
  })

  ipcMain.handle('image:readAsDataUrl', async (_event, rootPath: string, imagePath: string) => {
    return readMediaAsDataUrl(rootPath, imagePath, IMAGE_MIME)
  })

  // M8 游戏集成：检测铁锈战争安装目录、导入官方单位示例、导入游戏内已装模组。
  // 游戏目录只读；导入目标目录必须是已登记信任锚（dialog:openFolder 选择即登记）
  ipcMain.handle('game:detect', async (_event, configuredPath?: string) => {
    return detectGameDir(typeof configuredPath === 'string' && configuredPath ? configuredPath : undefined)
  })

  ipcMain.handle('game:importSample', async (_event, gamePath: string, targetRoot: string, opts: { title?: string; description?: string } | null) => {
    if (typeof targetRoot !== 'string' || !allowedRoots.has(normalizePath(targetRoot))) {
      throw new Error('目标目录未登记，请重新选择文件夹')
    }
    const detected = await detectGameDir(typeof gamePath === 'string' ? gamePath : undefined)
    if (!detected.found || !detected.gamePath) throw new Error('未找到铁锈战争安装目录，请先在设置中配置游戏目录')
    if (packing) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
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
    registerRoot(targetRoot)
    return { rootPath: targetRoot, ...result }
  })

  ipcMain.handle('game:importMod', async (_event, gamePath: string, fileName: string, targetRoot: string) => {
    if (typeof targetRoot !== 'string' || !allowedRoots.has(normalizePath(targetRoot))) {
      throw new Error('目标目录未登记，请重新选择文件夹')
    }
    const detected = await detectGameDir(typeof gamePath === 'string' ? gamePath : undefined)
    if (!detected.found || !detected.gamePath) throw new Error('未找到铁锈战争安装目录，请先在设置中配置游戏目录')
    // 文件名白名单：只接受 mods/units 下实际存在的 .rwmod（防路径穿越）
    if (typeof fileName !== 'string' || fileName !== path.basename(fileName) || !detected.mods.includes(fileName)) {
      throw new Error('无效的模组包文件名')
    }
    if (packing) throw new Error('已有打包/优化任务正在进行，请稍候再导入')
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
    registerRoot(destRoot)
    // 登记为「本次会话创建」：语义与 mod:import 一致（只针对本次创建的目录）
    importedDirs.add(normalizePath(destRoot))
    return { rootPath: destRoot, files }
  })

  // M12 试玩联动：启动游戏 / 打开目录 / 运行前检查。
  // 安全：launchGame 只接受通过 looksLikeGameDir 校验的目录；openDir 只接受
  // 已登记的项目根（打开任意目录无写风险，但保持「限制项目根」的一致性）
  ipcMain.handle('game:launch', async (_event, gamePath: unknown) => {
    if (typeof gamePath !== 'string' || !gamePath) return { ok: false, message: '请先在设置中配置游戏安装目录' }
    return launchGame(gamePath)
  })

  ipcMain.handle('game:openDir', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) return { ok: false, message: '目录为空' }
    const normalized = normalizePath(rootPath)
    if (!allowedRoots.has(normalized)) return { ok: false, message: '目录未登记，无法打开' }
    return openDir(normalized)
  })

  ipcMain.handle('game:preflight', async (_event, rootPath: unknown) => {
    if (typeof rootPath !== 'string' || !rootPath) return { ok: false, issues: [{ severity: 'error' as const, message: '项目目录为空' }] }
    const normalized = normalizePath(rootPath)
    if (!allowedRoots.has(normalized)) return { ok: false, issues: [{ severity: 'error' as const, message: '项目目录未登记，无法检查' }] }
    return preflightCheck(normalized)
  })

  // M22 单位预览：读游戏资产图片（CORE:/ROOT: 官方贴图；gamePath 需通过游戏目录校验）
  ipcMain.handle('game:readAssetImage', async (_event, gamePath: unknown, relPath: unknown) => {
    if (typeof gamePath !== 'string' || typeof relPath !== 'string') throw new Error('参数错误')
    return readGameAssetImage(gamePath, relPath)
  })

  // M6.5 音频预览：与图片同一套安全校验（限项目内 + 白名单 + 大小上限）
  ipcMain.handle('media:readAsDataUrl', async (_event, rootPath: string, mediaPath: string) => {
    return readMediaAsDataUrl(rootPath, mediaPath, AUDIO_MIME)
  })

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }))

  // 渲染层完成退出前落盘后的确认：
  // - before-quit 路径：resolve 等待（before-quit 流程随后 flush + quit）
  // - 窗口 close 路径：销毁窗口进入正常退出流程
  ipcMain.handle('app:flush-done', () => {
    if (flushResolve) {
      if (flushConfirmTimer) clearTimeout(flushConfirmTimer)
      const r = flushResolve
      flushResolve = null
      r()
      return true
    }
    if (closeFlushTimer) {
      clearTimeout(closeFlushTimer)
      closeFlushTimer = null
    }
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) win.destroy()
    return true
  })

  // ===== M6 自动更新（更新包托管在 GitHub Releases）=====
  // 事件统一推送到 'app:update' 通道；dev 模式下检查会返回提示
  setupUpdater(() => BrowserWindow.getAllWindows()[0]?.webContents ?? null)
  ipcMain.handle('app:checkUpdate', async () => {
    if (!isPackaged()) {
      return { skipped: true, message: '开发模式不检查更新' }
    }
    await checkForUpdates()
    return { skipped: false }
  })
  ipcMain.handle('app:downloadUpdate', async () => {
    if (!isPackaged()) return { skipped: true }
    await downloadUpdate()
    return { skipped: false }
  })
  ipcMain.handle('app:installUpdate', async () => {
    // L3：退出流程已在进行（双击「重启并安装」）时忽略，避免截断在途的落盘写入
    if (quitting) return false
    // 安装=下载并执行新代码：渲染层被 XSS 后可静默触发 IPC，这里由主进程
    // 弹系统确认框（对话框不可被渲染层伪造），用户点「重启并安装」才执行
    const { response } = await dialog.showMessageBox({
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
    quitAndInstall()
    return true
  })

  ipcMain.handle('avatar:chooseLocal', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择头像图片',
      filters: [{ name: '头像图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const p = result.filePaths[0]
    // 登记为允许读取的媒体（readMediaAsDataUrl 空 rootPath 分支只认这个集合）
    addAllowedMedia(p)
    return p
  })
  // 头像裁切（M8）：渲染端 canvas 生成 PNG data URL → 写入 userData/avatar.png 并登记
  // （固定文件名覆盖式：同一用户的头像始终是这一个文件，重启后从设置自动恢复登记）
  ipcMain.handle('avatar:saveCropped', async (_event, dataUrl: string) => {
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
    const file = path.join(app.getPath('userData'), 'avatar.png')
    await fs.writeFile(file, buf)
    addAllowedMedia(file)
    return file
  })
  ipcMain.handle('avatar:uploadCommunity', () => ({ ok: false, message: '社区头像服务即将上线' }))

  // ===== AI 服务（M4）=====
  ipcMain.handle('ai:check', async (_event, settings: AiSettings) => {
    if (settings.provider === 'deepseek') {
      return checkDeepSeek({ apiKey: settings.deepseekApiKey, model: settings.deepseekModel })
    }
    if (settings.provider === 'community') {
      return checkCommunity({ endpoint: settings.communityEndpoint, token: settings.communityToken })
    }
    return { ok: false, message: '未知的 AI 提供者' }
  })

  ipcMain.handle('ai:info', async () => {
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
  let pendingApproval: { id: string; resolve: (response: import('../src/types/ai').AiApprovalResponse) => void } | null = null
  // M4：主进程侧 AI 流互斥（渲染层锁之外的第二道防线，防止并发流审批串号/工具根串项目）
  let aiStreamActive = false
  // 当前活动流的取消标志（abort 只置当前流的标志；新流持有自己的标志，互不复位）。
  // abort 字段：AbortController 联动（ai.ts 挂载），置位时硬停止在途模型请求
  let activeCancel: { current: boolean; abort?: () => void } | null = null
  ipcMain.handle('ai:approval:respond', (_event, response: import('../src/types/ai').AiApprovalResponse) => {
    // L6：只接受「当前待审批请求」的响应；过期弹窗/旧请求的响应一律忽略。
    // 返回是否被接受——渲染层据此提示「审批已过期」，避免 120s 边缘点击被静默忽略
    if (pendingApproval && response && typeof response.id === 'string' && response.id === pendingApproval.id) {
      pendingApproval.resolve(response)
      pendingApproval = null
      return true
    }
    return false
  })

  // 渲染层看门狗触发后中止当前流：置流级取消标志（旧流事件静默 + 工具调用全拒 +
  // AbortController 硬停止在途模型请求），拒绝在途审批、释放 AI 锁
  ipcMain.handle('ai:stream:abort', () => {
    if (!aiStreamActive || !activeCancel) return { aborted: false }
    activeCancel.current = true
    activeCancel.abort?.() // 硬停止：中断在途模型请求（停止计费）
    activeCancel = null
    if (pendingApproval) {
      pendingApproval.resolve({ id: pendingApproval.id, approved: false })
      pendingApproval = null
    }
    aiStreamActive = false
    return { aborted: true }
  })

  // AI 修改历史（任务 2）：快照在 writeFile 工具内记录（rustAgentTools），
  // 这里的两个通道只做「列出 / 恢复」。安全边界与 fs 通道一致：
  // rootPath 必须已登记，relPath 必须相对且解析后在项目根内。
  function requireHistoryRelPath(rootPath: unknown, relPath: unknown): { root: string; rel: string } {
    if (typeof rootPath !== 'string' || typeof relPath !== 'string' || !relPath) {
      throw new Error('无效的参数')
    }
    // 与 writeFile 工具 resolveInside 对齐：剥前导斜杠（AI 可能用 /units/a.txt 写法；
    // win32 上 path.isAbsolute('/units/a.txt') === true，不剥会误拒）
    const rel = relPath.replace(/^\/+/, '')
    if (!rel || path.isAbsolute(rel) || rel.includes('..')) {
      throw new Error('无效的文件路径')
    }
    requireInsideRoot(rootPath, path.join(rootPath, rel))
    return { root: rootPath, rel }
  }

  ipcMain.handle('ai:history:list', async (_event, rootPath: unknown, relPath: unknown) => {
    const { root, rel } = requireHistoryRelPath(rootPath, relPath)
    return getHistory().listHistory(root, rel)
  })

  ipcMain.handle('ai:history:restore', async (_event, rootPath: unknown, relPath: unknown, snapshotId: unknown) => {
    const { root, rel } = requireHistoryRelPath(rootPath, relPath)
    if (typeof snapshotId !== 'string' || !snapshotId) {
      return { ok: false, message: '无效的历史版本' }
    }
    const entry = await getHistory().getEntry(root, rel, snapshotId)
    if (!entry) {
      return { ok: false, message: '历史版本不存在或已被清理（超过保留上限）' }
    }
    const abs = path.join(root, rel)
    await requireRealInsideRoot(root, abs)
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

  ipcMain.handle('ai:stream', async (event, params: AiChatParams, settings: AiSettings, projectRoot: unknown) => {
    if (aiStreamActive) throw new Error('已有 AI 请求正在处理，请稍候再试')
    aiStreamActive = true
    // 每次流独立的取消标志：abort 只影响本流，新流不受旧流状态影响
    const cancelled: { current: boolean; abort?: () => void } = { current: false }
    activeCancel = cancelled
    // 主进程总时长兜底（15 分钟）：渲染层看门狗是 5 分钟无事件；若渲染层崩溃/关闭，
    // 旧流会永远占着 AI 锁——此处强制置取消 + 释放锁（工具全拒、事件静默，无副作用）
    const hardKill = setTimeout(() => {
      if (activeCancel !== cancelled) return // 已被 abort/结束：跳过
      cancelled.current = true
      cancelled.abort?.() // 硬停止在途模型请求
      activeCancel = null
      if (pendingApproval) {
        pendingApproval.resolve({ id: pendingApproval.id, approved: false })
        pendingApproval = null
      }
      aiStreamActive = false
    }, 15 * 60 * 1000)
    try {
      const webContents = event.sender
      // 固定通道：单窗口应用，事件只推给发起请求的窗口
      const channel = 'ai:stream'
      // 项目根由渲染进程显式传入（持久化是防抖 300ms 写入，主进程读 store 可能拿到旧项目）。
      // 路径不可信，但只能指向用户打开过并已登记的项目。
      if (typeof projectRoot !== 'string' || !allowedRoots.has(normalizePath(projectRoot))) {
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
          webContents as unknown as import('electron').WebContents,
          channel,
          params,
          { apiKey: settings.deepseekApiKey, model: settings.deepseekModel },
          projectRoot,
          (id, resolve) => {
            // beforeToolCall 提供请求 id 与 resolve；approval:respond 按 id 匹配。
            // 本流已取消：新到的审批请求直接拒绝，不挂 UI
            if (cancelled.current) {
              resolve({ id, approved: false })
              return
            }
            pendingApproval = { id, resolve }
          },
          cancelled,
        )
      } else {
        // 流已取消则不发送（与 emit 静默一致，防旧流 error 命中新流监听器）
        if (!cancelled.current && !webContents.isDestroyed()) webContents.send(channel, { type: 'error', message: '社区 AI 服务即将上线' })
      }
      return channel
    } finally {
      clearTimeout(hardKill) // 流结束：取消强杀计时器
      // 所有权判断：只有本流仍是「当前活动流」时才清理全局状态——
      // abort 后用户已启动新流时，旧流的 finally 不能踩踏新流的审批/锁
      if (activeCancel === cancelled) {
        activeCancel = null
        aiStreamActive = false
        pendingApproval = null
      }
    }
  })
}

app.whenReady().then(async () => {
  registerIpc()
  // 等本地存储加载完成：恢复持久化的信任锚（媒体允许集合/项目根集合），
  // 再登记已保存的背景图/头像路径
  await store.ready()
  restoreMediaAllowlist()
  restoreProjectRoots()
  registerMediaFromSettings(store.get('settings'))
  createWindow()

  // M6：生产环境启动后延迟自动检查一次更新（静默，有新版本只在界面提示）
  if (isPackaged()) {
    setTimeout(() => {
      void checkForUpdates().catch(() => undefined)
    }, 5000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// L-3：退出前把防抖窗口内的最后写入落盘。
// 两条退出路径都覆盖渲染层落盘：
// ① 窗口关闭（close 事件确认链）；② before-quit（app.quit/更新安装，本 handler）。
// 加 2 秒超时兜底：极端 IO 挂起时不能卡死退出（否则更新安装器会一直等旧进程退出）。
let quitting = false
let flushResolve: (() => void) | null = null
let flushConfirmTimer: ReturnType<typeof setTimeout> | null = null
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  const win = BrowserWindow.getAllWindows()[0]
  const hasRenderer = !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
  let confirmed = Promise.resolve()
  if (hasRenderer) {
    // 通知渲染层同步落盘（覆盖 before-quit 路径：更新安装/系统退出时的最后写入）
    win.webContents.send('app:before-close')
    confirmed = new Promise<void>((resolve) => {
      flushResolve = resolve
      flushConfirmTimer = setTimeout(() => {
        flushResolve = null
        resolve()
      }, 2000)
    })
  }
  // M1：store.flush 也带 2s 超时兜底（网络盘/杀软锁盘时 fs 写入可能长时间阻塞，
  // 无兜底会永久卡住退出——应用无窗口、进程残留）。AI 修改历史同链 flush
  const flushWithTimeout = Promise.race([
    Promise.allSettled([store.flush(), getHistory().flush()]),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ])
  void confirmed.then(() => flushWithTimeout).then(() => app.quit())
})
