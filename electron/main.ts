/**
 * Electron 主进程入口：窗口创建 + 生命周期 + 组装 IPC 上下文。
 * 全部 IPC 通道在 electron/ipc.ts 按域注册（本文件不直接注册任何通道），
 * 真实能力（dialog/shell/app/updater/窗口）在此注入 IpcContext。
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import path from 'node:path'
import { createStore } from './store'
import { getHistory, initAiHistory } from './aiHistory'
import { createKnowledgePack } from './knowledgePack'
import { checkForUpdates, downloadUpdate, isPackaged, quitAndInstall, setupUpdater } from './updater'
import { createIpcContext, registerIpc, registerMediaFromSettings, restoreMediaAllowlist, restoreProjectRoots } from './ipc'

const devUrl = process.env.VITE_DEV_SERVER_URL

const store = createStore(path.join(app.getPath('userData'), 'app-state.json'))
// AI 修改历史（任务 2）：独立 JSON 文件，避免与主 store 共用导致每次设置变更重写大文件
initAiHistory(path.join(app.getPath('userData'), 'ai-history.json'))
// M18 知识包更新器：可更新数据放 userData/knowledge-pack，内置数据回退 public/data
const knowledgePack = createKnowledgePack(
  path.join(app.getPath('userData'), 'knowledge-pack'),
  path.join(__dirname, '..', '..', 'public', 'data'),
)

/** 全部 IPC 通道共享的依赖与可变状态（见 ipc.ts 的 IpcContext） */
const ctx = createIpcContext({
  store,
  knowledgePack,
  dialog,
  shell,
  app,
  updater: { checkForUpdates, downloadUpdate, quitAndInstall, isPackaged },
  windows: { getAllWindows: () => BrowserWindow.getAllWindows() },
})

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
    if (ctx.lifecycle.quitting) return
    event.preventDefault()
    if (!win.webContents.isDestroyed()) win.webContents.send('app:before-close')
    if (ctx.lifecycle.closeFlushTimer) clearTimeout(ctx.lifecycle.closeFlushTimer)
    ctx.lifecycle.closeFlushTimer = setTimeout(() => win.destroy(), 1000)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'))
  }
  return win
}

app.whenReady().then(async () => {
  // 注册全部 IPC 通道（ipcMain.handle 的监听器首参是事件对象，与 RegisterHandler 契约一致）
  registerIpc(ctx, (channel, handler) => ipcMain.handle(channel, handler as never))
  // 等本地存储加载完成：恢复持久化的信任锚（媒体允许集合/项目根集合），
  // 再登记已保存的背景图/头像路径
  await store.ready()
  restoreMediaAllowlist(ctx)
  restoreProjectRoots(ctx)
  registerMediaFromSettings(ctx, store.get('settings'))
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

// M6 自动更新事件推送（事件统一推送到 'app:update' 通道）
setupUpdater(() => BrowserWindow.getAllWindows()[0]?.webContents ?? null)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// L-3：退出前把防抖窗口内的最后写入落盘。
// 两条退出路径都覆盖渲染层落盘：
// ① 窗口关闭（close 事件确认链）；② before-quit（app.quit/更新安装，本 handler）。
// 加 2 秒超时兜底：极端 IO 挂起时不能卡死退出（否则更新安装器会一直等旧进程退出）。
app.on('before-quit', (event) => {
  if (ctx.lifecycle.quitting) return
  event.preventDefault()
  ctx.lifecycle.quitting = true
  const win = BrowserWindow.getAllWindows()[0]
  const hasRenderer = !!win && !win.isDestroyed() && !win.webContents.isDestroyed()
  let confirmed = Promise.resolve()
  if (hasRenderer) {
    // 通知渲染层同步落盘（覆盖 before-quit 路径：更新安装/系统退出时的最后写入）
    win.webContents.send('app:before-close')
    confirmed = new Promise<void>((resolve) => {
      ctx.lifecycle.flushResolve = resolve
      ctx.lifecycle.flushConfirmTimer = setTimeout(() => {
        ctx.lifecycle.flushResolve = null
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
