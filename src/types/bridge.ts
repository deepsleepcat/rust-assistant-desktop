/**
 * 界面进程（React）与主进程（Electron）之间的通信契约。
 * 所有文件操作都必须携带 rootPath（项目根目录），主进程会校验路径范围。
 */
import type { AiChatParams, AiCheckResult, AiHistoryMeta, AiProviderInfo, AiSettings, AiStreamEvent } from './ai'

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
    /** LOW-3b：窗口关闭前事件（渲染层借此立即落盘） */
    onBeforeClose(callback: () => void): () => void
    /** LOW-3b：渲染层落盘完成确认（主进程收到后销毁窗口） */
    confirmClose(): Promise<boolean>
  }
  store: StoreApi
  project: {
    openFolderDialog(): Promise<OpenedProject | null>
    openImageDialog(): Promise<string | null>
    registerRoots(roots: string[]): Promise<void>
    readDir(rootPath: string, dirPath: string, showHidden?: boolean): Promise<DirEntry[]>
    /** 只读元数据（mtimeMs/size）：外部修改轮询用，不传输文件内容 */
    stat(rootPath: string, filePath: string): Promise<{ mtimeMs: number; size: number }>
    readFile(rootPath: string, filePath: string): Promise<ReadFileResult>
    writeFile(rootPath: string, filePath: string, content: string, opts: { hasBom: boolean }): Promise<void>
    createFile(rootPath: string, dirPath: string, name: string): Promise<void>
    createFolder(rootPath: string, dirPath: string, name: string): Promise<void>
    rename(rootPath: string, oldPath: string, newPath: string): Promise<void>
    delete(rootPath: string, targetPath: string): Promise<void>
    readImageAsDataUrl(rootPath: string, imagePath: string): Promise<string>
    /** M6.5 音频预览：读音频为 data URL（限项目内） */
    readAudioAsDataUrl(rootPath: string, audioPath: string): Promise<string>
  }
  avatar: {
    chooseLocal(): Promise<string | null>
    /** 保存裁剪后的头像（PNG data URL）→ 返回已登记的文件路径 */
    saveCropped(dataUrl: string): Promise<string>
    uploadCommunity(): Promise<{ ok: false; message: string }>
  }
  /** M5 模组工具 */
  mod: {    create(rootPath: string, params: { name?: string; title: string; description?: string; author?: string; version?: string; thumbnail?: string; musicFiles?: string[]; musicExclusive?: boolean; updateUrl?: string }): Promise<{ files: string[]; musicFailed?: string[] }>
    /** M6.5 选择背景音乐（多选，返回绝对路径列表；取消返回空数组） */
    chooseMusic(): Promise<string[]>
    /** 统一导入模组：文件夹直接注册，rwmod/zip 自动解压；取消返回 null */
    import(): Promise<{ rootPath: string; name: string; files?: number } | null>
    /** 撤销导入：删除本次会话刚解压但未被使用的目录（导入确认被取消时调用） */
    discardImport(rootPath: string): Promise<{ ok: boolean }>
    createUnit(rootPath: string, params: { name: string; displayName?: string; folder?: string }): Promise<{ path: string }>
    pack(rootPath: string, options?: { removeEmptyFiles?: boolean; removeEmptyFolders?: boolean; removeEmptyLines?: boolean; removeComments?: boolean; formatCode?: boolean }): Promise<{ canceled: true } | { canceled: false; filePath: string; size: number; files: number; skippedLinks?: number }>
    check(rootPath: string): Promise<{ issues: Array<{ file: string; level: 'error' | 'warning' | 'info'; message: string }>; unitCount: number; fileCount: number }>
    /** 读取模组自述文件（不存在返回 null） */
    readModInfo(rootPath: string): Promise<{ title: string; description?: string; author?: string; version?: string; thumbnail?: string; minVersion?: string; musicFiles: string[]; musicExclusive: boolean; mapsFiles: string[]; mapsExtra: boolean; musicSourceFolder?: string; mapsSourceFolder?: string; updateUrl?: string } | null>
    /** 写回模组自述文件（覆盖式） */
    writeModInfo(rootPath: string, data: { title: string; description?: string; author?: string; version?: string; thumbnail?: string; minVersion?: string; musicFiles: string[]; musicExclusive: boolean; mapsFiles: string[]; mapsExtra: boolean; musicSourceFolder?: string; mapsSourceFolder?: string; updateUrl?: string }): Promise<{ ok: boolean }>
    /** 扫描项目资源（文件相对路径列表 + 单位名列表），供编辑器补全 */
    scanResources(rootPath: string): Promise<{ files: string[]; unitNames: string[] }>
    /** 扫描项目内全部单位概要（单位库浏览） */
    scanUnits(rootPath: string): Promise<Array<{ path: string; name: string; description?: string; image?: string; modified: number }>>
    /** 优化工具：扫描可优化项（空文件/空文件夹/.bak/空行/注释） */
    optimizeScan(rootPath: string): Promise<Array<{ id: string; kind: 'emptyFile' | 'emptyFolder' | 'backupFile' | 'emptyLine' | 'comment'; rel: string; detail?: string }>>
    /** 优化工具：按 id 执行优化 */
    optimizeApply(rootPath: string, ids: string[]): Promise<{ done: number; failed: number }>
    /** 全局操作：对整个模组源文件批量替换/头部附加/尾部附加 */
    globalOp(rootPath: string, params: { kind: 'replace' | 'prepend' | 'append'; find?: string; text?: string }): Promise<{ files: number; changed: number; skipped: number }>
    /** M6.5 模板系统 */
    listTemplates(): Promise<import('./mod').TemplateMeta[]>
    /** M7 模板制作：把单位文件保存为模板（自动生成输入项）；content 为当前编辑内容（可能未落盘） */
    saveFileAsTemplate(rootPath: string, filePath: string, templateName: string, content?: string): Promise<{ key: string }>
    createUnitFromTemplate(rootPath: string, params: { name: string; folder?: string; templateKey: string; values: Record<string, string> }): Promise<{ path: string }>
  }
  /** M8 游戏集成：铁锈战争安装目录检测 / 官方单位示例 / 游戏内模组导入 */
  game: {
    detect(configuredPath?: string): Promise<{ found: boolean; gamePath: string | null; units: string[]; mods: string[] }>
    /** 导入官方单位示例到已登记的目标目录（targetRoot 需先经 dialog:openFolder 选择） */
    importSample(gamePath: string, targetRoot: string, opts?: { title?: string; description?: string }): Promise<{ rootPath: string; units: number; files: number }>
    /** 解压游戏 mods/units 下的 .rwmod 到已登记的目标目录 */
    importMod(gamePath: string, fileName: string, targetRoot: string): Promise<{ rootPath: string; files: number }>
    /** M12：启动游戏（只接受通过 looksLikeGameDir 校验的目录） */
    launch(gamePath: string): Promise<{ ok: boolean; message?: string }>
    /** M12：打开已登记的项目根目录（系统文件管理器） */
    openDir(rootPath: string): Promise<{ ok: boolean; message?: string }>
    /** M12：运行前检查清单（mod-info 完整性 + 引用文件存在 + 单位完整性） */
    preflight(rootPath: string): Promise<{ ok: boolean; issues: Array<{ severity: 'error' | 'warning'; message: string; file?: string }> }>
  }
  ai: {
    /** 健康检查：验证 Key/连接 */
    check(settings: AiSettings): Promise<AiCheckResult>
    /** 提供者信息列表（设置面板展示） */
    info(): Promise<{ providers: AiProviderInfo[] }>
    /** 开始流式对话；返回事件通道，通过 onAiEvent 订阅 */
    stream(params: AiChatParams, settings: AiSettings, projectRoot: string): Promise<string>
    approve(response: { id: string; approved: boolean }): Promise<boolean>
    /** 中止当前 AI 流（渲染层看门狗超时用）：拒绝在途审批 + 释放主进程 AI 锁 */
    streamAbort(): Promise<{ aborted: boolean }>
    /** 某文件的 AI 修改历史（元数据：id/时间/大小；内容在恢复时由主进程读取） */
    historyList(rootPath: string, relPath: string): Promise<AiHistoryMeta[]>
    /** 恢复到指定历史版本（写回磁盘；快照为「新建」时删除文件并返回 deleted） */
    historyRestore(rootPath: string, relPath: string, snapshotId: string): Promise<{ ok: boolean; message?: string; deleted?: boolean }>
    onAiEvent(callback: (event: AiStreamEvent) => void): () => void
  }
}
