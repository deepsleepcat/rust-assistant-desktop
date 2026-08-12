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
import { isPathInside, normalizePath } from './paths'
import { checkCommunity, checkDeepSeek, communityInfo, streamAgent } from './ai'
import type { AiChatParams, AiSettings } from '../src/types/ai'

const devUrl = process.env.VITE_DEV_SERVER_URL

/** 已登记允许操作的项目根目录（规范化后的绝对路径） */
const allowedRoots = new Set<string>()

function registerRoot(root: string): void {
  allowedRoots.add(normalizePath(root))
}

function requireInsideRoot(rootPath: string, targetPath: string): void {
  if (!allowedRoots.has(normalizePath(rootPath))) {
    throw new Error('未登记的项目目录，拒绝访问')
  }
  if (!isPathInside(rootPath, targetPath)) {
    throw new Error('目标路径超出项目目录范围，拒绝访问')
  }
}

const store = createStore(path.join(app.getPath('userData'), 'app-state.json'))

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: '铁锈助手',
    backgroundColor: '#f6f7f9',
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

  // 阻止页面跳转到外部地址，防止被导航劫持
  win.webContents.on('will-navigate', (event, url) => {
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
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
  ipcMain.handle('store:get', (_event, key: string) => store.get(key))
  ipcMain.handle('store:set', (_event, key: string, value: unknown) => {
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
    return result.filePaths[0]
  })

  ipcMain.handle('project:registerRoots', (_event, roots: string[]) => {
    for (const root of roots) {
      if (typeof root === 'string' && root.length > 0) registerRoot(root)
    }
  })

  ipcMain.handle('fs:readDir', async (_event, rootPath: string, dirPath: string) => {
    requireInsideRoot(rootPath, dirPath)
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    const out = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dirPath, entry.name)
        let size = 0
        let mtimeMs = 0
        try {
          const stat = await fs.stat(full)
          size = stat.size
          mtimeMs = stat.mtimeMs
        } catch {
          // 无权限等场景：尽力读取目录信息即可
        }
        return { name: entry.name, path: full, isDirectory: entry.isDirectory(), size, mtimeMs }
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
    requireInsideRoot(rootPath, filePath)
    const buf = await fs.readFile(filePath)
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    const content = hasBom ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
    const stat = await fs.stat(filePath)
    return { content, hasBom, mtimeMs: stat.mtimeMs, size: stat.size }
  })

  ipcMain.handle('fs:writeFile', async (_event, rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }) => {
    requireInsideRoot(rootPath, filePath)
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

  ipcMain.handle('fs:createFile', async (_event, rootPath: string, dirPath: string, name: string) => {
    requireInsideRoot(rootPath, dirPath)
    await fs.writeFile(path.join(dirPath, name), '', 'utf8')
  })

  ipcMain.handle('fs:createFolder', async (_event, rootPath: string, dirPath: string, name: string) => {
    requireInsideRoot(rootPath, dirPath)
    await fs.mkdir(path.join(dirPath, name), { recursive: false })
  })

  ipcMain.handle('fs:rename', async (_event, rootPath: string, oldPath: string, newPath: string) => {
    requireInsideRoot(rootPath, oldPath)
    requireInsideRoot(rootPath, newPath)
    await fs.rename(oldPath, newPath)
  })

  ipcMain.handle('fs:delete', async (_event, rootPath: string, targetPath: string) => {
    requireInsideRoot(rootPath, targetPath)
    // 优先移入系统回收站；回收站失败时不静默永久删除，直接报错
    await shell.trashItem(targetPath)
  })

  ipcMain.handle('image:readAsDataUrl', async (_event, rootPath: string, imagePath: string) => {
    // 项目资源必须限制在项目根目录；外观背景由用户通过系统选择器选取，允许空 rootPath。
    if (rootPath) requireInsideRoot(rootPath, imagePath)
    if (typeof imagePath !== 'string' || !path.isAbsolute(imagePath)) throw new Error('无效的图片路径')
    const ext = path.extname(imagePath).toLowerCase()
    const mimeByExt: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
    }
    const mime = mimeByExt[ext]
    if (!mime) throw new Error('不支持的图片格式')
    const stat = await fs.stat(imagePath)
    if (stat.size > 30 * 1024 * 1024) throw new Error('图片超过 30MB，暂不支持预览')
    const buf = await fs.readFile(imagePath)
    return `data:${mime};base64,${buf.toString('base64')}`
  })

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }))

  ipcMain.handle('avatar:chooseLocal', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: '选择头像图片',
      filters: [{ name: '头像图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
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

  // AI 审批：界面响应写文件请求（resolver 由 ai:stream 的 beforeToolCall 挂起等待）
  let pendingApproval: ((response: import('../src/types/ai').AiApprovalResponse) => void) | null = null
  ipcMain.handle('ai:approval:respond', (_event, response: import('../src/types/ai').AiApprovalResponse) => {
    if (pendingApproval) {
      pendingApproval(response)
      pendingApproval = null
    }
    return true
  })

  ipcMain.handle('ai:stream', async (event, params: AiChatParams, settings: AiSettings) => {
    const webContents = event.sender
    // 固定通道：单窗口应用，事件只推给发起请求的窗口
    const channel = 'ai:stream'
    const workspace = store.get('workspace') as { activeProjectId?: string; projects?: Array<{ id: string; rootPath: string }> } | null
    const activeProject = workspace?.projects?.find((p) => p.id === workspace.activeProjectId)
    if (settings.provider === 'deepseek') {
      await streamAgent(
        webContents as unknown as import('electron').WebContents,
        channel,
        params,
        { apiKey: settings.deepseekApiKey, model: settings.deepseekModel },
        activeProject?.rootPath ?? '',
        (resolve) => { pendingApproval = resolve },
      )
    } else {
      if (!webContents.isDestroyed()) webContents.send(channel, { type: 'error', message: '社区 AI 服务即将上线' })
    }
    return channel
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
