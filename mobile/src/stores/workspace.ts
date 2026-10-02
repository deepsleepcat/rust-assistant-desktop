/**
 * 手机版工作区状态（zustand）：
 * 项目列表、设置、当前标签页，与桌面版 stores/workspace.ts 的字段语义对齐
 * （projects/activeProjectId/settings），方便未来共享/迁移。
 * 持久化走桥 store（appData/app-state.json，原子写防抖）。
 */
import { create } from 'zustand'
import type { AppSettings, ProjectInfo } from '../types/domain'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../utils/settings'
import { getBridge } from '../services/bridge'

export type MobileTab = 'projects' | 'editor' | 'library' | 'inspect' | 'ai' | 'settings'

/** 编辑器打开的标签页（单个文件，移动端一次编辑一个文件） */
export interface EditorFile {
  path: string
  name: string
  content: string
  /** 磁盘英文原文（保存基准） */
  original: string
  hasBom: boolean
  dirty: boolean
}

interface WorkspaceState {
  ready: boolean
  projects: ProjectInfo[]
  activeProjectId: string | null
  activeTab: MobileTab
  settings: AppSettings
  /** 编辑器打开的标签（M3） */
  openFiles: string[]
  /** 当前正在编辑的文件（全屏编辑器） */
  editorFile: EditorFile | null
  init(): Promise<void>
  setActiveTab(tab: MobileTab): void
  addProject(p: ProjectInfo): void
  removeProject(id: string): void
  setActiveProject(id: string | null): void
  updateSettings(patch: Partial<AppSettings>): void
  /** 打开文件进编辑器（读取磁盘内容；中文显示层转换由调用方处理） */
  openEditorFile(path: string, name: string, content: string, original: string, hasBom: boolean): void
  updateEditorContent(content: string): void
  /** 保存当前文件到磁盘（content 为已回译的英文内容；成功后更新快照） */
  markSaved(content: string): void
  closeEditor(): void
}

const STORE_KEYS = {
  workspace: 'workspace',
  settings: 'settings',
} as const

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ready: false,
  projects: [],
  activeProjectId: null,
  activeTab: 'projects',
  settings: DEFAULT_SETTINGS,
  openFiles: [],
  editorFile: null,

  async init() {
    const bridge = getBridge()
    try {
      const [wsRaw, settingsRaw] = await Promise.all([bridge.store.get(STORE_KEYS.workspace), bridge.store.get(STORE_KEYS.settings)])
      const ws = (wsRaw && typeof wsRaw === 'object' ? wsRaw : {}) as { projects?: ProjectInfo[]; activeProjectId?: string | null }
      set({
        ready: true,
        projects: Array.isArray(ws.projects) ? ws.projects : [],
        activeProjectId: typeof ws.activeProjectId === 'string' ? ws.activeProjectId : null,
        settings: sanitizeSettings(settingsRaw),
      })
    } catch (err) {
      console.warn('[workspace] 初始化失败，使用默认值', err)
      set({ ready: true })
    }
  },

  setActiveTab(tab) {
    set({ activeTab: tab })
  },

  addProject(p) {
    const { projects } = get()
    const next = [p, ...projects.filter((x) => x.id !== p.id)]
    set({ projects: next })
    void getBridge().store.set(STORE_KEYS.workspace, { projects: next, activeProjectId: get().activeProjectId })
  },

  removeProject(id) {
    const { projects, activeProjectId } = get()
    const next = projects.filter((p) => p.id !== id)
    const nextActive = activeProjectId === id ? null : activeProjectId
    set({ projects: next, activeProjectId: nextActive })
    void getBridge().store.set(STORE_KEYS.workspace, { projects: next, activeProjectId: nextActive })
  },

  setActiveProject(id) {
    const { projects } = get()
    const next = projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: Date.now() } : p))
    set({ projects: next, activeProjectId: id })
    void getBridge().store.set(STORE_KEYS.workspace, { projects: next, activeProjectId: id })
  },

  updateSettings(patch) {
    const next = sanitizeSettings({ ...get().settings, ...patch })
    set({ settings: next })
    void getBridge().store.set(STORE_KEYS.settings, next)
  },

  openEditorFile(path, name, content, original, hasBom) {
    set({ editorFile: { path, name, content, original, hasBom, dirty: false } })
  },

  updateEditorContent(content) {
    const file = get().editorFile
    if (!file) return
    set({ editorFile: { ...file, content, dirty: true } })
  },

  markSaved(content) {
    const file = get().editorFile
    if (!file) return
    set({ editorFile: { ...file, content, original: content, dirty: false } })
  },

  closeEditor() {
    set({ editorFile: null })
  },
}))
