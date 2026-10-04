/**
 * 移动端桥服务（Tauri 版 BridgeApi）：
 * 实现桌面版 src/types/bridge.ts 契约中手机版 v1 需要的子集——
 * 文件系统走 tauri-plugin-fs（Android 应用私有目录 + SAF 对话框导入/导出），
 * 全局存储为 appDataDir 下的单个 JSON（临时文件 + rename 原子写，250ms 防抖）。
 *
 * 目录约定（v1 全部本地）：
 * - appData/projects/   项目（导入时从 SAF 拷贝进应用私有目录，项目内文件操作免权限）
 * - appData/templates/  用户模板
 * - appData/app-state.json  全局存储（workspace/settings/ai 设置）
 *
 * AI 对话（M5）走 Rust 命令 ai_stream（SSE 流式 → tauri 事件），此处留接口。
 */
import type {
  BridgeApi,
  DirEntry,
  StoreApi,
} from '../types/bridge'
import type { TemplateMeta } from '../types/mod'
import { appDataDir } from '@tauri-apps/api/path'
import {
  readDir as fsReadDir,
  readTextFile,
  writeTextFile,
  mkdir,
  remove,
  rename,
  stat,
  exists,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from '@tauri-apps/plugin-fs'
import { open, save } from '@tauri-apps/plugin-dialog'
import { basename, extname } from '../utils/paths'
import { isPathInsideRoot, validateEntryName } from '../utils/entryName'
import { updateModInfoText, type ModInfoUpdate } from '../features/modTools/modInfo'

const BOM = new Uint8Array([0xef, 0xbb, 0xbf])

/**
 * 项目内路径校验：所有文件通道入口都必须过这一关。
 * WebView 侧虽然只能访问应用私有目录，但 UI/工具传错路径（`..` 逃逸、
 * 拼错的绝对路径）会写到项目外，因此按项目根再收一道边界。
 */
function assertInsideProject(rootPath: string, targetPath: string): void {
  if (!isPathInsideRoot(rootPath, targetPath)) {
    throw new Error('路径超出项目目录范围')
  }
}

let basePromise: Promise<string> | null = null
export function appBaseDir(): Promise<string> {
  if (!basePromise) basePromise = appDataDir()
  return basePromise
}

/** 应用私有目录下的路径拼接（统一正斜杠） */
export async function appPath(...parts: string[]): Promise<string> {
  const base = await appBaseDir()
  return [base.replace(/\/+$/, ''), ...parts.map((p) => p.replace(/^\/+/, ''))].join('/')
}

function toDirEntry(e: { name: string; isDirectory: boolean; isFile?: boolean; size?: number; mtime?: Date | null }): DirEntry {
  return { name: e.name, path: '', isDirectory: e.isDirectory, size: e.size ?? 0, mtimeMs: e.mtime ? e.mtime.getTime() : 0 }
}

/** UTF-8 解码（含 BOM 检测） */
function decodeUtf8(bytes: Uint8Array): { content: string; hasBom: boolean } {
  const hasBom = bytes.length >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]
  const data = hasBom ? bytes.subarray(3) : bytes
  return { content: new TextDecoder('utf-8').decode(data), hasBom }
}

function encodeUtf8(text: string, hasBom: boolean): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  if (!hasBom) return bytes
  const out = new Uint8Array(bytes.length + 3)
  out.set(BOM, 0)
  out.set(bytes, 3)
  return out
}

/** 递归复制目录到目标（导入用：SAF 目录 → 应用私有目录） */
async function copyDirRecursive(src: string, dest: string): Promise<number> {
  await mkdir(dest, { recursive: true })
  const entries = await fsReadDir(src)
  let files = 0
  for (const e of entries) {
    const s = `${src}/${e.name}`
    const d = `${dest}/${e.name}`
    if (e.isDirectory) {
      files += await copyDirRecursive(s, d)
    } else {
      const bytes = await fsReadFile(s)
      await fsWriteFile(d, bytes)
      files++
    }
  }
  return files
}

/** 从 system 路径归一化项目根（SAF 返回的路径尾部可能带文件名） */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').trim()
  return cleaned || '未命名项目'
}

/**
 * 是否运行在 Tauri 宿主中（浏览器预览下文件通道不可用）。
 * getBridge() 内部用同一判定，这里提到模块级供导入等独立入口复用。
 */
function isTauriHost(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * 在 appData/projects 下取一个尚未占用的目录路径。
 * 导入 / 示例项目重名时自动追加序号，而不是覆盖别人的同名项目。
 */
export async function uniqueProjectDir(baseName: string): Promise<string> {
  const safe = sanitizeName(baseName)
  let candidate = safe
  for (let index = 1; index < 1000; index += 1) {
    const dir = await appPath('projects', candidate)
    if (!(await exists(dir))) return dir
    candidate = `${safe}${index + 1}`
  }
  return appPath('projects', `${safe}_${Date.now().toString(36)}`)
}

/**
 * 删除整个项目目录（仅项目页调用）。
 * 文件操作通道里的 project.delete 会拒绝删项目根，这里是唯一合法的整项目删除入口；
 * 因此必须自己守住边界——只允许删除 appData/projects 下的**子目录**。
 */
export async function deleteProject(rootPath: string): Promise<void> {
  const projectsDir = await appPath('projects')
  const target = rootPath.replace(/\/+$/, '')
  if (!isPathInsideRoot(projectsDir, target) || target === projectsDir.replace(/\/+$/, '')) {
    throw new Error('拒绝删除项目目录以外的路径')
  }
  await remove(target, { recursive: true })
}

/**
 * 写项目内二进制文件（示例项目的占位图片等）。
 * 文本内容一律走 project.writeFile（带 BOM 与编码处理），这里只用于字节流。
 */
export async function writeProjectBinary(rootPath: string, filePath: string, bytes: Uint8Array): Promise<void> {
  assertInsideProject(rootPath, filePath)
  await fsWriteFile(filePath, bytes)
}

export type ImportKind = 'auto' | 'archive' | 'folder'

export interface ImportResult {
  rootPath: string
  name: string
  /** 解压导入的文件数（目录导入不返回） */
  files?: number
}

/**
 * 导入模组（手机版扩展入口，不属于 BridgeApi 契约）。
 *
 * - `archive`：只接受 .rwmod / .zip，解压进应用私有目录；
 * - `folder`：只接受目录（SAF 目录树），整目录拷进应用私有目录；
 * - `auto`：不限类型（旧行为，供 mod.import() 复用）。
 *
 * 用户取消返回 null（不是错误）；失败时清理本次产生的不完整目录，绝不触碰源文件。
 */
export async function importMod(kind: ImportKind = 'auto'): Promise<ImportResult | null> {
  if (!isTauriHost()) return null
  const selected = await open(
    kind === 'folder' ? { multiple: false, directory: true } : { multiple: false },
  )
  if (!selected || typeof selected !== 'string') return null

  const isZipPath = /\.(rwmod|zip)$/i.test(selected)
  // Android 的 SAF 选择器未必遵守 filters，这里按扩展名再判一次
  if (kind === 'archive' && !isZipPath) throw new Error('请选择 .rwmod 或 .zip 模组包')
  if (kind === 'folder' && isZipPath) throw new Error('请选择模组文件夹，而不是压缩包')

  const rawName = isZipPath
    ? basename(selected).replace(/\.(rwmod|zip)$/i, '')
    : basename(selected.replace(/\/+$/, ''))
  const dest = await uniqueProjectDir(rawName || (isZipPath ? '导入模组' : '导入项目'))

  try {
    if (isZipPath) {
      const bytes = await fsReadFile(selected)
      const files = await extractZip(bytes, dest)
      return { rootPath: dest, name: basename(dest), files }
    }
    await copyDirRecursive(selected, dest)
    return { rootPath: dest, name: basename(dest) }
  } catch (err) {
    // 导入失败清理半成品目录，避免项目列表里留下打不开的脏项目
    await remove(dest, { recursive: true }).catch(() => {})
    throw err
  }
}

/** 内置模板列表（public/data/templates/*.json，fetch 打包资源）。
 * 注意：tauri asset 协议对不存在的文件返回 200 + 非 JSON 内容，因此
 * manifest 与单个模板的 json() 解析都必须容错（单个失败跳过，不中断整个列表）。 */
async function fetchBuiltinTemplates(): Promise<TemplateMeta[]> {
  const base = import.meta.env.BASE_URL || '/'
  let names: string[] = []
  try {
    const res = await fetch(`${base}data/templates/manifest.json`)
    const manifest = (await res.json()) as { templates?: string[] }
    names = manifest.templates ?? []
  } catch {
    // 无 manifest（404 伪装成 200）：走固定枚举
  }
  if (names.length === 0) {
    // 固定内置模板（文件名与 public/data/templates 实际一致）
    const known = [
      'base_bomber_template', 'base_builder_template', 'base_heavyBettership_template',
      'base_heavyDeep-template', 'base_tank_template',
      'building_Factory-template', 'building_Tower-template', 'building_Turret-template',
      'middle_antiNukeLaunch_template', 'middle_crystal_template',
      'middle_experimentalDropshipTemplate', 'middle_experimentalSpiderTemplate',
      'middle_experimentalTankTemplate', 'middle_nukelaucher_template',
      'normal_mmtank_template', 'resource_pool_template', 'empty',
    ]
    names.push(...known)
  }
  const { toTemplateMeta } = await import('../features/modTools/templates')
  const metas: TemplateMeta[] = []
  for (const name of names) {
    try {
      const r = await fetch(`${base}data/templates/${name}.json`)
      const raw = (await r.json()) as import('../features/modTools/templates').RawTemplate
      metas.push(toTemplateMeta(name, raw))
    } catch {
      // 单个模板缺失/损坏：跳过（其余模板不受影响）
    }
  }
  return metas
}

/** 全局存储：appData/app-state.json，原子写 + 防抖 */
function createStore(): StoreApi {
  let cache: Record<string, unknown> | null = null
  /** 首次读取共享同一个 Promise：并发 get/set 各自读一次会让后完成的那次覆盖前一次的写入 */
  let loading: Promise<Record<string, unknown>> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()

  async function load(): Promise<Record<string, unknown>> {
    if (cache) return cache
    if (!loading) {
      loading = (async () => {
        try {
          const file = await appPath('app-state.json')
          const raw = await readTextFile(file)
          return JSON.parse(raw) as Record<string, unknown>
        } catch {
          return {}
        }
      })()
    }
    const data = await loading
    cache = data
    return data
  }

  async function persist(): Promise<void> {
    const file = await appPath('app-state.json')
    const tmp = `${file}.tmp`
    const data = JSON.stringify(cache ?? {})
    await writeTextFile(tmp, data)
    await rename(tmp, file)
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      writing = writing.then(() => persist().catch((err) => console.warn('[store] 持久化失败', err)))
    }, 250)
  }

  return {
    async get(key) {
      const data = await load()
      return data[key]
    },
    async set(key, value) {
      const data = await load()
      data[key] = value
      schedule()
    },
  }
}

/** 打包时排除的垃圾文件/目录（按相对路径匹配，与桌面版 modTools 一致） */
const PACK_EXCLUDE_PATTERNS: string[] = [
  '.git', '.svn', '.hg', 'node_modules', 'dist', 'dist-electron', 'out', '.vite',
  'Thumbs.db', '.DS_Store', 'desktop.ini', '*.tmp', '*.ai-*.tmp',
]

/** 检查单个相对路径是否应被打包排除 */
export function isExcluded(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/).filter(Boolean)
  return parts.some((part) =>
    PACK_EXCLUDE_PATTERNS.some((pat) => pat === part || (pat.startsWith('*') && part.endsWith(pat.slice(1)))),
  )
}

/** 收集项目文件（相对路径 + 内容；跳过排除项与超限文件） */
async function collectPackFiles(rootPath: string): Promise<{ items: Array<{ path: string; data: ArrayBuffer }>; skipped: number }> {
  const items: Array<{ path: string; data: ArrayBuffer }> = []
  let skipped = 0
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop()!
    const abs = rel ? `${rootPath}/${rel}` : rootPath
    const entries = await fsReadDir(abs)
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (isExcluded(childRel)) {
        skipped++
        continue
      }
      if (e.isDirectory) {
        stack.push(childRel)
      } else {
        try {
          const data = await fsReadFile(abs ? `${abs}/${e.name}` : e.name)
          items.push({ path: childRel, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer })
        } catch {
          skipped++
        }
      }
    }
  }
  return { items, skipped }
}

/** 解压 .rwmod/zip 到目标目录（导入用） */
async function extractZip(bytes: Uint8Array, dest: string): Promise<number> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const entries = Object.values(zip.files).filter((f) => !f.dir)
  for (const entry of entries) {
    const outPath = `${dest}/${entry.name}`
    // 防 zip 路径穿越：拒绝绝对路径与 ..
    const normalized = entry.name.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) continue
    const content = await entry.async('uint8array')
    const dir = outPath.slice(0, outPath.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })
    await fsWriteFile(outPath, content)
  }
  return entries.length
}

function createMobileBridge(): BridgeApi {
  const store = createStore()
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  return {
    platform: tauri ? 'android' : 'web',
    version: '0.1.0',
    async appInfo() {
      return { version: '0.1.0', platform: tauri ? 'android' : 'web' }
    },
    app: {
      async checkUpdate() {
        return { skipped: true, message: '手机版第一版无自动更新' }
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
    store,
    project: {
      async openFolderDialog() {
        if (!tauri) return null
        const selected = await open({ directory: true, multiple: false })
        if (!selected || typeof selected !== 'string') return null
        const name = sanitizeName(basename(selected.replace(/\/+$/, '')) || '导入项目')
        // 拷贝进应用私有目录（v1 托管模式：项目文件全部在 appData/projects 下）
        const dest = await appPath('projects', name)
        const existsDest = await exists(dest)
        const finalDest = existsDest ? `${dest}_${Date.now().toString(36)}` : dest
        await copyDirRecursive(selected, finalDest)
        return { rootPath: finalDest, name: basename(finalDest) }
      },
      async openImageDialog() {
        if (!tauri) return null
        const selected = await open({ multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] })
        if (!selected || typeof selected !== 'string') return null
        const bytes = await fsReadFile(selected)
        return `data:image/png;base64,${bytesToBase64(bytes)}`
      },
      async saveText(title, defaultName, content) {
        if (!tauri) {
          // Web 预览降级：浏览器下载
          const blob = new Blob([content], { type: 'text/plain' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = defaultName
          a.click()
          URL.revokeObjectURL(url)
          return { ok: true }
        }
        const target = await save({ title, defaultPath: defaultName })
        if (!target) return { ok: false, canceled: true }
        await writeTextFile(target, content)
        return { ok: true, path: target }
      },
      async registerRoots() {},
      async readDir(rootPath, dirPath, showHidden = false) {
        assertInsideProject(rootPath, dirPath)
        const entries = await fsReadDir(dirPath)
        const out = entries
          // 隐藏文件开关：默认隐藏以 . 开头的条目（.nomedia、.DS_Store 等）
          .filter((e) => showHidden || !e.name.startsWith('.'))
          .map((e) => ({ ...toDirEntry(e), path: `${dirPath}/${e.name}` }))
        return out.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
      },
      async stat(rootPath, filePath) {
        assertInsideProject(rootPath, filePath)
        const s = await stat(filePath)
        return { mtimeMs: s.mtime ? s.mtime.getTime() : 0, size: s.size }
      },
      async readFile(rootPath, filePath) {
        assertInsideProject(rootPath, filePath)
        const bytes = await fsReadFile(filePath)
        const { content, hasBom } = decodeUtf8(bytes)
        const s = await stat(filePath).catch(() => null)
        return { content, hasBom, mtimeMs: s?.mtime ? s.mtime.getTime() : 0, size: bytes.length }
      },
      async writeFile(rootPath, filePath, content, opts) {
        assertInsideProject(rootPath, filePath)
        await fsWriteFile(filePath, encodeUtf8(content, opts.hasBom))
      },
      async createFile(rootPath, dirPath, name) {
        assertInsideProject(rootPath, dirPath)
        const check = validateEntryName(name)
        if (!check.ok) throw new Error(check.error)
        const target = `${dirPath}/${name.trim()}`
        // 拒绝覆盖：createFile 语义是「新建空文件」，同名时清空别人的内容
        if (await exists(target)) throw new Error(`已存在同名文件：${name.trim()}`)
        await writeTextFile(target, '')
      },
      async createFolder(rootPath, dirPath, name) {
        assertInsideProject(rootPath, dirPath)
        // AI 工具用空名创建父目录链（createFolder(root, parent, '')），保持 mkdir -p 语义
        if (!name.trim()) {
          await mkdir(dirPath, { recursive: true })
          return
        }
        const check = validateEntryName(name)
        if (!check.ok) throw new Error(check.error)
        await mkdir(`${dirPath}/${name.trim()}`, { recursive: true })
      },
      async rename(rootPath, oldPath, newPath) {
        assertInsideProject(rootPath, oldPath)
        assertInsideProject(rootPath, newPath)
        await rename(oldPath, newPath)
      },
      async delete(rootPath, targetPath) {
        assertInsideProject(rootPath, targetPath)
        // 项目根只能从项目页整项目删除，不允许从文件操作里点掉
        if (targetPath.replace(/\/+$/, '') === rootPath.replace(/\/+$/, '')) {
          throw new Error('不能在文件操作中删除项目根目录')
        }
        await remove(targetPath, { recursive: true })
      },
      async readImageAsDataUrl(rootPath, imagePath) {
        assertInsideProject(rootPath, imagePath)
        const bytes = await fsReadFile(imagePath)
        const ext = extname(imagePath) || 'png'
        const mime = ext === 'jpg' ? 'jpeg' : ext.replace(/^\./, '')
        return `data:image/${mime};base64,${bytesToBase64(bytes)}`
      },
      async readAudioAsDataUrl(rootPath, audioPath) {
        assertInsideProject(rootPath, audioPath)
        const bytes = await fsReadFile(audioPath)
        return `data:audio/ogg;base64,${bytesToBase64(bytes)}`
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
        return { ok: false, message: '社区后端未上线' }
      },
    },
    // v1 无知识包更新器：codeData 回退内置 fetch
    knowledge: undefined,
    mod: {
      async create() {
        return { files: [] }
      },
      async chooseMusic() {
        return []
      },
      async import() {
        // 旧契约入口：不限类型（UI 已改为显式选择「压缩包 / 文件夹」，见 importMod）
        return importMod('auto')
      },
      async discardImport() {
        return { ok: true }
      },
      async createUnit(rootPath, params) {
        const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
        const folder = (params.folder ?? '').replace(/^\/+|\/+$/g, '')
        const rel = folder ? `${folder}/${safeName}/${safeName}.ini` : `${safeName}/${safeName}.ini`
        const file = `${rootPath}/${rel}`
        if (await exists(file)) throw new Error(`单位文件已存在：${rel}（不会覆盖已有文件）`)
        const content = `[core]\nname: ${safeName}\nprice: 300\nmaxHp: 500\nmass: 500\nradius: 10\n\ndisplayLocaleKey: ${params.displayName ?? safeName}\n`
        await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
        await writeTextFile(file, content)
        return { path: rel }
      },
      async pack(rootPath, _options) {
        if (!tauri) throw new Error('打包仅支持 Tauri 环境')
        const { items, skipped } = await collectPackFiles(rootPath)
        if (items.length === 0) throw new Error('项目为空，没有可打包的文件')
        // 打包重活下沉 Worker（P3：打包 1 万文件不阻塞界面）
        const worker = new Worker(new URL('../features/modTools/packWorker.ts', import.meta.url), { type: 'module' })
        type PackWorkerResult = { ok: true; buffer: ArrayBuffer; files: number } | { ok: false; error: string }
        let result: PackWorkerResult
        try {
          result = await new Promise<PackWorkerResult>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('打包超时（文件过多或体积过大）')), 120_000)
            // 三条出口（成功/线程错误/消息解码失败）都先清定时器，避免悬空超时在打包结束后才抛错
            const settle = (fn: () => void) => {
              clearTimeout(timer)
              fn()
            }
            worker.onmessage = (ev: MessageEvent) => settle(() => resolve(ev.data as PackWorkerResult))
            worker.onerror = (e) => settle(() => reject(new Error(e.message || '打包线程错误')))
            worker.onmessageerror = () => settle(() => reject(new Error('打包线程消息解码失败')))
            worker.postMessage({ items, skipped })
          })
        } finally {
          // 无论成功、失败还是超时都回收线程（旧实现失败路径会漏掉 terminate）
          worker.terminate()
        }
        if (!result.ok) throw new Error(result.error)
        // 保存位置由系统对话框决定（SAF）
        const defaultName = `${basename(rootPath.replace(/\/+$/, '')) || 'mod'}.rwmod`
        const target = await save({ title: '保存模组包', defaultPath: defaultName })
        if (!target) return { canceled: true }
        await fsWriteFile(target, new Uint8Array(result.buffer))
        return { canceled: false, filePath: target, size: result.buffer.byteLength, files: result.files, skippedLinks: 0 }
      },
      async check() {
        throw new Error('M3 实现：语义检查面板')
      },
      async readModInfo(rootPath) {
        const file = `${rootPath}/mod-info.txt`
        assertInsideProject(rootPath, file)
        if (!(await exists(file))) return null
        const raw = await readTextFile(file)
        const get = (key: string): string | undefined => {
          const m = raw.match(new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, 'im'))
          return m?.[1]?.trim()
        }
        const list = (key: string): string[] =>
          (get(key) ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        const bool = (key: string): boolean => (get(key) ?? '').toLowerCase() === 'true'
        return {
          title: get('title') ?? '',
          description: get('description'),
          author: get('author'),
          version: get('version'),
          thumbnail: get('thumbnail'),
          minVersion: get('minVersion'),
          musicFiles: list('music'),
          musicExclusive: bool('musicExclusive'),
          mapsFiles: list('maps'),
          mapsExtra: bool('mapsExtra'),
          musicSourceFolder: get('musicSourceFolder'),
          mapsSourceFolder: get('mapsSourceFolder'),
          updateUrl: get('updateUrl'),
        }
      },
      async writeModInfo(rootPath, data) {
        const file = `${rootPath}/mod-info.txt`
        assertInsideProject(rootPath, file)
        // 保留写回：只改传入的键，注释/未知键/其它节/换行风格/BOM 原样保留
        const updates: ModInfoUpdate[] = []
        const put = (key: string, value: string | undefined): void => {
          if (value !== undefined) updates.push({ key, value })
        }
        put('title', data.title)
        put('description', data.description)
        put('author', data.author)
        put('version', data.version)
        put('thumbnail', data.thumbnail)
        put('minVersion', data.minVersion)
        if (data.musicFiles.length > 0) put('music', data.musicFiles.join(','))
        if (data.musicExclusive) put('musicExclusive', 'true')
        if (data.mapsFiles.length > 0) put('maps', data.mapsFiles.join(','))
        if (data.mapsExtra) put('mapsExtra', 'true')
        put('updateUrl', data.updateUrl)

        let existing = ''
        let hasBom = false
        if (await exists(file)) {
          const decoded = decodeUtf8(await fsReadFile(file))
          existing = decoded.content
          hasBom = decoded.hasBom
        }
        const next = updateModInfoText(existing, updates)
        await fsWriteFile(file, encodeUtf8(next, hasBom))
        return { ok: true }
      },
      async scanResources(rootPath) {
        // 遍历项目：收集文件相对路径 + 单位名（[core] name: 值）
        const files: string[] = []
        const unitNames: string[] = []
        const stack = ['']
        while (stack.length > 0) {
          const rel = stack.pop()!
          const abs = rel ? `${rootPath}/${rel}` : rootPath
          const entries = await fsReadDir(abs)
          for (const e of entries) {
            const childRel = rel ? `${rel}/${e.name}` : e.name
            if (e.isDirectory) {
              if (childRel === 'rules' || childRel.startsWith('.')) continue
              stack.push(childRel)
            } else {
              files.push(childRel)
              if (/\.ini$/i.test(e.name)) {
                try {
                  const raw = await readTextFile(abs ? `${abs}/${e.name}` : e.name)
                  const m = raw.match(/^\s*\[core\]\s*(?:#.*)?$/im)
                  if (m) {
                    const nameMatch = raw.slice(m.index).match(/^\s*name\s*:\s*([^\s#]+)/im)
                    if (nameMatch && nameMatch[1]) unitNames.push(nameMatch[1])
                  }
                } catch {
                  // 读取失败跳过
                }
              }
            }
          }
        }
        return { files, unitNames: [...new Set(unitNames)] }
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
        return fetchBuiltinTemplates()
      },
      async saveFileAsTemplate() {
        return { key: '' }
      },
      async importTemplate() {
        return null
      },
      async deleteUserTemplate() {
        return { ok: false }
      },
      async listUserTemplateKeys() {
        return []
      },
      async createUnitFromTemplate(rootPath, params) {
        const safeName = params.name.trim().replace(/[\\/:*?"<>|]/g, '-') || 'unit'
        const folder = (params.folder ?? '').replace(/^\/+|\/+$/g, '')
        const rel = folder ? `${folder}/${safeName}/${safeName}.ini` : `${safeName}/${safeName}.ini`
        const file = `${rootPath}/${rel}`
        if (await exists(file)) throw new Error(`单位文件已存在：${rel}（不会覆盖已有文件）`)
        // 内置模板（v1 只读内置包；用户模板目录预留）
        const base = import.meta.env.BASE_URL || '/'
        let raw: import('../features/modTools/templates').RawTemplate
        try {
          const r = await fetch(`${base}data/templates/${params.templateKey}.json`)
          raw = (await r.json()) as import('../features/modTools/templates').RawTemplate
        } catch {
          throw new Error(`模板不存在：${params.templateKey}`)
        }
        const { buildFileFromTemplate } = await import('../features/modTools/templates')
        await mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
        await writeTextFile(file, buildFileFromTemplate(raw, params.values ?? {}))
        return { path: rel }
      },
    },
    game: {
      async detect() {
        return { found: false, gamePath: null, units: [], mods: [] }
      },
      async importSample() {
        throw new Error('手机版不支持游戏目录导入')
      },
      async importMod() {
        throw new Error('手机版不支持游戏目录导入')
      },
      async launch() {
        return { ok: false, message: '手机版不支持启动游戏' }
      },
      async openDir() {
        return { ok: false, message: '手机版不支持系统文件管理器' }
      },
      async preflight() {
        return { ok: true, issues: [] }
      },
      async readAssetImage() {
        throw new Error('手机版不支持读取游戏资产')
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
        return { ok: false, message: '手机版第一版不支持 git' }
      },
    },
    ai: {
      async check() {
        throw new Error('M5 实现：AI 健康检查')
      },
      async info() {
        return { providers: [] }
      },
      async stream() {
        throw new Error('M5 实现：AI 流式对话')
      },
      async approve() {
        return false
      },
      async streamAbort() {
        return { aborted: false }
      },
      async historyList() {
        return []
      },
      async historyRestore() {
        return { ok: false }
      },
      async feedbackLint() {
        return false
      },
      onAiEvent() {
        return () => {}
      },
    },
  }
}

/** Uint8Array → base64（WebView 标准写法） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

let bridge: BridgeApi | null = null

/** 返回全局桥实例（与桌面版同签名：codeData/semanticChecks 动态 import 用） */
export function getBridge(): BridgeApi {
  if (!bridge) bridge = createMobileBridge()
  return bridge
}
