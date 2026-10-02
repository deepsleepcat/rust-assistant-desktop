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

const BOM = new Uint8Array([0xef, 0xbb, 0xbf])

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
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> = Promise.resolve()

  async function load(): Promise<Record<string, unknown>> {
    if (cache) return cache
    try {
      const file = await appPath('app-state.json')
      const raw = await readTextFile(file)
      cache = JSON.parse(raw) as Record<string, unknown>
    } catch {
      cache = {}
    }
    return cache
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
      async readDir(_rootPath, dirPath) {
        const entries = await fsReadDir(dirPath)
        const out = entries.map((e) => ({ ...toDirEntry(e), path: `${dirPath}/${e.name}` }))
        return out.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
      },
      async stat(_rootPath, filePath) {
        const s = await stat(filePath)
        return { mtimeMs: s.mtime ? s.mtime.getTime() : 0, size: s.size }
      },
      async readFile(_rootPath, filePath) {
        const bytes = await fsReadFile(filePath)
        const { content, hasBom } = decodeUtf8(bytes)
        const s = await stat(filePath).catch(() => null)
        return { content, hasBom, mtimeMs: s?.mtime ? s.mtime.getTime() : 0, size: bytes.length }
      },
      async writeFile(_rootPath, filePath, content, opts) {
        await fsWriteFile(filePath, encodeUtf8(content, opts.hasBom))
      },
      async createFile(_rootPath, dirPath, name) {
        await writeTextFile(`${dirPath}/${name}`, '')
      },
      async createFolder(_rootPath, dirPath, name) {
        await mkdir(`${dirPath}/${name}`, { recursive: true })
      },
      async rename(_rootPath, oldPath, newPath) {
        await rename(oldPath, newPath)
      },
      async delete(_rootPath, targetPath) {
        await remove(targetPath, { recursive: true })
      },
      async readImageAsDataUrl(_rootPath, imagePath) {
        const bytes = await fsReadFile(imagePath)
        const ext = extname(imagePath) || 'png'
        const mime = ext === 'jpg' ? 'jpeg' : ext.replace(/^\./, '')
        return `data:image/${mime};base64,${bytesToBase64(bytes)}`
      },
      async readAudioAsDataUrl(_rootPath, audioPath) {
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
        if (!tauri) return null
        // 支持目录（SAF）与 .rwmod/.zip 文件
        const selected = await open({ multiple: false })
        if (!selected || typeof selected !== 'string') return null
        const isZip = /\.(rwmod|zip)$/i.test(selected)
        if (!isZip) {
          // 目录：拷贝进应用私有目录（与 openFolderDialog 一致）
          const name = sanitizeName(basename(selected.replace(/\/+$/, '')) || '导入项目')
          const dest = await appPath('projects', name)
          const finalDest = (await exists(dest)) ? `${dest}_${Date.now().toString(36)}` : dest
          await copyDirRecursive(selected, finalDest)
          return { rootPath: finalDest, name: basename(finalDest) }
        }
        // .rwmod/.zip：解压到应用私有目录
        const bytes = await fsReadFile(selected)
        const name = sanitizeName(basename(selected).replace(/\.(rwmod|zip)$/i, '')) || '导入模组'
        const dest = await appPath('projects', name)
        const finalDest = (await exists(dest)) ? `${dest}_${Date.now().toString(36)}` : dest
        const files = await extractZip(bytes, finalDest)
        return { rootPath: finalDest, name: basename(finalDest), files }
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
        const result = await new Promise<{ ok: true; buffer: ArrayBuffer; files: number } | { ok: false; error: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('打包超时')), 120_000)
          worker.onmessage = (ev: MessageEvent) => {
            clearTimeout(timer)
            resolve(ev.data as never)
          }
          worker.onerror = (e) => {
            clearTimeout(timer)
            reject(new Error(e.message || '打包线程错误'))
          }
          worker.postMessage({ items, skipped })
        })
        worker.terminate()
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
        const lines = [
          '# 模组信息',
          '[mod]',
          `title: ${data.title}`,
          data.description !== undefined ? `description: ${data.description}` : '',
          data.author !== undefined ? `author: ${data.author}` : '',
          data.version !== undefined ? `version: ${data.version}` : '',
          data.thumbnail !== undefined ? `thumbnail: ${data.thumbnail}` : '',
          data.minVersion !== undefined ? `minVersion: ${data.minVersion}` : '',
          data.musicFiles.length > 0 ? `music: ${data.musicFiles.join(',')}` : '',
          data.musicExclusive ? 'musicExclusive: true' : '',
          data.mapsFiles.length > 0 ? `maps: ${data.mapsFiles.join(',')}` : '',
          data.mapsExtra ? 'mapsExtra: true' : '',
          data.updateUrl ? `updateUrl: ${data.updateUrl}` : '',
        ].filter((l) => l !== '')
        await writeTextFile(file, lines.join('\n') + '\n')
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
