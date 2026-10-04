/**
 * 组件测试用的内存桥夹具（仅测试，不进产物）。
 *
 * 手机端的问题大多出在「页面交互编排」而不是纯函数：未保存保护、保存失败、
 * 外部修改冲突、删文件、点图片。这些必须挂载真实组件、点真实按钮才能验证。
 * 夹具提供一个内存文件系统 + 内存 store，把 Tauri 通道替换掉。
 */
import type { BridgeApi, DirEntry } from '../../src/types/bridge'

export interface MemoryBridgeOptions {
  /** 初始文本文件：绝对路径 → 内容 */
  files?: Record<string, string>
  /** 初始二进制文件：绝对路径 → 字节 */
  binaries?: Record<string, Uint8Array>
  /** 显式存在的空目录 */
  dirs?: string[]
  /** 初始全局存储 */
  store?: Record<string, unknown>
}

export interface MemoryBridgeHandle {
  bridge: BridgeApi
  /** 读内存里的文件内容（断言写盘结果用） */
  readText(path: string): string | undefined
  /** 磁盘上是否存在该路径 */
  has(path: string): boolean
  /** 让下一次 writeFile 失败（测保存失败路径） */
  failNextWrite(message?: string): void
  /** 模拟外部改动：改内容并推进修改时间 */
  externalEdit(path: string, content: string): void
  /** 记录每次写盘的路径与内容 */
  writes: Array<{ path: string; content: string }>
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : '/'
}

export function createMemoryBridge(options: MemoryBridgeOptions = {}): MemoryBridgeHandle {
  const files = new Map<string, string>(Object.entries(options.files ?? {}))
  const binaries = new Map<string, Uint8Array>(Object.entries(options.binaries ?? {}))
  const dirs = new Set<string>(options.dirs ?? [])
  const storeData = new Map<string, unknown>(Object.entries(options.store ?? {}))
  const mtime = new Map<string, number>()
  const writes: Array<{ path: string; content: string }> = []
  let clock = 1000
  let nextWriteError: string | null = null

  // 已知路径的父目录链都算作目录
  const ensureParents = (path: string) => {
    let dir = parentOf(path)
    while (dir && dir !== '/' && !dirs.has(dir)) {
      dirs.add(dir)
      dir = parentOf(dir)
    }
  }
  for (const p of [...files.keys(), ...binaries.keys()]) {
    ensureParents(p)
    mtime.set(p, (clock += 1))
  }

  const exists = (path: string): boolean => files.has(path) || binaries.has(path) || dirs.has(path)

  const allPaths = (): string[] => [...files.keys(), ...binaries.keys(), ...dirs]

  const assertInside = (rootPath: string, target: string): void => {
    if (!target.startsWith(rootPath)) throw new Error('路径超出项目目录范围')
  }

  const bridge = {
    platform: 'test',
    version: '0.0.0-test',
    async appInfo() {
      return { version: '0.0.0-test', platform: 'test' }
    },
    app: {
      async checkUpdate() {
        return { skipped: true }
      },
      async downloadUpdate() {
        return { skipped: true }
      },
      async installUpdate() {
        return false
      },
      onUpdateEvent() {
        return () => {}
      },
      onBeforeClose() {
        return () => {}
      },
      async confirmClose() {
        return true
      },
    },
    store: {
      async get(key: string) {
        return storeData.get(key) ?? null
      },
      async set(key: string, value: unknown) {
        storeData.set(key, value)
      },
    },
    project: {
      async openFolderDialog() {
        return null
      },
      async openImageDialog() {
        return null
      },
      async saveText() {
        return { ok: true }
      },
      async registerRoots() {},
      async readDir(rootPath: string, dirPath: string, showHidden = false): Promise<DirEntry[]> {
        assertInside(rootPath, dirPath)
        const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`
        const out = new Map<string, DirEntry>()
        const directChildren = (path: string): string | null => {
          if (!path.startsWith(prefix)) return null
          const rest = path.slice(prefix.length)
          if (!rest || rest.includes('/')) return null
          return rest
        }
        for (const path of allPaths()) {
          const name = directChildren(path)
          if (!name) continue
          if (!showHidden && name.startsWith('.')) continue
          const isDirectory = dirs.has(path) && !files.has(path) && !binaries.has(path)
          out.set(name, {
            name,
            path,
            isDirectory,
            size: files.get(path)?.length ?? binaries.get(path)?.byteLength ?? 0,
            mtimeMs: mtime.get(path) ?? 0,
          })
        }
        return [...out.values()].sort((a, b) =>
          a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
        )
      },
      async stat(rootPath: string, filePath: string) {
        assertInside(rootPath, filePath)
        const content = files.get(filePath)
        if (content === undefined && !binaries.has(filePath)) throw new Error(`文件不存在：${filePath}`)
        return { mtimeMs: mtime.get(filePath) ?? 0, size: content?.length ?? binaries.get(filePath)?.byteLength ?? 0 }
      },
      async readFile(rootPath: string, filePath: string) {
        assertInside(rootPath, filePath)
        const content = files.get(filePath)
        if (content === undefined) throw new Error(`文件不存在：${filePath}`)
        return { content, hasBom: false, mtimeMs: mtime.get(filePath) ?? 0, size: content.length }
      },
      async writeFile(rootPath: string, filePath: string, content: string) {
        assertInside(rootPath, filePath)
        if (nextWriteError) {
          const message = nextWriteError
          nextWriteError = null
          throw new Error(message)
        }
        writes.push({ path: filePath, content })
        files.set(filePath, content)
        ensureParents(filePath)
        mtime.set(filePath, (clock += 1))
      },
      async createFile(rootPath: string, dirPath: string, name: string) {
        assertInside(rootPath, dirPath)
        const target = `${dirPath}/${name}`
        if (exists(target)) throw new Error(`已存在同名文件：${name}`)
        files.set(target, '')
        mtime.set(target, (clock += 1))
      },
      async createFolder(rootPath: string, dirPath: string, name: string) {
        assertInside(rootPath, dirPath)
        if (!name.trim()) {
          dirs.add(dirPath)
          return
        }
        dirs.add(`${dirPath}/${name.trim()}`)
      },
      async rename(rootPath: string, oldPath: string, newPath: string) {
        assertInside(rootPath, oldPath)
        assertInside(rootPath, newPath)
        if (files.has(oldPath)) {
          const content = files.get(oldPath) as string
          files.delete(oldPath)
          files.set(newPath, content)
        }
        if (dirs.has(oldPath)) {
          dirs.delete(oldPath)
          dirs.add(newPath)
          for (const path of [...files.keys(), ...dirs]) {
            if (path.startsWith(`${oldPath}/`)) {
              const moved = `${newPath}${path.slice(oldPath.length)}`
              if (files.has(path)) {
                const content = files.get(path) as string
                files.delete(path)
                files.set(moved, content)
              }
              if (dirs.has(path)) {
                dirs.delete(path)
                dirs.add(moved)
              }
            }
          }
        }
      },
      async delete(rootPath: string, targetPath: string) {
        assertInside(rootPath, targetPath)
        if (targetPath.replace(/\/+$/, '') === rootPath.replace(/\/+$/, '')) throw new Error('不能在文件操作中删除项目根目录')
        files.delete(targetPath)
        binaries.delete(targetPath)
        dirs.delete(targetPath)
        for (const path of [...files.keys(), ...binaries.keys(), ...dirs]) {
          if (path.startsWith(`${targetPath}/`)) {
            files.delete(path)
            binaries.delete(path)
            dirs.delete(path)
          }
        }
      },
      async readImageAsDataUrl(rootPath: string, imagePath: string) {
        assertInside(rootPath, imagePath)
        if (!binaries.has(imagePath)) throw new Error(`图片不存在：${imagePath}`)
        // 1x1 PNG，组件只关心能否渲染出 data URL 与尺寸信息
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
      },
      async readAudioAsDataUrl(rootPath: string, audioPath: string) {
        assertInside(rootPath, audioPath)
        return 'data:audio/ogg;base64,AA=='
      },
    },
    avatar: {
      async chooseLocal() {
        return null
      },
      async saveCropped() {
        return ''
      },
      async uploadCommunity() {
        return { ok: false as const, message: '测试环境不提供社区能力' }
      },
    },
    mod: {
      async create() {
        return { files: [] }
      },
      async chooseMusic() {
        return []
      },
      async import() {
        return null
      },
      async discardImport() {
        return { ok: true }
      },
      async createUnit(rootPath: string, params: { name: string; folder?: string }) {
        const folder = (params.folder ?? '').replace(/^\/+|\/+$/g, '')
        const rel = folder ? `${folder}/${params.name}/${params.name}.ini` : `${params.name}/${params.name}.ini`
        files.set(`${rootPath}/${rel}`, `[core]\nname: ${params.name}\n`)
        return { path: rel }
      },
      async pack() {
        return { canceled: false as const, filePath: '/export/mod.rwmod', size: 2048, files: 3 }
      },
      async check() {
        return { issues: [], unitCount: 0, fileCount: 0 }
      },
      async readModInfo(rootPath: string) {
        const raw = files.get(`${rootPath}/mod-info.txt`)
        if (raw === undefined) return null
        const get = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'im').exec(raw)?.[1]?.trim()
        return {
          title: get('title') ?? '',
          description: get('description'),
          author: get('author'),
          version: get('version'),
          musicFiles: [],
          musicExclusive: false,
          mapsFiles: [],
          mapsExtra: false,
        }
      },
      async writeModInfo(rootPath: string, data: { title: string }) {
        files.set(`${rootPath}/mod-info.txt`, `[mod]\ntitle: ${data.title}\n`)
        writes.push({ path: `${rootPath}/mod-info.txt`, content: `[mod]\ntitle: ${data.title}\n` })
        return { ok: true }
      },
      async scanResources() {
        return { files: [], unitNames: [] }
      },
      async scanUnits() {
        return []
      },
      async optimizeScan() {
        return []
      },
      async optimizeApply() {
        return { done: 0, failed: 0 }
      },
      async globalOp() {
        return { files: 0, changed: 0, skipped: 0 }
      },
      async listTemplates() {
        return []
      },
      async saveFileAsTemplate() {
        return { key: 't' }
      },
      async importTemplate() {
        return null
      },
      async deleteUserTemplate() {
        return { ok: true }
      },
      async listUserTemplateKeys() {
        return []
      },
      async createUnitFromTemplate() {
        return { path: 'units/new/new.ini' }
      },
    },
    game: {
      async detect() {
        return { found: false, gamePath: null, units: [], mods: [] }
      },
      async importSample() {
        return { rootPath: '', units: 0, files: 0 }
      },
      async importMod() {
        return { rootPath: '', files: 0 }
      },
      async launch() {
        return { ok: false, message: '测试环境不支持' }
      },
      async openDir() {
        return { ok: false, message: '测试环境不支持' }
      },
      async preflight() {
        return { ok: true, issues: [] }
      },
      async readAssetImage() {
        return ''
      },
    },
    git: {
      async info() {
        return { available: false, isRepo: false, branch: '', ahead: 0, behind: 0, changedCount: 0, branches: [] }
      },
      async log() {
        return []
      },
      async status() {
        return []
      },
      async conflicts() {
        return []
      },
      async diff() {
        return ''
      },
      async restore() {
        return { ok: false }
      },
    },
  } as unknown as BridgeApi

  return {
    bridge,
    writes,
    readText: (path: string) => files.get(path),
    has: (path: string) => exists(path),
    failNextWrite: (message = '磁盘写入失败（测试注入）') => {
      nextWriteError = message
    },
    externalEdit: (path: string, content: string) => {
      files.set(path, content)
      mtime.set(path, (clock += 1000))
    },
  }
}
