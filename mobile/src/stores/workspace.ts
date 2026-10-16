/**
 * 手机版工作区状态（zustand）：
 * 项目列表、设置、当前标签页，与桌面版 stores/workspace.ts 的字段语义对齐
 * （projects/activeProjectId/settings），方便未来共享/迁移。
 * 持久化走桥 store（appData/app-state.json，原子写防抖）。
 *
 * 编辑会话只存内存（移动端一次编辑一个文件），字段语义与数据保护规则见
 * features/editor/editSession.ts；会话不写入 app-state.json。
 */
import { create } from 'zustand'
import type { AppSettings, ProjectInfo } from '../types/domain'
import { DEFAULT_SETTINGS, sanitizeSettings } from '../utils/settings'
import { getBridge } from '../services/bridge'
import {
  applyEdit,
  applySaveResult,
  markExternallyChanged,
  type EditSession,
  type PendingSave,
} from '../features/editor/editSession'

export type MobileTab = 'projects' | 'editor' | 'library' | 'inspect' | 'ai' | 'settings'

/**
 * 编辑器跳转请求（检查结果 / 大纲「定位」→ 编辑器）。
 * seq 递增：同一个目标行重复点击也能重新触发。
 */
export interface EditorJumpRequest {
  line: number
  seq: number
}

interface WorkspaceState {
  ready: boolean
  projects: ProjectInfo[]
  activeProjectId: string | null
  activeTab: MobileTab
  settings: AppSettings
  init(): Promise<void>
  setActiveTab(tab: MobileTab): void
  addProject(p: ProjectInfo): void
  removeProject(id: string): void
  setActiveProject(id: string | null): void
  updateSettings(patch: Partial<AppSettings>): void

  // —— 编辑会话（全屏编辑器）——
  /** 当前编辑会话；null = 未打开文件（显示项目文件树） */
  editorSession: EditSession | null
  /** 待消费的跳转请求（编辑器处理完即清空） */
  editorJump: EditorJumpRequest | null
  /** 打开文件进编辑器（会话由 features/editor/openFile.ts 构造） */
  openEditorSession(session: EditSession): void
  updateEditorContent(content: string): void
  /** 写盘成功后收敛会话（保存期间继续输入、已切换文件都安全） */
  applyEditorSaved(pending: PendingSave): void
  /** 整体替换会话（外部修改后选择「重新载入」） */
  replaceEditorSession(session: EditSession): void
  /** 应用内其它写入改动了当前文件（AI 工具写盘）→ 标记为有冲突 */
  markEditorExternallyChanged(): void
  /** 请求编辑器跳转到某行（检查结果「定位」用） */
  requestEditorJump(line: number): void
  clearEditorJump(): void
  closeEditor(): void
}

const STORE_KEYS = {
  workspace: 'workspace',
  settings: 'settings',
} as const

let jumpSeq = 0

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ready: false,
  projects: [],
  activeProjectId: null,
  activeTab: 'projects',
  settings: DEFAULT_SETTINGS,
  editorSession: null,
  editorJump: null,

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

  openEditorSession(session) {
    set({ editorSession: session, editorJump: null })
  },

  updateEditorContent(content) {
    const session = get().editorSession
    if (!session) return
    set({ editorSession: applyEdit(session, content) })
  },

  applyEditorSaved(pending) {
    const session = get().editorSession
    if (!session) return
    set({ editorSession: applySaveResult(session, pending) })
  },

  replaceEditorSession(session) {
    set({ editorSession: session })
  },

  markEditorExternallyChanged() {
    const session = get().editorSession
    if (!session) return
    set({ editorSession: markExternallyChanged(session) })
  },

  requestEditorJump(line) {
    jumpSeq += 1
    set({ editorJump: { line, seq: jumpSeq } })
  },

  clearEditorJump() {
    if (get().editorJump) set({ editorJump: null })
  },

  closeEditor() {
    set({ editorSession: null, editorJump: null })
  },
}))
