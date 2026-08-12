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
import { basename } from '../utils/paths'

export interface ConfirmRequest {
  title: string
  message: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
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
  openTabs: EditorTab[]
  activeTabId: string | null
  editorPos: EditorPosition
  settingsOpen: boolean
  commandOpen: boolean
  confirm: ConfirmRequest | null
  toast: string | null
}

interface WorkspaceStoreActions {
  init(): Promise<void>
  openProject(): Promise<void>
  selectProject(id: string): Promise<void>
  removeProject(id: string): void
  refreshTree(): Promise<void>
  loadDir(node: TreeNode): Promise<void>
  toggleDir(path: string): void
  openFile(path: string): Promise<void>
  updateTabContent(id: string, content: string): void
  saveTab(id: string): Promise<void>
  closeTab(id: string): void
  setActiveTabId(id: string): void
  createFile(parentPath: string, name: string): Promise<void>
  createFolder(parentPath: string, name: string): Promise<void>
  renameItem(targetPath: string, newName: string): Promise<void>
  deleteItem(targetPath: string): Promise<void>
  createConversation(): void
  renameConversation(id: string, title: string): void
  toggleArchiveConversation(id: string): void
  deleteConversation(id: string): void
  selectConversation(id: string): void
  updateSettings(patch: Partial<AppSettings>): void
  setEditorPos(pos: EditorPosition): void
  setSettingsOpen(open: boolean): void
  setCommandOpen(open: boolean): void
  requestConfirm(req: ConfirmRequest): void
  dismissConfirm(): void
  notify(message: string): void
  dismissToast(): void
}

export type WorkspaceStore = WorkspaceStoreState & WorkspaceStoreActions

export function createWorkspaceStore(bridge: BridgeApi) {
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  return create<WorkspaceStore>()((set, get) => {
    const activeProject = (): ProjectInfo | null =>
      get().projects.find((p) => p.id === get().activeProjectId) ?? null

    function persist(): void {
      const s = get()
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        void bridge.store.set('settings', s.settings)
        void bridge.store.set('workspace', {
          projects: s.projects,
          activeProjectId: s.activeProjectId,
          conversations: s.conversations,
          lastActiveConversationByProject: s.lastActiveConversationByProject,
        })
      }, 300)
    }

    async function dirToNode(dirPath: string, expanded: boolean): Promise<TreeNode> {
      const project = activeProject()
      if (!project) throw new Error('当前没有打开的项目')
      const entries = await bridge.project.readDir(project.rootPath, dirPath)
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
      openTabs: [],
      activeTabId: null,
      editorPos: { line: 1, col: 1 },
      settingsOpen: false,
      commandOpen: false,
      confirm: null,
      toast: null,

      async init() {
        const [settings, workspace, info] = await Promise.all([
          bridge.store.get('settings'),
          bridge.store.get('workspace'),
          bridge.appInfo(),
        ])
        const ws = (workspace ?? {}) as Partial<Pick<WorkspaceStoreState, 'projects' | 'activeProjectId' | 'conversations' | 'lastActiveConversationByProject'>>
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
        })
        const roots = get().projects.map((p) => p.rootPath)
        await bridge.project.registerRoots(roots)
        await get().refreshTree()
        set({ ready: true })
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
        const others = get().projects.filter((p) => p.rootPath !== opened.rootPath)
        set({
          projects: [project, ...others],
          activeProjectId: project.id,
          openTabs: [],
          activeTabId: null,
          treeRoot: null,
          treeError: null,
          activeConversationId: null,
        })
        await get().refreshTree()
        persist()
      },

      async selectProject(id: string) {
        const project = get().projects.find((p) => p.id === id)
        if (!project) return
        set({
          activeProjectId: id,
          openTabs: [],
          activeTabId: null,
          treeRoot: null,
          treeError: null,
          activeConversationId: get().lastActiveConversationByProject[id] ?? null,
        })
        await get().refreshTree()
        persist()
      },

      removeProject(id: string) {
        const s = get()
        set({
          projects: s.projects.filter((p) => p.id !== id),
          conversations: s.conversations.filter((c) => c.projectId !== id),
          openTabs: [],
          activeTabId: null,
          treeRoot: null,
          activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
          activeConversationId: s.activeProjectId === id ? null : s.activeConversationId,
        })
        persist()
      },

      async refreshTree() {
        const project = activeProject()
        if (!project) {
          set({ treeRoot: null, treeError: null })
          return
        }
        try {
          set({ treeRoot: await dirToNode(project.rootPath, true), treeError: null })
        } catch (err) {
          set({ treeError: err instanceof Error ? err.message : String(err), treeRoot: null })
        }
      },

      async loadDir(node: TreeNode) {
        const project = activeProject()
        if (!project) return
        const root = get().treeRoot
        if (!root) return
        set({ treeRoot: updateTreeNode(root, node.path, (n) => ({ ...n, loading: true, error: undefined })) })
        try {
          const entries = await bridge.project.readDir(project.rootPath, node.path)
          set({
            treeRoot: updateTreeNode(get().treeRoot!, node.path, (n) => ({
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
          set({
            treeRoot: updateTreeNode(get().treeRoot!, node.path, (n) => ({
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
        if (!node.expanded && node.children === undefined && !node.loading) {
          void get().loadDir(node)
        }
        set({ treeRoot: updateTreeNode(root, path, (n) => ({ ...n, expanded: !n.expanded })) })
      },

      async openFile(path: string) {
        const project = activeProject()
        if (!project) return
        const existing = get().openTabs.find((t) => t.path === path)
        if (existing) {
          set({ activeTabId: existing.id })
          return
        }
        try {
          const result = await bridge.project.readFile(project.rootPath, path)
          const tab: EditorTab = {
            id: crypto.randomUUID(),
            path,
            name: basename(path),
            content: result.content,
            original: result.content,
            hasBom: result.hasBom,
            dirty: false,
            size: result.size,
          }
          set({ openTabs: [...get().openTabs, tab], activeTabId: tab.id })
        } catch (err) {
          get().notify(`无法打开文件：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      updateTabContent(id: string, content: string) {
        set({
          openTabs: get().openTabs.map((t) => (t.id === id ? { ...t, content, dirty: content !== t.original } : t)),
        })
      },

      async saveTab(id: string) {
        const project = activeProject()
        const tab = get().openTabs.find((t) => t.id === id)
        if (!project || !tab) return
        try {
          await bridge.project.writeFile(project.rootPath, tab.path, tab.content, { hasBom: tab.hasBom })
          set({
            openTabs: get().openTabs.map((t) =>
              t.id === id ? { ...t, original: t.content, dirty: false, size: new TextEncoder().encode(t.content).length } : t,
            ),
          })
          get().notify(`已保存 ${tab.name}`)
        } catch (err) {
          get().notify(`保存失败：${err instanceof Error ? err.message : String(err)}`)
        }
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
          await get().loadDir(root)
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
          await get().loadDir(root)
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
        try {
          await bridge.project.rename(project.rootPath, targetPath, newPath)
          set({
            openTabs: get().openTabs.map((t) => (t.path === targetPath ? { ...t, path: newPath, name: newName } : t)),
          })
          await get().loadDir(root)
          get().notify(`已重命名为 ${newName}`)
        } catch (err) {
          get().notify(`重命名失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async deleteItem(targetPath: string) {
        const project = activeProject()
        const root = get().treeRoot
        if (!project || !root) return
        try {
          await bridge.project.delete(project.rootPath, targetPath)
          set({ openTabs: get().openTabs.filter((t) => t.path !== targetPath) })
          await get().loadDir(root)
          get().notify('已移入回收站')
        } catch (err) {
          get().notify(`删除失败：${err instanceof Error ? err.message : String(err)}`)
        }
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

      requestConfirm(req: ConfirmRequest) {
        set({ confirm: req })
      },
      dismissConfirm() {
        set({ confirm: null })
      },

      notify(message: string) {
        set({ toast: message })
      },
      dismissToast() {
        set({ toast: null })
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
