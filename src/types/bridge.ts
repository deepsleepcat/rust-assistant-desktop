/**
 * 界面进程（React）与主进程（Electron）之间的通信契约。
 * 所有文件操作都必须携带 rootPath（项目根目录），主进程会校验路径范围。
 */
import type { AiChatParams, AiCheckResult, AiProviderInfo, AiSettings, AiStreamEvent } from './ai'

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface ReadFileResult {
  content: string
  hasBom: boolean
  mtimeMs: number
  size: number
}

export interface OpenedProject {
  rootPath: string
  name: string
}

export interface StoreApi {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface BridgeApi {
  platform: string
  version: string
  appInfo(): Promise<{ version: string; platform: string }>
  /** M6 自动更新（更新包托管在 GitHub Releases） */
  app: {
    checkUpdate(): Promise<{ skipped: boolean; message?: string }>
    downloadUpdate(): Promise<{ skipped: boolean }>
    installUpdate(): Promise<boolean>
    onUpdateEvent(callback: (event: import('./ai').UpdateEvent) => void): () => void
  }
  store: StoreApi
  project: {
    openFolderDialog(): Promise<OpenedProject | null>
    openImageDialog(): Promise<string | null>
    registerRoots(roots: string[]): Promise<void>
    readDir(rootPath: string, dirPath: string): Promise<DirEntry[]>
    readFile(rootPath: string, filePath: string): Promise<ReadFileResult>
    writeFile(rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }): Promise<void>
    createFile(rootPath: string, dirPath: string, name: string): Promise<void>
    createFolder(rootPath: string, dirPath: string, name: string): Promise<void>
    rename(rootPath: string, oldPath: string, newPath: string): Promise<void>
    delete(rootPath: string, targetPath: string): Promise<void>
    readImageAsDataUrl(rootPath: string, imagePath: string): Promise<string>
  }
  avatar: {
    chooseLocal(): Promise<string | null>
    uploadCommunity(): Promise<{ ok: false; message: string }>
  }
  /** M5 模组工具 */
  mod: {
    create(rootPath: string, params: { name: string; title: string; description?: string; author?: string; version?: string; thumbnail?: string }): Promise<{ files: string[] }>
    createUnit(rootPath: string, params: { name: string; displayName?: string; folder?: string }): Promise<{ path: string }>
    pack(rootPath: string): Promise<{ canceled: true } | { canceled: false; filePath: string; size: number; files: number }>
    check(rootPath: string): Promise<{ issues: Array<{ file: string; level: 'error' | 'warning'; message: string }>; unitCount: number; fileCount: number }>
    /** M6.5 模板系统 */
    listTemplates(): Promise<import('./mod').TemplateMeta[]>
    createUnitFromTemplate(rootPath: string, params: { name: string; folder?: string; templateKey: string; values: Record<string, string> }): Promise<{ path: string }>
  }
  ai: {
    /** 健康检查：验证 Key/连接 */
    check(settings: AiSettings): Promise<AiCheckResult>
    /** 提供者信息列表（设置面板展示） */
    info(): Promise<{ providers: AiProviderInfo[] }>
    /** 开始流式对话；返回事件通道，通过 onAiEvent 订阅 */
    stream(params: AiChatParams, settings: AiSettings, projectRoot: string): Promise<string>
    approve(response: { id: string; approved: boolean }): Promise<boolean>
    onAiEvent(callback: (event: AiStreamEvent) => void): () => void
  }
}
