/**
 * Mock 桥：在不启动 Electron 的浏览器里模拟完整的桌面能力。
 * 用途：
 * 1. `npm run dev:web` 快速预览界面；
 * 2. 单元测试里注入假文件系统，测试项目/对话/保存等核心逻辑。
 *
 * 文件系统是内存中的一棵假目录树，存储（设置/工作区）走 localStorage。
 */
import type { BridgeApi, DirEntry, ReadFileResult } from '../types/bridge'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../utils/settings'

interface MockFile {
  kind: 'file'
  content: string
  hasBom: boolean
}
interface MockDir {
  kind: 'dir'
  children: Record<string, MockNode>
}
type MockNode = MockFile | MockDir

export interface MockFileSpec {
  path: string
  content: string
}

export const MOCK_PROJECT_ROOT = 'C:\\模组\\我的第一个模组'

const MOCK_FILES: MockFileSpec[] = [
  { path: `${MOCK_PROJECT_ROOT}\\mod.json`, content: `{
  "name": "我的第一个模组",
  "version": "1.0.0",
  "description": "在浏览器预览模式下的示例模组"
}` },
  { path: `${MOCK_PROJECT_ROOT}\\units\\rifle.txt`, content: `[core]
name = "步枪兵"
price = 300
health = 100
damage = 12

[attack]
range = 180
fireRate = 0.8
` },
  { path: `${MOCK_PROJECT_ROOT}\\units\\tank.txt`, content: `[core]
name = "坦克"
price = 800
health = 400
damage = 35

[attack]
range = 220
fireRate = 0.5
` },
  { path: `${MOCK_PROJECT_ROOT}\\sounds\\notes.txt`, content: `# 音效文件说明
本目录存放模组用到的音效。` },
  { path: `${MOCK_PROJECT_ROOT}\\README.md`, content: `# 我的第一个模组

在浏览器预览模式下创建的示例模组。
点击左侧「打开项目」会直接进入这个示例项目。
` },
]

function buildTree(files: MockFileSpec[]): MockDir {
  // 返回「项目根目录」对应的节点；文件路径去掉根前缀后建树
  const root: MockDir = { kind: 'dir', children: {} }
  const prefixLen = MOCK_PROJECT_ROOT.split('\\').length
  for (const file of files) {
    const parts = file.path.split('\\')
    const rel = parts.slice(prefixLen)
    let node: MockDir = root
    for (const part of rel.slice(0, -1)) {
      const existing = node.children[part]
      if (existing?.kind === 'dir') {
        node = existing
      } else {
        const dir: MockDir = { kind: 'dir', children: {} }
        node.children[part] = dir
        node = dir
      }
    }
    node.children[rel[rel.length - 1]] = { kind: 'file', content: file.content, hasBom: false }
  }
  return root
}

function findNode(dir: MockDir, relParts: string[]): MockNode | null {
  let node: MockNode = dir
  for (const part of relParts) {
    if (node.kind !== 'dir') return null
    const next: MockNode | undefined = node.children[part]
    if (!next) return null
    node = next
  }
  return node
}

function relToRoot(fullPath: string): string[] {
  const norm = fullPath.replace(/\//g, '\\')
  const prefix = MOCK_PROJECT_ROOT + '\\'
  if (norm !== MOCK_PROJECT_ROOT && !norm.startsWith(prefix)) {
    throw new Error('路径超出示例项目范围（Mock 模式只支持示例项目）')
  }
  if (norm === MOCK_PROJECT_ROOT) return []
  return norm.slice(prefix.length).split('\\')
}

const MOCK_IMAGE_DATA_URL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#4285f4"/><stop offset=".4" stop-color="#ea4335"/>
        <stop offset=".7" stop-color="#fbbc04"/><stop offset="1" stop-color="#34a853"/>
      </linearGradient></defs>
      <rect width="400" height="250" fill="url(#g)" opacity=".55"/>
      <text x="24" y="140" font-family="sans-serif" font-size="30" fill="#fff" opacity=".85">Mock 背景示例</text>
    </svg>`,
  )

export function createMockBridge(files: MockFileSpec[] = MOCK_FILES): BridgeApi {
  const tree = buildTree(files)

  const storageKey = 'rust-assistant:mock-state'
  function loadState<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return fallback
      const all = JSON.parse(raw) as Record<string, unknown>
      return (all[key] as T) ?? fallback
    } catch {
      return fallback
    }
  }
  function saveState(key: string, value: unknown): void {
    try {
      const raw = localStorage.getItem(storageKey)
      const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      all[key] = value
      localStorage.setItem(storageKey, JSON.stringify(all))
    } catch {
      /* 隐私模式等场景下忽略 */
    }
  }

  function listDir(dirPath: string): DirEntry[] {
    const parts = relToRoot(dirPath)
    const node = findNode(tree, parts)
    if (!node || node.kind !== 'dir') throw new Error('目录不存在：' + dirPath)
    const entries = Object.entries(node.children).map(([name, child]) => ({
      name,
      path: dirPath + '\\' + name,
      isDirectory: child.kind === 'dir',
      size: child.kind === 'file' ? new TextEncoder().encode(child.content).length : 0,
      mtimeMs: child.kind === 'file' ? child.content.length : 0,
    }))
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
    return entries
  }

  function readFile(filePath: string): ReadFileResult {
    const node = findNode(tree, relToRoot(filePath))
    if (!node || node.kind !== 'file') throw new Error('文件不存在：' + filePath)
    const content = node.content.startsWith('\uFEFF') ? node.content.slice(1) : node.content
    return {
      content,
      hasBom: node.hasBom,
      mtimeMs: node.content.length,
      size: new TextEncoder().encode(node.content).length,
    }
  }

  function writeFile(filePath: string, content: string, opts: { hasBom: boolean }): void {
    const parts = relToRoot(filePath)
    const dir = findNode(tree, parts.slice(0, -1))
    if (!dir || dir.kind !== 'dir') throw new Error('父目录不存在：' + filePath)
    const name = parts[parts.length - 1]
    const body = opts.hasBom ? '\uFEFF' + content : content
    dir.children[name] = { kind: 'file', content: body, hasBom: opts.hasBom }
  }

  function createInDir(dirPath: string, name: string, node: MockNode): void {
    const parts = relToRoot(dirPath)
    const dir = findNode(tree, parts)
    if (!dir || dir.kind !== 'dir') throw new Error('目录不存在：' + dirPath)
    if (dir.children[name]) throw new Error('已存在同名文件/文件夹：' + name)
    dir.children[name] = node
  }

  return {
    platform: 'mock',
    version: '0.1.0',
    appInfo: async () => ({ version: '0.1.0', platform: 'mock' }),
    app: {
      checkUpdate: async () => ({ skipped: true, message: '浏览器预览模式不检查更新' }),
      downloadUpdate: async () => ({ skipped: true }),
      installUpdate: async () => true,
      onUpdateEvent: () => () => undefined,
    },
    store: {
      get: async (key) => {
        if (key === 'settings') return sanitizeSettings(loadState('settings', DEFAULT_SETTINGS))
        if (key === 'workspace') return loadState('workspace', null)
        return null
      },
      set: async (key, value) => saveState(key, value),
    },
    project: {
      openFolderDialog: async () => ({ rootPath: MOCK_PROJECT_ROOT, name: '我的第一个模组' }),
      openImageDialog: async () => MOCK_IMAGE_DATA_URL,
      registerRoots: async () => undefined,
      readDir: async (_root, dirPath) => listDir(dirPath),
      readFile: async (_root, filePath) => readFile(filePath),
      writeFile: async (_root, filePath, content, opts) => {
        writeFile(filePath, content, opts)
      },
      createFile: async (_root, dirPath, name) => createInDir(dirPath, name, { kind: 'file', content: '', hasBom: false }),
      createFolder: async (_root, dirPath, name) => createInDir(dirPath, name, { kind: 'dir', children: {} }),
      rename: async (_root, oldPath, newPath) => {
        const parts = relToRoot(oldPath)
        const dir = findNode(tree, parts.slice(0, -1))
        if (!dir || dir.kind !== 'dir') throw new Error('找不到要重命名的项目')
        const node = dir.children[parts[parts.length - 1]]
        if (!node) throw new Error('找不到要重命名的项目')
        delete dir.children[parts[parts.length - 1]]
        const newParts = relToRoot(newPath)
        const target = findNode(tree, newParts.slice(0, -1))
        if (!target || target.kind !== 'dir') throw new Error('重命名目标目录不存在')
        target.children[newParts[newParts.length - 1]] = node
      },
      delete: async (_root, targetPath) => {
        const parts = relToRoot(targetPath)
        const dir = findNode(tree, parts.slice(0, -1))
        if (!dir || dir.kind !== 'dir') throw new Error('找不到要删除的项目')
        delete dir.children[parts[parts.length - 1]]
      },
      readImageAsDataUrl: async (_root, _imagePath) => MOCK_IMAGE_DATA_URL,
    },
    avatar: {
      chooseLocal: async () => null,
      uploadCommunity: async () => ({ ok: false, message: '社区头像服务即将上线' }),
    },
    mod: {
      create: async () => ({ files: ['mod-info.txt', 'units/'] }),
      createUnit: async () => ({ path: 'units/mock-unit/mock-unit.ini' }),
      pack: async () => ({ canceled: true }),
      check: async () => ({ issues: [], unitCount: 0, fileCount: 0 }),
    },
    ai: {
      check: async (settings) => {
        if (settings.provider === 'deepseek') {
          return settings.deepseekApiKey
            ? { ok: true, message: '连接成功（浏览器预览模式）' }
            : { ok: false, message: '未配置 DeepSeek API Key，请在设置中填写' }
        }
        return { ok: false, message: '社区 AI 服务即将上线（内部预留）' }
      },
      info: async () => ({
        providers: [
          { type: 'deepseek', name: 'DeepSeek', description: '使用你自己的 DeepSeek API Key', configured: false, available: true, models: ['deepseek-chat', 'deepseek-reasoner'] },
          { type: 'community', name: '社区后端', description: '我们提供的社区 AI 服务（即将上线）', configured: false, available: false, models: [] },
        ],
      }),
      approve: async () => true,
      stream: async (_params, _settings, _projectRoot) => {
        // 浏览器预览模式：模拟流式回复，便于界面联调
        const reply = '这是浏览器预览模式的模拟回复。\n\n配置真实的 DeepSeek API Key 后，这里会显示真实的 AI 回复。\n\n你可以：\n1. 在设置 → AI 中填写 API Key\n2. 然后问任何铁锈战争模组问题'
        const chars = [...reply]
        for (let i = 0; i < chars.length; i += 3) {
          mockAiListeners.forEach((listener) => listener({ type: 'delta', text: chars.slice(i, i + 3).join('') }))
          await new Promise((r) => setTimeout(r, 20))
        }
        mockAiListeners.forEach((listener) => listener({ type: 'done', fullText: reply }))
        return 'ai:stream'
      },
      onAiEvent: (callback) => {
        mockAiListeners.add(callback)
        return () => mockAiListeners.delete(callback)
      },
    },
  }
}

const mockAiListeners = new Set<(event: import("../types/ai").AiStreamEvent) => void>()
