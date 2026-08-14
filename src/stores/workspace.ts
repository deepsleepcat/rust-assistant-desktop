/**
 * 全局状态仓库（Zustand）：整个应用唯一的「数据中枢」。
 * - 界面组件只从这里读取/修改状态，不直接碰文件系统；
 * - 所有持久化动作（设置、项目、对话）都会自动写入本地存储；
 * - 测试时传入 Mock 桥即可验证完整业务流。
 */
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { AppSettings, Conversation, EditorTab, ProjectInfo, TreeNode } from '../types/domain'
import type { BridgeApi } from '../types/bridge'
import { getBridge } from '../services/bridge'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../utils/settings'
import { nextConversationTitle, sortConversations } from '../utils/conversation'
import { findTreeNode, updateTreeNode } from '../utils/tree'
import { basename, isPreviewableAudio, isPreviewableImage } from '../utils/paths'
import { loadCodeData, getEnToZhDict, getZhToEnDict } from '../services/codeData'
import { enToZh, makeDict, zhToEn } from '../services/translation'
import { invalidateResourceCache } from '../features/editor/completion'
import { RUST_ASSISTANT_SYSTEM_PROMPT } from '../ai/rustSystemPrompt'
import type { AiStreamEvent } from '../types/ai'

export interface ConfirmRequest {
  title: string
  message: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
  /** 可选：「保存后继续」按钮（如切换项目前的「保存并切换」）。
   * save 返回 false 表示保存失败（中止，保留弹窗）；done 在保存成功后执行切换。 */
  saveThen?: { label: string; save: () => Promise<boolean>; done: () => void }
  /** 可选：用户取消（点取消/Escape）时回调（如 resolve 挂起的调用方） */
  onCancel?: () => void
  onConfirm: () => void
}

export interface EditorPosition {
  line: number
  col: number
}

interface WorkspaceStoreState {
  ready: boolean
  version: string
  settings: AppSettings
  projects: ProjectInfo[]
  activeProjectId: string | null
  conversations: Conversation[]
  lastActiveConversationByProject: Record<string, string | null>
  activeConversationId: string | null
  treeRoot: TreeNode | null
  treeError: string | null
  /** M7：收藏的文件/文件夹（快速跳转；归属项目，避免跨项目串显示） */
  bookmarks: Array<{ path: string; name: string; projectId: string; isDirectory: boolean }>
  openTabs: EditorTab[]
  activeTabId: string | null
  editorPos: EditorPosition
  settingsOpen: boolean
  commandOpen: boolean
  /** M7：代码表浏览弹窗 */
  codeTableOpen: boolean
  /** M7：单位库弹窗 */
  unitLibraryOpen: boolean
  /** M8：值类型管理弹窗 */
  valueTypeOpen: boolean
  /** M12：炮塔编辑器弹窗 */
  turretEditorOpen: boolean
  confirm: ConfirmRequest | null
  toast: string | null
  /** 当前正在流式回复的对话（null 表示没有） */
  aiStreamingConversationId: string | null
  /** 待审批的写文件请求 */
  pendingApproval: { id: string; path: string; contentPreview: string; contentLength?: number } | null
  /** M5：模组工具弹窗（null 表示关闭） */
  modDialog: 'createMod' | 'createUnit' | 'check' | 'optimize' | 'pack' | 'globalOp' | null
  /** M5：单位检查结果 */
  modCheckResult: { issues: Array<{ file: string; level: 'error' | 'warning' | 'info'; message: string }>; unitCount: number; fileCount: number } | null
  /** M7：优化工具扫描结果 */
  optimizeItems: Array<{ id: string; kind: 'emptyFile' | 'emptyFolder' | 'backupFile' | 'emptyLine' | 'comment'; rel: string; detail?: string }> | null
  /** M8：优化扫描失败信息（null 表示无失败；重试入口由弹窗提供） */
  optimizeError: string | null
  /** M6：自动更新状态（设置 → 关于 展示） */
  updateState: {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not_available' | 'error'
    version?: string
    percent?: number
    message?: string
  }
}

interface WorkspaceStoreActions {
  init(): Promise<void>
  openProject(): Promise<void>
  importModProject(): Promise<void>
  /** M8：把已存在的目录注册为新项目（游戏示例/游戏模组导入用）：
   * 确认未保存编辑 → 切到新项目 → 刷新树 → 通知；用户取消返回 false */
  addImportedProject(rootPath: string, name: string, message: string): Promise<boolean>
  selectProject(id: string): Promise<void>
  removeProject(id: string): void
  refreshTree(): Promise<void>
  loadDir(node: TreeNode): Promise<void>
  /** 局部刷新目录节点（其下增删改后调用；未加载过子项的目录跳过） */
  reloadDirNode(path: string): Promise<void>
  toggleDir(path: string): void
  openFile(path: string): Promise<void>
  updateTabContent(id: string, content: string): void
  /** 保存标签页：返回是否保存成功（外部修改拦截/失败时返回 false，调用方据此决定是否关闭标签） */
  saveTab(id: string): Promise<boolean>
  /** 重新加载标签页内容（丢弃本地修改，用于文件被外部修改后） */
  reloadTab(id: string): Promise<void>
  closeTab(id: string): void
  setActiveTabId(id: string): void
  toggleTranslation(id: string): void
  checkExternalChanges(): Promise<void>
  createFile(parentPath: string, name: string): Promise<void>
  createFolder(parentPath: string, name: string): Promise<void>
  renameItem(targetPath: string, newName: string): Promise<void>
  deleteItem(targetPath: string): Promise<void>
  /** M7：收藏/取消收藏（文件或文件夹） */
  toggleBookmark(path: string, isDirectory: boolean): void
  isBookmarked(path: string): boolean
  createConversation(): void
  renameConversation(id: string, title: string): void
  toggleArchiveConversation(id: string): void
  deleteConversation(id: string): void
  selectConversation(id: string): void
  updateSettings(patch: Partial<AppSettings>): void
  setEditorPos(pos: EditorPosition): void
  setSettingsOpen(open: boolean): void
  setCommandOpen(open: boolean): void
  setCodeTableOpen(open: boolean): void
  setUnitLibraryOpen(open: boolean): void
  /** M8：值类型管理弹窗 */
  setValueTypeOpen(open: boolean): void
  /** M12：炮塔编辑器弹窗 */
  setTurretEditorOpen(open: boolean): void
  requestConfirm(req: ConfirmRequest): void
  dismissConfirm(): void
  /** 有未保存编辑时先确认再执行动作（切项目/导模组前调用，防止静默丢编辑）。
   * resolve true=已执行；false=用户取消或失败 */
  confirmDirtySwitch(action: () => Promise<void> | void): Promise<boolean>
  dismissConfirm(): void
  notify(message: string): void
  /** LOW-3b：应用关闭前同步落盘（取消防抖立即写入） */
  flushPersist(): Promise<void>
  dismissToast(): void
  /** M4：向 AI 发送消息（流式） */
  sendAiMessage(conversationId: string, text: string): Promise<void>
  respondApproval(approved: boolean): Promise<void>
  /** M5：模组工具 */
  setModDialog(kind: 'createMod' | 'createUnit' | 'check' | 'optimize' | 'pack' | 'globalOp' | null): void
  createModProject(params: { title: string; description?: string; author?: string; version?: string; musicFiles?: string[]; musicExclusive?: boolean; updateUrl?: string }): Promise<void>
  /** M7：编辑模组自述文件（mod-info.txt 读写，包含 thumbnail/music/maps） */
  saveModInfo(data: { title: string; description?: string; author?: string; version?: string; thumbnail?: string; minVersion?: string; musicFiles: string[]; musicExclusive: boolean; mapsFiles: string[]; mapsExtra: boolean; musicSourceFolder?: string; mapsSourceFolder?: string; updateUrl?: string }): Promise<void>
  /** M7：把当前打开的文件保存为模板 */
  saveActiveFileAsTemplate(name: string): Promise<void>
  createUnitFile(params: { name: string; templateKey: string; values: Record<string, string> }): Promise<void>
  packModProject(): Promise<void>
  packModWithOptions(options: { removeEmptyFiles?: boolean; removeEmptyFolders?: boolean; removeEmptyLines?: boolean; removeComments?: boolean; formatCode?: boolean }): Promise<void>
  checkModProject(): Promise<void>
  /** M7：优化工具 */
  scanOptimizeProject(): Promise<void>
  applyOptimizeProject(ids: string[]): Promise<void>
  /** 全局操作：批量替换/头部附加/尾部附加（返回结果供弹窗展示；失败返回 null） */
  globalOpProject(params: { kind: 'replace' | 'prepend' | 'append'; find?: string; text?: string }): Promise<{ files: number; changed: number; skipped: number } | null>
  /** M6：自动更新 */
  checkUpdate(): Promise<void>
  downloadUpdate(): Promise<void>
  installUpdate(): void
}

export type WorkspaceStore = WorkspaceStoreState & WorkspaceStoreActions

/** loadDir 同目录并发守卫：目录路径 → 最近一次请求序号（旧响应落地前丢弃） */
const dirLoadSeqs = new Map<string, number>()
/** 持久化裁剪后仍超限的提示标志（本次会话只提示一次，防噪音） */
let trimNotified = false

export function createWorkspaceStore(bridge: BridgeApi) {
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  // L1：init 幂等（StrictMode 双挂载/重复调用只执行一次，避免重复订阅更新事件）
  let initPromise: Promise<void> | null = null

  return create<WorkspaceStore>()((set, get) => {
    const activeProject = (): ProjectInfo | null =>
      get().projects.find((p) => p.id === get().activeProjectId) ?? null

    function persist(): void {
      const s = get()
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        // IPC 通道级失败（窗口销毁途中等）不产生 unhandled rejection；
        // 真实拒绝（如 store 超限）要提示，避免对话/项目记录静默丢失
        void bridge.store.set('settings', s.settings).catch(() => undefined)
        void persistWorkspace({
          projects: s.projects,
          activeProjectId: s.activeProjectId,
          conversations: s.conversations,
          lastActiveConversationByProject: s.lastActiveConversationByProject,
          bookmarks: s.bookmarks,
        })
      }, 300)
    }

    /** 写 workspace 持久化：被主进程以「过大」拒绝时，按对话裁剪旧消息后重试一次。
     * 长期使用 AI 后对话历史可能超 50MB 上限——整体拒绝会让项目列表/收藏一起停止落盘。 */
    async function persistWorkspace(payload: Parameters<BridgeApi['store']['set']>[1]): Promise<void> {
      const doSet = () => bridge.store.set('workspace', payload)
      try {
        await doSet()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!/过大|超过/.test(msg)) {
          get().notify(`数据保存失败，部分内容可能未写入：${msg}`)
          return
        }
        // 超限：每个对话只保留最近 100 条消息（旧消息在长对话里价值最低），重试一次
        const trimmed = {
          ...(payload as Record<string, unknown>),
          conversations: ((payload as { conversations?: Conversation[] }).conversations ?? []).map((c) => ({
            ...c,
            messages: c.messages.length > 100 ? c.messages.slice(-100) : c.messages,
          })),
        }
        try {
          await bridge.store.set('workspace', trimmed)
          // 成功：本地也同步裁剪（避免下次 persist 再次超限）
          set({
            conversations: ((payload as { conversations?: Conversation[] }).conversations ?? []).map((c) =>
              c.messages.length > 100 ? { ...c, messages: c.messages.slice(-100) } : c,
            ),
          })
          get().notify('对话历史过长，已自动保留每个对话最近 100 条消息')
        } catch (err2) {
          // 裁剪后仍超限：本次会话只提示一次（每次 persist 都弹会形成噪音）
          if (!trimNotified) {
            trimNotified = true
            get().notify(`数据保存失败（对话历史过大且裁剪后仍超限）：${err2 instanceof Error ? err2.message : String(err2)}`)
          }
        }
      }
    }

    /** LOW-3b：应用关闭前同步落盘（取消防抖立即写入，主进程 before-quit 再兜底 flush）。
     * 两个键独立写：settings 失败不阻断 workspace（否则退出时项目/对话整块丢失） */
    async function flushPersist(): Promise<void> {
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
      const s = get()
      const results = await Promise.allSettled([
        bridge.store.set('settings', s.settings),
        persistWorkspace({
          projects: s.projects,
          activeProjectId: s.activeProjectId,
          conversations: s.conversations,
          lastActiveConversationByProject: s.lastActiveConversationByProject,
          bookmarks: s.bookmarks,
        }),
      ])
      for (const r of results) {
        if (r.status === 'rejected') {
          get().notify(`数据保存失败，部分内容可能未写入：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
        }
      }
    }

    async function dirToNode(dirPath: string, expanded: boolean): Promise<TreeNode> {
      const project = activeProject()
      if (!project) throw new Error('当前没有打开的项目')
      const entries = await bridge.project.readDir(project.rootPath, dirPath, get().settings.showHiddenFiles)
      return {
        name: dirPath === project.rootPath ? project.name : basename(dirPath),
        path: dirPath,
        isDirectory: true,
        size: 0,
        mtimeMs: 0,
        expanded,
        children: entries.map((e) => ({
          name: e.name,
          path: e.path,
          isDirectory: e.isDirectory,
          size: e.size,
          mtimeMs: e.mtimeMs,
          expanded: false,
        })),
      }
    }

    return {
      ready: false,
      version: '0.1.0',
      settings: DEFAULT_SETTINGS,
      projects: [],
      activeProjectId: null,
      conversations: [],
      lastActiveConversationByProject: {},
      activeConversationId: null,
      treeRoot: null,
      treeError: null,
      bookmarks: [],
      openTabs: [],
      activeTabId: null,
      editorPos: { line: 1, col: 1 },
      settingsOpen: false,
      commandOpen: false,
      codeTableOpen: false,
      unitLibraryOpen: false,
      valueTypeOpen: false,
      turretEditorOpen: false,
      confirm: null,
      toast: null,
      aiStreamingConversationId: null,
      pendingApproval: null,
      modDialog: null,
      modCheckResult: null,
      optimizeItems: null,
      optimizeError: null,
      updateState: { status: 'idle' },

      async init() {
        // 幂等：进行中/已完成都直接返回，避免重复订阅更新事件；
        // 失败后重置 initPromise，允许后续重试（否则永久卡在「正在启动…」）
        if (initPromise) return initPromise
        initPromise = (async () => {
          const [settings, workspace, info] = await Promise.all([
            bridge.store.get('settings'),
            bridge.store.get('workspace'),
            bridge.appInfo(),
          ])
          const ws = (workspace ?? {}) as Partial<Pick<WorkspaceStoreState, 'projects' | 'activeProjectId' | 'conversations' | 'lastActiveConversationByProject' | 'bookmarks'>>
          set({
            version: info?.version ?? '0.1.0',
            settings: sanitizeSettings(settings),
            projects: Array.isArray(ws.projects) ? ws.projects : [],
            activeProjectId: typeof ws.activeProjectId === 'string' ? ws.activeProjectId : null,
            conversations: Array.isArray(ws.conversations) ? ws.conversations : [],
            lastActiveConversationByProject:
              ws.lastActiveConversationByProject && typeof ws.lastActiveConversationByProject === 'object'
                ? ws.lastActiveConversationByProject
                : {},
            bookmarks: Array.isArray(ws.bookmarks)
              ? (ws.bookmarks as Array<{ path?: string; name?: string; projectId?: string; isDirectory?: boolean }>)
                  // 旧版本收藏没有 projectId/isDirectory：无法归属项目，丢弃避免误操作
                  .filter((b) => typeof b.projectId === 'string' && typeof b.path === 'string')
                  .map((b) => ({ path: b.path as string, name: b.name ?? '', projectId: b.projectId as string, isDirectory: b.isDirectory ?? false }))
              : [],
          })
          const roots = get().projects.map((p) => p.rootPath)
          await bridge.project.registerRoots(roots)
          await get().refreshTree()
          set({ ready: true })

          // M6：订阅主进程的自动更新事件（设置 → 关于 展示状态）
          bridge.app.onUpdateEvent((event) => {
            if (event.type === 'update_available') set({ updateState: { status: 'available', version: event.version } })
            if (event.type === 'update_not_available') set({ updateState: { status: 'not_available', message: `已是最新版本（v${event.currentVersion}）` } })
            if (event.type === 'download_progress') set({ updateState: { status: 'downloading', percent: event.percent } })
            if (event.type === 'downloaded') set({ updateState: { status: 'downloaded', version: event.version } })
            if (event.type === 'update_error') set({ updateState: { status: 'error', message: event.message } })
          })
        })()
        // 失败：重置幂等标记（允许重试），错误抛给调用方处理
        initPromise = initPromise.catch((err) => {
          initPromise = null
          throw err
        })
        return initPromise
      },

      async openProject() {
        const opened = await bridge.project.openFolderDialog()
        if (!opened) return
        const project: ProjectInfo = {
          id: crypto.randomUUID(),
          name: opened.name,
          rootPath: opened.rootPath,
          createdAt: Date.now(),
          lastOpenedAt: Date.now(),
        }
        // 有未保存编辑时先确认（防止静默丢弃）
        await get().confirmDirtySwitch(async () => {
          const others = get().projects.filter((p) => p.rootPath !== opened.rootPath)
          set({
            projects: [project, ...others],
            activeProjectId: project.id,
            openTabs: [],
            activeTabId: null,
            treeRoot: null,
            treeError: null,
            activeConversationId: null,
            modCheckResult: null,
            optimizeItems: null,
            optimizeError: null,
            modDialog: null,
          })
          await get().refreshTree()
          persist()
        })
      },

      /** M6.5 导入 .rwmod：选包+目标目录 → 解压 → 注册为模组项目 */
      async importModProject() {
        try {
          const imported = await bridge.mod.import()
          if (!imported) return
          const prevActiveId = get().activeProjectId // 失败清理时回退到导入前的项目
          const project: ProjectInfo = {
            id: crypto.randomUUID(),
            name: imported.name,
            rootPath: imported.rootPath,
            createdAt: Date.now(),
            lastOpenedAt: Date.now(),
          }
          // 有未保存编辑时先确认（防止静默丢弃）；确认回调里的失败仍走统一 notify。
          // 返回 false = 用户取消或 action 失败：刚解压的目录未被使用，清理掉不留残留
          const ok = await get().confirmDirtySwitch(async () => {
            const others = get().projects.filter((p) => p.rootPath !== imported.rootPath)
            set({
              projects: [project, ...others],
              activeProjectId: project.id,
              openTabs: [],
              activeTabId: null,
              treeRoot: null,
              treeError: null,
              activeConversationId: null,
              modCheckResult: null,
              optimizeItems: null,
              optimizeError: null,
              modDialog: null,
            })
            await get().refreshTree()
            persist()
            get().notify(`已导入模组：${imported.name}（${imported.files ?? 0} 个文件）`)
            // 导入后检测：模组缺少自述文件（mod-info.txt）时自动弹出补全界面
            const root = get().treeRoot
            if (root && !(root.children ?? []).some((c) => c.name === 'mod-info.txt')) {
              set({ modDialog: 'createMod' })
            }
          })
          // 用户取消或导入失败且是解压导入（files 存在）：删除刚解压的目录（主进程只接受本会话创建的），
          // 并同步移除可能已写入的 projects 记录（action 中途失败时 set 已执行但未 persist——
          // 不清理的话后续任何 persist 会把「指向已删目录」的幽灵项目落盘）
          if (!ok && imported.files !== undefined) {
            void bridge.mod.discardImport(imported.rootPath).catch(() => undefined)
            const s2 = get()
            if (s2.projects.some((p) => p.rootPath === imported.rootPath)) {
              set({
                projects: s2.projects.filter((p) => p.rootPath !== imported.rootPath),
                // 回退到导入前的项目（而不是跳回欢迎页）
                activeProjectId: s2.activeProjectId === project.id ? prevActiveId : s2.activeProjectId,
                activeConversationId: s2.activeProjectId === project.id ? (prevActiveId ? s2.lastActiveConversationByProject[prevActiveId] ?? null : null) : s2.activeConversationId,
                // 回退后补刷树：action 中途失败时 treeRoot 已被置 null，不刷新项目 A 会停留在空白中间态
                treeRoot: null,
                treeError: null,
              })
              persist()
              if (prevActiveId) await get().refreshTree()
            }
          }
        } catch (err) {
          get().notify(`导入模组失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      /** M8：注册已存在的目录为新项目（游戏官方示例 / 游戏内模组导入） */
      async addImportedProject(rootPath: string, name: string, message: string) {
        const prev = get()
        const prevActiveId = prev.activeProjectId
        const project: ProjectInfo = {
          id: crypto.randomUUID(),
          name,
          rootPath,
          createdAt: Date.now(),
          lastOpenedAt: Date.now(),
        }
        return get().confirmDirtySwitch(async () => {
          try {
            const others = get().projects.filter((p) => p.rootPath !== rootPath)
            set({
              projects: [project, ...others],
              activeProjectId: project.id,
              openTabs: [],
              activeTabId: null,
              treeRoot: null,
              treeError: null,
              activeConversationId: null,
              modCheckResult: null,
              optimizeItems: null,
              optimizeError: null,
              modDialog: null,
            })
            await get().refreshTree()
            persist()
            get().notify(message)
          } catch (err) {
            // 失败回滚：恢复导入前的项目与树（refreshTree 失败等场景不留「新项目 + 空树」中间态）
            const s2 = get()
            if (s2.projects.some((p) => p.rootPath === rootPath)) {
              set({
                projects: s2.projects.filter((p) => p.rootPath !== rootPath),
                activeProjectId: prevActiveId,
                activeConversationId: prevActiveId ? s2.lastActiveConversationByProject[prevActiveId] ?? null : null,
                treeRoot: null,
                treeError: null,
              })
              persist()
              if (prevActiveId) await get().refreshTree().catch(() => undefined)
            }
            // 不重复 notify：confirmDirtySwitch 统一提示「操作失败」
            throw err
          }
        })
      },

      async selectProject(id: string) {
        // 点击当前已打开的项目：直接忽略，避免误触把全部标签页清空（未保存修改也会丢）
        if (id === get().activeProjectId) return
        const project = get().projects.find((p) => p.id === id)
        if (!project) return
        // 有未保存编辑时先确认（防止静默丢弃）
        await get().confirmDirtySwitch(async () => {
          set({
            activeProjectId: id,
            openTabs: [],
            activeTabId: null,
            treeRoot: null,
            treeError: null,
            activeConversationId: get().lastActiveConversationByProject[id] ?? null,
            // 切换项目时清空上个项目的检查/优化结果与弹窗，防止串数据
            modCheckResult: null,
            optimizeItems: null,
            optimizeError: null,
            modDialog: null,
          })
          await get().refreshTree()
          persist()
        })
      },

      removeProject(id: string) {
        const s = get()
        // 同步清理该项目的“最后活跃对话”记录，避免残留占用
        const lastActive = { ...s.lastActiveConversationByProject }
        delete lastActive[id]
        set({
          projects: s.projects.filter((p) => p.id !== id),
          conversations: s.conversations.filter((c) => c.projectId !== id),
          lastActiveConversationByProject: lastActive,
          openTabs: [],
          activeTabId: null,
          treeRoot: null,
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
          activeConversationId: s.activeProjectId === id ? null : s.activeConversationId,
        })
        persist()
      },

      async refreshTree() {
        const pid = get().activeProjectId
        const project = pid ? get().projects.find((p) => p.id === pid) ?? null : null
        if (!project) {
          set({ treeRoot: null, treeError: null })
          return
        }
        // 整树重建：旧的目录加载序号全部作废（防 Map 无限累积）
        dirLoadSeqs.clear()
        // 项目内容可能已变化：清空补全资源缓存，下次输入重新扫描
        invalidateResourceCache()
        // 记录当前展开的目录，刷新后恢复（避免整棵树塌回根目录）
        const expanded = new Set<string>()
        const collect = (n: TreeNode | null | undefined): void => {
          if (!n) return
          if (n.isDirectory && n.expanded) expanded.add(n.path)
          n.children?.forEach(collect)
        }
        collect(get().treeRoot)
        try {
          const root = await dirToNode(project.rootPath, true)
          // 刷新期间切换了项目：丢弃过期响应，防止旧项目树覆盖新项目
          if (get().activeProjectId !== pid) return
          set({ treeRoot: root, treeError: null })
          // 恢复展开状态：先把展开标志写回（loadDir 只更新数据），再逐层重新读取
          if (expanded.size > 0) {
            const loadRecursively = async (children: TreeNode[]): Promise<void> => {
              for (const child of children) {
                if (!child.isDirectory || !expanded.has(child.path)) continue
                const cur = get().treeRoot
                if (cur) set({ treeRoot: updateTreeNode(cur, child.path, (n) => ({ ...n, expanded: true })) })
                await get().loadDir(child)
                const fresh = get().treeRoot ? findTreeNode(get().treeRoot, child.path) : null
                if (fresh?.children) await loadRecursively(fresh.children)
              }
            }
            await loadRecursively(root.children ?? [])
          }
        } catch (err) {
          if (get().activeProjectId !== pid) return
          set({ treeError: err instanceof Error ? err.message : String(err), treeRoot: null })
        }
      },

      async loadDir(node: TreeNode) {
        const pid = get().activeProjectId
        const project = activeProject()
        if (!project) return
        const root = get().treeRoot
        if (!root) return
        // 同目录并发守卫：快速连续增删/刷新时，较旧的一次 readDir 响应
        // 可能最后落地覆盖新结果——按路径记请求序号，只接受最新一次
        const seq = (dirLoadSeqs.get(node.path) ?? 0) + 1
        dirLoadSeqs.set(node.path, seq)
        set({ treeRoot: updateTreeNode(root, node.path, (n) => ({ ...n, loading: true, error: undefined })) })
        try {
          const entries = await bridge.project.readDir(project.rootPath, node.path, get().settings.showHiddenFiles)
          if (get().activeProjectId !== pid) return // 期间切换了项目：丢弃
          if (dirLoadSeqs.get(node.path) !== seq) return // 已有更新的加载：丢弃过期响应
          const cur = get().treeRoot
          if (!cur) return // 树被清空（如切换项目）：丢弃
          set({
            treeRoot: updateTreeNode(cur, node.path, (n) => ({
              ...n,
              loading: false,
              children: entries.map((e) => ({
                name: e.name,
                path: e.path,
                isDirectory: e.isDirectory,
                size: e.size,
                mtimeMs: e.mtimeMs,
                expanded: false,
              })),
            })),
          })
        } catch (err) {
          if (get().activeProjectId !== pid) return
          if (dirLoadSeqs.get(node.path) !== seq) return // 过期响应：不覆盖
          const cur = get().treeRoot
          if (!cur) return
          set({
            treeRoot: updateTreeNode(cur, node.path, (n) => ({
              ...n,
              loading: false,
              error: err instanceof Error ? err.message : String(err),
            })),
          })
        }
      },

      /** 展开/收起文件夹；首次展开时懒加载子目录 */
      toggleDir(path: string) {
        const root = get().treeRoot
        if (!root) return
        const node = findTreeNode(root, path)
        if (!node) return
        // 先切换展开状态，再触发懒加载：避免 loadDir 的 loading 标记被旧快照覆盖（显示闪回「尚未加载」）
        set({ treeRoot: updateTreeNode(root, path, (n) => ({ ...n, expanded: !n.expanded })) })
        if (!node.expanded && node.children === undefined && !node.loading) {
          void get().loadDir(node)
        }
      },

      /** 局部刷新树节点：只重读指定目录（其下增删改后调用）。
       * 未加载过子项的目录跳过（首次展开时懒加载兜底），避免无谓的整树重读。 */
      async reloadDirNode(path: string) {
        const root = get().treeRoot
        if (!root) return
        const node = findTreeNode(root, path)
        if (!node || !node.isDirectory || node.children === undefined) return
        await get().loadDir(node)
      },

      async openFile(path: string) {
        const pid = get().activeProjectId
        const project = activeProject()
        if (!project) return
        const existing = get().openTabs.find((t) => t.path === path)
        if (existing) {
          set({ activeTabId: existing.id })
          return
        }
        try {
          await loadCodeData()
          const result = await bridge.project.readFile(project.rootPath, path)
          // 读取期间切换了项目：丢弃，别把旧项目的标签塞进新会话
          if (get().activeProjectId !== pid) return
          // 读取期间可能已被并发打开：复用已有标签
          const again = get().openTabs.find((t) => t.path === path)
          if (again) {
            set({ activeTabId: again.id })
            return
          }
          const translationEnabled = get().settings.translateMode
          const original = result.content
          // 翻译追踪表：记录「中文显示串 → 原始英文串」，保存时精确还原（含大小写），
          // 未追踪的中文（文件里原有的中文数据/用户手写）保留不动，防止保存改写数据
          const dict = makeDict(getEnToZhDict(), getZhToEnDict())
          const tracker = new Map<string, string>()
          const view = translationEnabled ? enToZh(original, dict, tracker) : original
          const tab: EditorTab = {
            id: crypto.randomUUID(),
            path,
            name: basename(path),
            content: view,
            original,
            hasBom: result.hasBom,
            dirty: false,
            translationEnabled,
            translationMap: translationEnabled ? tracker : undefined,
            size: result.size,
            mtimeMs: result.mtimeMs,
          }
          set({ openTabs: [...get().openTabs, tab], activeTabId: tab.id })
        } catch (err) {
          get().notify(`无法打开文件：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      updateTabContent(id: string, content: string) {
        set({
          openTabs: get().openTabs.map((t) => {
            if (t.id !== id) return t
            if (t.content === content) return t // 内容未变：跳过回译与脏标记计算
            // 脏标记按「回译后是否等于磁盘原文」计算：
            // 切换翻译模式只是换视图，不产生未保存修改；中文数据写回后仍是中文，不误标脏
            // 快速路径：英文模式直接字符串比较（O(n) 无正则开销），翻译模式才做全量回译
            const toDisk = t.translationEnabled ? zhToEn(content, makeDict(getEnToZhDict(), getZhToEnDict()), t.translationMap) : content
            return { ...t, content, dirty: toDisk !== t.original }
          }),
        })
      },

      async saveTab(id: string): Promise<boolean> {
        const project = activeProject()
        const tab = get().openTabs.find((t) => t.id === id)
        if (!project || !tab) return false
        try {
          const disk = await bridge.project.readFile(project.rootPath, tab.path)
          if (disk.mtimeMs !== tab.mtimeMs || disk.size !== tab.size) {
            set({ openTabs: get().openTabs.map((t) => t.id === id ? { ...t, externalChanged: true } : t) })
            get().notify('文件已被外部修改，已阻止覆盖；请点击「重新加载」或确认后再次保存')
            return false
          }
          // 翻译模式下：先把显示内容转回英文再写盘（追踪表精确还原；未追踪中文保留），并更新快照
          const dict = makeDict(getEnToZhDict(), getZhToEnDict())
          const toWrite = tab.translationEnabled ? zhToEn(tab.content, dict, tab.translationMap) : tab.content
          await bridge.project.writeFile(project.rootPath, tab.path, toWrite, { hasBom: tab.hasBom })
          const savedMeta = await bridge.project.readFile(project.rootPath, tab.path)
          set({
            openTabs: get().openTabs.map((t) => {
              if (t.id !== id) return t
              // L1：保存期间用户可能已继续输入——比较「当前内容的回译」与「写盘内容」，
              // 在途编辑仍保持脏标记（否则会被误标为已保存、关闭时静默丢失）
              const dict2 = makeDict(getEnToZhDict(), getZhToEnDict())
              const currentDisk = t.translationEnabled ? zhToEn(t.content, dict2, t.translationMap) : t.content
              return {
                ...t,
                original: toWrite,
                dirty: currentDisk !== toWrite,
                size: savedMeta.size,
                mtimeMs: savedMeta.mtimeMs,
                externalChanged: false,
              }
            }),
          })
          invalidateResourceCache()
          get().notify(`已保存 ${tab.name}`)
          return true
        } catch (err) {
          get().notify(`保存失败：${err instanceof Error ? err.message : String(err)}`)
          return false
        }
      },

      /** 重新加载标签页（丢弃本地修改）：用于文件被外部工具修改后，回到磁盘最新内容 */
      async reloadTab(id: string) {
        const project = activeProject()
        const tab = get().openTabs.find((t) => t.id === id)
        if (!project || !tab) return
        try {
          const result = await bridge.project.readFile(project.rootPath, tab.path)
          const translationEnabled = tab.translationEnabled
          const original = result.content
          const dict = makeDict(getEnToZhDict(), getZhToEnDict())
          const tracker = new Map<string, string>()
          const view = translationEnabled ? enToZh(original, dict, tracker) : original
          set({
            openTabs: get().openTabs.map((t) =>
              t.id === id
                ? {
                    ...t,
                    content: view,
                    original,
                    hasBom: result.hasBom, // 外部修改可能增删 BOM：一并刷新
                    translationMap: translationEnabled ? tracker : undefined,
                    dirty: false,
                    externalChanged: false,
                    size: result.size,
                    mtimeMs: result.mtimeMs,
                  }
                : t,
            ),
          })
          get().notify(`已重新加载 ${tab.name}（本地修改已丢弃）`)
        } catch (err) {
          get().notify(`重新加载失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      /** 切换翻译模式：基于当前显示内容转换，不丢失编辑（旧版 bug 的修复） */
      async checkExternalChanges() {
        const project = activeProject()
        if (!project) return
        for (const tab of get().openTabs) {
          // 图片/音频标签没有文本内容可被外部改动破坏，跳过轮询（省去无意义的全量读取）
          if (isPreviewableImage(tab.path) || isPreviewableAudio(tab.path)) continue
          // 正在编辑中的标签（有未保存修改）：磁盘变化不影响用户内容，跳过全量读取
          if (tab.dirty) continue
          try {
            // 只读元数据（stat）：此前每 3 秒对每个打开文件全量读盘 + IPC 传输，
            // 同时开多个大文件时主进程持续高负载
            const meta = await bridge.project.stat(project.rootPath, tab.path)
            if (meta.mtimeMs !== tab.mtimeMs || meta.size !== tab.size) {
              set({ openTabs: get().openTabs.map((t) => t.id === tab.id ? { ...t, externalChanged: true } : t) })
            }
          } catch {
            // 文件被删除/不可读：标记外部变化，让用户决定重新加载
            set({ openTabs: get().openTabs.map((t) => t.id === tab.id ? { ...t, externalChanged: true } : t) })
          }
        }
      },

      toggleTranslation(id: string) {
        const tab = get().openTabs.find((t) => t.id === id)
        if (!tab) return
        const dict = makeDict(getEnToZhDict(), getZhToEnDict())
        const tracker = tab.translationMap ?? new Map<string, string>()
        const content = tab.translationEnabled ? zhToEn(tab.content, dict, tracker) : enToZh(tab.content, dict, tracker)
        // 脏标记按切换后「回译是否等于磁盘原文」计算（切换视图本身不是编辑）
        const toDisk = tab.translationEnabled ? content : zhToEn(content, dict, tracker)
        set({
          openTabs: get().openTabs.map((t) =>
            t.id === id ? { ...t, translationEnabled: !t.translationEnabled, content, translationMap: tracker, dirty: toDisk !== t.original } : t,
          ),
        })
      },

      closeTab(id: string) {
        const tabs = get().openTabs
        const index = tabs.findIndex((t) => t.id === id)
        const next = tabs.filter((t) => t.id !== id)
        set({
          openTabs: next,
          activeTabId: get().activeTabId === id ? (next[Math.min(index, next.length - 1)]?.id ?? null) : get().activeTabId,
        })
      },

      setActiveTabId(id: string) {
        set({ activeTabId: id })
      },

      async createFile(parentPath: string, name: string) {
        const project = activeProject()
        const root = get().treeRoot
        if (!project || !root) return
        try {
          await bridge.project.createFile(project.rootPath, parentPath, name)
          // 局部刷新父目录：嵌套目录里新建的文件立即可见（整树重读会丢展开状态）
          await get().reloadDirNode(parentPath)
          invalidateResourceCache() // 新文件要能出现在 @file 补全里
          get().notify(`已创建 ${name}`)
        } catch (err) {
          get().notify(`创建失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async createFolder(parentPath: string, name: string) {
        const project = activeProject()
        const root = get().treeRoot
        if (!project || !root) return
        try {
          await bridge.project.createFolder(project.rootPath, parentPath, name)
          await get().reloadDirNode(parentPath)
          get().notify(`已创建文件夹 ${name}`)
        } catch (err) {
          get().notify(`创建失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async renameItem(targetPath: string, newName: string) {
        const project = activeProject()
        const root = get().treeRoot
        if (!project || !root) return
        const newPath = targetPath.replace(/[^\\/]+$/, newName)
        const parentPath = targetPath.replace(/[\\/][^\\/]+$/, '')
        try {
          await bridge.project.rename(project.rootPath, targetPath, newPath)
          set({
            // 标签同步改名（文件夹重命名时其内部文件的标签路径也要跟着改，否则保存指向失效路径）
            openTabs: get().openTabs.map((t) =>
              t.path === targetPath || t.path.startsWith(targetPath + '\\') || t.path.startsWith(targetPath + '/')
                ? { ...t, path: t.path.replace(targetPath, newPath), name: t.path === targetPath ? newName : t.name }
                : t,
            ),
            // 收藏同步改名（文件夹重命名时子项前缀也变）
            bookmarks: get().bookmarks.map((b) =>
              b.projectId === project.id && (b.path === targetPath || b.path.startsWith(targetPath + '\\') || b.path.startsWith(targetPath + '/'))
                ? { ...b, path: b.path.replace(targetPath, newPath) }
                : b,
            ),
          })
          // 局部刷新父目录（嵌套目录里的重命名立即可见）
          await get().reloadDirNode(parentPath)
          invalidateResourceCache()
          get().notify(`已重命名为 ${newName}`)
        } catch (err) {
          get().notify(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async deleteItem(targetPath: string) {
        const project = activeProject()
        const root = get().treeRoot
        if (!project || !root) return
        const parentPath = targetPath.replace(/[\\/][^\\/]+$/, '')
        try {
          await bridge.project.delete(project.rootPath, targetPath)
          // 删除文件夹时其内部文件的标签一并关闭（前缀匹配，与收藏清理一致）
          const remaining = get().openTabs.filter(
            (t) => !(t.path === targetPath || t.path.startsWith(targetPath + '\\') || t.path.startsWith(targetPath + '/')),
          )
          set({
            openTabs: remaining,
            // 删除的是当前活动标签：回退到相邻标签，避免编辑器区域空白
            activeTabId: remaining.some((t) => t.id === get().activeTabId) ? get().activeTabId : (remaining[0]?.id ?? null),
            // 删除文件夹时其内部收藏一并清理（前缀匹配）
            bookmarks: get().bookmarks.filter(
              (b) => !(b.projectId === project.id && (b.path === targetPath || b.path.startsWith(targetPath + '\\') || b.path.startsWith(targetPath + '/'))),
            ),
          })
          // 局部刷新父目录（嵌套目录里的删除立即可见，已展开的子树同步清理）
          await get().reloadDirNode(parentPath)
          invalidateResourceCache()
          get().notify('已移入回收站')
        } catch (err) {
          get().notify(`删除失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      toggleBookmark(path: string, isDirectory: boolean) {
        const projectId = get().activeProjectId
        if (!projectId) return
        const list = get().bookmarks
        const exists = list.some((b) => b.path === path && b.projectId === projectId)
        const name = path.split(/[\\/]/).pop() ?? path
        if (exists) {
          set({ bookmarks: list.filter((b) => !(b.path === path && b.projectId === projectId)) })
        } else {
          set({ bookmarks: [...list, { path, name, projectId, isDirectory }] })
        }
        persist()
        get().notify(exists ? '已取消收藏' : `已收藏 ${name}`)
      },

      isBookmarked(path: string) {
        return get().bookmarks.some((b) => b.path === path && b.projectId === get().activeProjectId)
      },

      createConversation() {
        const projectId = get().activeProjectId
        if (!projectId) return
        const projectConversations = get().conversations.filter((c) => c.projectId === projectId)
        const now = Date.now()
        const conversation: Conversation = {
          id: crypto.randomUUID(),
          projectId,
          title: nextConversationTitle(projectConversations),
          createdAt: now,
          updatedAt: now,
          archived: false,
          messages: [],
        }
        set({
          conversations: [...get().conversations, conversation],
          activeConversationId: conversation.id,
          lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [projectId]: conversation.id },
        })
        persist()
        get().notify(`已创建「${conversation.title}」`)
      },

      renameConversation(id: string, title: string) {
        const trimmed = title.trim()
        if (!trimmed) return
        set({
          conversations: get().conversations.map((c) => (c.id === id ? { ...c, title: trimmed, updatedAt: Date.now() } : c)),
        })
        persist()
      },

      toggleArchiveConversation(id: string) {
        const s = get()
        const target = s.conversations.find((c) => c.id === id)
        if (!target) return
        const archived = !target.archived
        set({
          conversations: s.conversations.map((c) => (c.id === id ? { ...c, archived, updatedAt: Date.now() } : c)),
        })
        if (archived && s.activeConversationId === id) {
          const projectConvs = get().conversations.filter((c) => c.projectId === target.projectId && !c.archived)
          const next = projectConvs[0]?.id ?? null
          set({
            activeConversationId: next,
            lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [target.projectId]: next },
          })
        }
        persist()
      },

      deleteConversation(id: string) {
        const s = get()
        const target = s.conversations.find((c) => c.id === id)
        set({ conversations: s.conversations.filter((c) => c.id !== id) })
        if (target && s.activeConversationId === id) {
          const projectConvs = get().conversations.filter((c) => c.projectId === target.projectId)
          const next = projectConvs[0]?.id ?? null
          set({
            activeConversationId: next,
            lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [target.projectId]: next },
          })
        }
        persist()
      },

      selectConversation(id: string) {
        const projectId = get().activeProjectId
        if (!projectId) return
        set({
          activeConversationId: id,
          lastActiveConversationByProject: { ...get().lastActiveConversationByProject, [projectId]: id },
        })
        persist()
      },

      updateSettings(patch: Partial<AppSettings>) {
        set({ settings: sanitizeSettings({ ...get().settings, ...patch }) })
        persist()
      },

      setEditorPos(pos: EditorPosition) {
        set({ editorPos: pos })
      },

      setSettingsOpen(open: boolean) {
        set({ settingsOpen: open })
      },
      setCommandOpen(open: boolean) {
        set({ commandOpen: open })
      },
      setCodeTableOpen(open: boolean) {
        set({ codeTableOpen: open })
      },
      setUnitLibraryOpen(open: boolean) {
        set({ unitLibraryOpen: open })
      },
      setValueTypeOpen(open: boolean) {
        set({ valueTypeOpen: open })
      },
      setTurretEditorOpen(open: boolean) {
        set({ turretEditorOpen: open })
      },

      async respondApproval(approved: boolean) {
        const req = get().pendingApproval
        if (!req) return
        set({ pendingApproval: null })
        try {
          const accepted = await bridge.ai.approve({ id: req.id, approved })
          if (!accepted) {
            // 120s 超时边缘：主进程已按拒绝处理，本次点击未生效——明确告知，避免用户以为写入了
            get().notify(approved ? '审批已过期（超过 120 秒未响应），本次写入未执行' : '审批已过期，已按拒绝处理')
          }
          // AI 写文件后刷新文件树与补全缓存：新文件/修改要立即可见，否则 @file 补全查不到
          if (approved && accepted) {
            invalidateResourceCache()
            await get().refreshTree()
          }
        } catch (err) {
          get().notify(`审批处理失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      requestConfirm(req: ConfirmRequest) {
        set({ confirm: req })
      },
      dismissConfirm() {
        set({ confirm: null })
      },

  /** 有未保存编辑时先确认再执行动作（切项目/导模组前调用，防止静默丢编辑）。
   * 提供「保存并切换」：全部保存成功才执行 action，任一失败则保留现状。
   * 返回 Promise<boolean>：true = 已执行 action；false = 用户取消或 action 失败
   * （两种情形都统一 notify 失败原因；调用方按「取消」同路径善后，
   * 如丢弃刚导入的残留目录——action 失败时同样需要清理）。 */
  confirmDirtySwitch(action: () => Promise<void> | void): Promise<boolean> {
    const s = get()
    const dirtyTabs = s.openTabs.filter((t) => t.dirty)
    if (dirtyTabs.length === 0) {
      // 无脏标签：直接执行；失败时同样 resolve(false) + 提示（与确认路径一致，不抛 rejection）
      return Promise.resolve(action()).then(
        () => true,
        (err: unknown) => {
          get().notify(`操作失败：${err instanceof Error ? err.message : String(err)}`)
          return false
        },
      )
    }
    return new Promise<boolean>((resolve) => {
      const run = (): void => {
        Promise.resolve(action()).then(
          () => resolve(true),
          (err: unknown) => {
            // action 失败：关闭确认框并让调用方感知失败（不静默成功）；
            // 与无脏标签路径一致地提示失败原因（此前这里静默，用户对切换失败无感知）
            s.dismissConfirm()
            get().notify(`操作失败：${err instanceof Error ? err.message : String(err)}`)
            resolve(false)
            console.warn('[workspace] confirmDirtySwitch action 失败', err)
          },
        )
      }
      const names = dirtyTabs.map((t) => t.name)
      const summary = names.length <= 3 ? `「${names.join('」、「')}」` : `${names.length} 个文件`
      s.requestConfirm({
        title: '有未保存的修改',
        message: `${summary}的修改尚未保存，切换后将丢失这些修改。`,
        danger: true,
        confirmText: '放弃并切换',
        cancelText: '取消',
        onCancel: () => resolve(false),
        // 「保存并切换」：全部保存成功才切换，任一失败（外部修改拦截等）则保留弹窗
        saveThen: {
          label: '保存并切换',
          save: async () => {
            for (const t of get().openTabs.filter((x) => x.dirty)) {
              if (!(await get().saveTab(t.id))) return false
            }
            return true
          },
          done: run,
        },
        onConfirm: run,
      })
    })
  },

      async sendAiMessage(conversationId: string, text: string) {
        const s = get()
        const conversation = s.conversations.find((c) => c.id === conversationId)
        const project = s.projects.find((p) => p.id === s.activeProjectId)
        if (!conversation || !project) return
        const now = Date.now()
        const settings = s.settings.ai
        const trimmed = text.trim()
        if (!trimmed) return
        if (s.aiStreamingConversationId) {
          get().notify('AI 正在回复中，请稍候')
          return
        }

        // 1. 加入用户消息
        const userMessage = { id: crypto.randomUUID(), role: 'user' as const, content: trimmed, createdAt: now }
        set({
          conversations: s.conversations.map((c) =>
            c.id === conversationId ? { ...c, messages: [...c.messages, userMessage], updatedAt: now } : c,
          ),
          aiStreamingConversationId: conversationId,
        })
        persist()

        // 活动看门狗：流启动后若主进程崩溃/挂死且无终态事件，AI 通道会被永久锁死。
        // 任意事件（delta/tool/approval）都会重置计时——健康的长流不会被误判超时；
        // 5 分钟无任何事件才触发。触发时注销旧订阅 + 通知主进程 abort（拒绝在途/后续
        // 审批，释放主进程 AI 锁），避免「超时后陈旧审批仍可批准写盘 / 新请求被主进程误拒」
        let unsubscribe: () => void = () => undefined // 订阅句柄（executor 内赋值，guard/终态共用）
        let guardTimer: ReturnType<typeof setTimeout> | null = null
        const armGuard = () => {
          if (guardTimer) clearTimeout(guardTimer)
          guardTimer = setTimeout(() => {
            unsubscribe()
            set({ aiStreamingConversationId: null, pendingApproval: null })
            void bridge.ai.streamAbort().catch(() => {
              // abort 失败：主进程 AI 锁可能未释放，明确告知（否则下次发送被拒且无解释）
              get().notify('AI 通道可能仍被占用：如发送失败请重启应用')
            })
            get().notify('AI 回复超时（5 分钟无响应），已释放输入通道；如有问题请重试')
          }, 5 * 60 * 1000)
        }
        armGuard()
        const clearGuard = () => {
          if (guardTimer) {
            clearTimeout(guardTimer)
            guardTimer = null
          }
        }

        // 2. 加入空的 AI 消息（流式填充）
        const aiMessageId = crypto.randomUUID()
        set({
          conversations: get().conversations.map((c) =>
            c.id === conversationId
              ? { ...c, messages: [...c.messages, { id: aiMessageId, role: 'assistant' as const, content: '', createdAt: Date.now() }] }
              : c,
          ),
        })

        // 3. 组装历史消息（包含本次用户消息与占位 AI 消息）
        const history = get().conversations.find((c) => c.id === conversationId)?.messages ?? []
        const messages = history
          .filter((m) => m.content.length > 0)
          .map((m) => ({ role: m.role, content: m.content }))

        // 4. 流式请求：订阅事件，用 Promise 等待结束
        const appendDelta = (delta: string) => {
          set({
            conversations: get().conversations.map((c) =>
              c.id === conversationId
                ? { ...c, messages: c.messages.map((m) => (m.id === aiMessageId ? { ...m, content: m.content + delta } : m)) }
                : c,
            ),
          })
        }

        await new Promise<void>((resolve) => {
          // P3：onAiEvent 注册同步抛错（契约违反）的防御——不锁死 AI 通道
          try {
            unsubscribe = bridge.ai.onAiEvent((event: AiStreamEvent) => {
            if (event.type === 'delta') { appendDelta(event.text); armGuard() }
            if (event.type === 'reasoning') {
              set({
                conversations: get().conversations.map((c) =>
                  c.id === conversationId
                    ? { ...c, messages: c.messages.map((m) => (m.id === aiMessageId ? { ...m, reasoning: (m.reasoning ?? '') + event.text } : m)) }
                    : c,
                ),
              })
              armGuard()
            }
            if (event.type === 'tool_start') {
              const toolEvent: import('../types/domain').ToolEvent = { id: crypto.randomUUID(), type: 'tool_start', name: event.name, args: event.args, createdAt: Date.now() }
              set({
                conversations: get().conversations.map((c) =>
                  c.id === conversationId ? { ...c, toolEvents: [...(c.toolEvents ?? []), toolEvent] } : c,
                ),
              })
              armGuard()
            }
            if (event.type === 'tool_end') {
              const toolEvent: import('../types/domain').ToolEvent = { id: crypto.randomUUID(), type: 'tool_end', name: event.name, ok: event.ok, summary: event.summary, createdAt: Date.now() }
              set({
                conversations: get().conversations.map((c) =>
                  c.id === conversationId ? { ...c, toolEvents: [...(c.toolEvents ?? []), toolEvent] } : c,
                ),
              })
              armGuard()
            }
            if (event.type === 'approval_request') {
              set({ pendingApproval: { id: event.id, path: event.path, contentPreview: event.contentPreview, contentLength: event.contentLength } })
              armGuard()
            }
            if (event.type === 'approval_expired') {
              // 审批超时（用户未响应）：关闭弹窗，不打扰后续对话
              set({ pendingApproval: get().pendingApproval?.id === event.id ? null : get().pendingApproval })
            }
            if (event.type === 'done') {
              clearGuard()
              unsubscribe()
              set({ aiStreamingConversationId: null })
              resolve()
            }
            if (event.type === 'error') {
              clearGuard()
              unsubscribe()
              set({
                aiStreamingConversationId: null,
                pendingApproval: null,
                conversations: get().conversations.map((c) => c.id === conversationId
                  ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: `AI 请求失败：${event.message}` } : m) }
                  : c),
              })
              get().notify(event.message)
              resolve()
            }
          })
          } catch (err) {
            // onAiEvent 同步抛错：释放 AI 锁并提示（不锁死通道）
            clearGuard()
            const message = `AI 请求失败：${err instanceof Error ? err.message : String(err)}`
            set({
              aiStreamingConversationId: null,
              pendingApproval: null,
              conversations: get().conversations.map((c) => c.id === conversationId
                ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: message } : m) }
                : c),
            })
            get().notify(message)
            resolve()
            return
          }
          // stream 同步抛错（违反契约）的防御：不锁死 AI 通道（aiStreamingConversationId 释放）
          let streamSyncError: unknown = null
          try {
            void bridge.ai
              .stream(
                {
                  provider: settings.provider,
                  model: settings.provider === 'deepseek' ? settings.deepseekModel : settings.communityModel,
                  systemPrompt: RUST_ASSISTANT_SYSTEM_PROMPT,
                  messages,
                },
                settings,
                // 显式传当前项目根：主进程持久化有 300ms 防抖，读 store 可能拿到旧项目
                project.rootPath,
              )
              .catch((err) => {
                clearGuard()
                unsubscribe()
                const message = `AI 请求失败：${err instanceof Error ? err.message : String(err)}`
                set({
                  aiStreamingConversationId: null,
                  pendingApproval: null,
                  conversations: get().conversations.map((c) => c.id === conversationId
                    ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: message } : m) }
                    : c),
                })
                get().notify(message)
                resolve()
              })
          } catch (err) {
            streamSyncError = err
          }
          if (streamSyncError !== null) {
            clearGuard()
            unsubscribe()
            const message = `AI 请求失败：${streamSyncError instanceof Error ? streamSyncError.message : String(streamSyncError)}`
            set({
              aiStreamingConversationId: null,
              pendingApproval: null,
              conversations: get().conversations.map((c) => c.id === conversationId
                ? { ...c, messages: c.messages.map((m) => m.id === aiMessageId ? { ...m, content: message } : m) }
                : c),
            })
            get().notify(message)
            resolve()
          }
        })
        set({
          conversations: get().conversations.map((c) =>
            c.id === conversationId ? { ...c, updatedAt: Date.now() } : c,
          ),
        })
        persist()
      },

      notify(message: string) {
        set({ toast: message })
      },
      dismissToast() {
        set({ toast: null })
      },
      flushPersist,

      // ── M6 自动更新 ─────────────────────────────────────────────
      async checkUpdate() {
        set({ updateState: { status: 'checking' } })
        try {
          const result = await bridge.app.checkUpdate()
          if (result.skipped) {
            set({ updateState: { status: 'not_available', message: result.message ?? '开发模式不检查更新' } })
          }
          // 未 skipped：结果由 onUpdateEvent 事件推送更新
        } catch (err) {
          set({ updateState: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
        }
      },

      async downloadUpdate() {
        try {
          await bridge.app.downloadUpdate()
          set({ updateState: { status: 'downloading', percent: 0 } })
        } catch (err) {
          set({ updateState: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
        }
      },

      installUpdate() {
        void bridge.app.installUpdate()
      },

      // ── M5 模组工具 ─────────────────────────────────────────────
      setModDialog(kind) {
        // 优化弹窗：每次打开都清掉旧扫描结果，由弹窗重新扫描（避免显示过期列表）
        if (kind === 'optimize') set({ optimizeItems: null, optimizeError: null })
        set({ modDialog: kind })
      },

      async createModProject(params) {
        const project = activeProject()
        if (!project) return
        try {
          const { files, musicFailed } = await bridge.mod.create(project.rootPath, params)
          await get().refreshTree()
          const failedTip = musicFailed && musicFailed.length > 0 ? `；${musicFailed.length} 首音乐转换失败：${musicFailed.join('、')}` : ''
          get().notify(`模组已创建：${files.join('、')}${failedTip}`)
        } catch (err) {
          get().notify(`创建模组失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async saveModInfo(data) {
        const project = activeProject()
        if (!project) return
        try {
          await bridge.mod.writeModInfo(project.rootPath, data)
          await get().refreshTree()
          get().notify('模组自述文件已保存')
        } catch (err) {
          get().notify(`保存失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async saveActiveFileAsTemplate(name) {
        const project = activeProject()
        const tab = get().openTabs.find((t) => t.id === get().activeTabId)
        if (!project || !tab) return
        try {
          // 保存模板 = 保存当前编辑内容（中文显示层需先回译成英文，与 saveTab 一致；追踪表精确还原）
          const dict = makeDict(getEnToZhDict(), getZhToEnDict())
          const content = tab.translationEnabled ? zhToEn(tab.content, dict, tab.translationMap) : tab.content
          const { key } = await bridge.mod.saveFileAsTemplate(project.rootPath, tab.path, name, content)
          get().notify(`已保存为模板：${name}（${key}），可在「新建单位」中选择`)
        } catch (err) {
          get().notify(`保存模板失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async createUnitFile(params) {
        const project = activeProject()
        if (!project) return
        try {
          const { path: rel } = await bridge.mod.createUnitFromTemplate(project.rootPath, params)
          await get().refreshTree()
          get().notify(`已创建单位：${rel}`)
        } catch (err) {
          get().notify(`创建单位失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async packModProject() {
        // 打开打包选项弹窗（由 ModToolModals 渲染），确认后调用 packModWithOptions
        set({ modDialog: 'pack' })
      },

      async packModWithOptions(options) {
        const project = activeProject()
        if (!project) return
        set({ modDialog: null })
        get().notify('正在打包模组…')
        try {
          const result = await bridge.mod.pack(project.rootPath, options)
          if ('canceled' in result && result.canceled) {
            get().notify('已取消打包')
            return
          }
          const mb = (result.size / 1024 / 1024).toFixed(2)
          // LOW-1：指向项目外的链接被跳过时给出提示（不再中止整次打包）
          const skippedTip = result.skippedLinks ? `；已跳过 ${result.skippedLinks} 个指向项目外的链接` : ''
          get().notify(`打包完成：${result.files} 个文件，${mb} MB → ${result.filePath}${skippedTip}`)
        } catch (err) {
          get().notify(`打包失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async checkModProject() {
        const project = activeProject()
        if (!project) return
        try {
          const result = await bridge.mod.check(project.rootPath)
          set({ modCheckResult: result, modDialog: 'check' })
        } catch (err) {
          get().notify(`检查失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async scanOptimizeProject() {
        const project = activeProject()
        if (!project) {
          // LOW-1：无项目时直接显示错误（否则弹窗永远停在「正在扫描」且无重试效果）
          set({ optimizeError: '请先打开一个模组项目，再使用优化工具' })
          return
        }
        const pid = project.id
        // 先清失败状态：重试期间显示「扫描中…」而不是残留错误
        set({ optimizeError: null })
        try {
          const items = await bridge.mod.optimizeScan(project.rootPath)
          // LOW-3a：扫描期间切换了项目——丢弃过期结果，避免旧项目列表覆盖新项目
          if (get().activeProjectId !== pid) return
          // 扫描期间用户可能已手动关闭弹窗（ESC/遮罩）——只更新结果，不强制重开
          set((s) => ({ optimizeItems: items, optimizeError: null, modDialog: s.modDialog }))
        } catch (err) {
          if (get().activeProjectId !== pid) return
          // 失败时保留弹窗并显示错误与重试入口（不再卡在「正在扫描」；不触碰 modDialog，
          // 用户已关闭弹窗则保持关闭）
          set({ optimizeError: err instanceof Error ? err.message : String(err) })
        }
      },

      async applyOptimizeProject(ids: string[]) {
        const project = activeProject()
        if (!project) return
        try {
          const { done, failed } = await bridge.mod.optimizeApply(project.rootPath, ids)
          get().notify(failed > 0 ? `优化完成：${done} 项成功，${failed} 项失败` : `优化完成：共处理 ${done} 项`)
          // L2：只关「优化」弹窗——执行期间用户可能经命令面板打开了别的弹窗，不能误关
          set((s) => ({
            optimizeItems: null,
            optimizeError: null,
            modDialog: s.modDialog === 'optimize' ? null : s.modDialog,
          }))
          await get().refreshTree()
        } catch (err) {
          get().notify(`优化失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      /** 全局操作：对整个模组源文件批量替换/头部附加/尾部附加（返回结果供弹窗展示） */
      async globalOpProject(params: { kind: 'replace' | 'prepend' | 'append'; find?: string; text?: string }) {
        const project = activeProject()
        if (!project) return null
        try {
          const result = await bridge.mod.globalOp(project.rootPath, params)
          // 内容变化：失效补全资源缓存（@file 引用内容可能已变）
          invalidateResourceCache()
          return result
        } catch (err) {
          // 返回 null：弹窗显示错误状态（不显示误导的「0 个文件」成功文案）
          get().notify(`全局操作失败：${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      },
    }
  })
}

/** 应用默认使用的全局仓库（真实桥） */
export const useWorkspaceStore = createWorkspaceStore(getBridge())

/** 便捷选择器 */
export const useActiveProject = () =>
  useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)

export const useSortedConversations = (projectId: string | null) =>
  useWorkspaceStore(
    useShallow((s) => {
      const list = projectId ? s.conversations.filter((c) => c.projectId === projectId) : []
      return sortConversations(list)
    }),
  )

export const useActiveTab = () =>
  useWorkspaceStore((s) => s.openTabs.find((t) => t.id === s.activeTabId) ?? null)

export const useActiveConversation = () =>
  useWorkspaceStore((s) => s.conversations.find((c) => c.id === s.activeConversationId) ?? null)
