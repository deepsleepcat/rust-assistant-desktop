/**
 * 项目与编辑器切片（M26 从 createWorkspaceStore 拆出；M39 巨型函数治理再按域拆分）：
 * - 本文件：createProjectSlice 编排 + 项目管理（打开/导入/切换/移除，未保存编辑确认）
 * - projectTreeSlice：文件树刷新/懒加载/局部刷新
 * - projectTabsSlice：编辑器标签打开/编辑/保存/重载/关闭
 * - projectFilesSlice：文件操作 + 收藏 + confirmDirtySwitch
 * - projectModToolsSlice：模组工具（创建/打包/检查/报告/优化/修复）+ 自动更新
 * - projectShared：域间共享的依赖上下文、翻译辅助与路径工具
 */
import type { StoreApi } from 'zustand'
import type { ProjectInfo } from '../../types/domain'
import type { ModImportKind } from '../../types/bridge'
import type { WorkspaceStore } from '../types'
import { sanitizeSettings } from '../../utils/settings'
import { resetProjectWorkspaceState, type ProjectSliceDeps } from './projectShared'
import { createTreeActions } from './projectTreeSlice'
import { createEditorTabActions } from './projectTabsSlice'
import { createFileActions } from './projectFilesSlice'
import { createModToolActions } from './projectModToolsSlice'

// 路径工具历史导出位置保持不变（EditorArea/ProjectPanel/tests 引用）
export { normPath, pathStartsWith, replacePathPrefix } from './projectShared'
export type { ProjectSliceDeps } from './projectShared'

export function createProjectSlice(deps: ProjectSliceDeps) {
  return (set: StoreApi<WorkspaceStore>['setState'], get: () => WorkspaceStore) => {
    const historyByTab = new Map<string, { undo: string[]; redo: string[] }>()

    const activeProject = (): ProjectInfo | null =>
      get().projects.find((p) => p.id === get().activeProjectId) ?? null

    const ctx = { set, get, deps, historyByTab, activeProject }

    return {
      updateSettings(patch: Partial<WorkspaceStore['settings']>) {
        set({ settings: sanitizeSettings({ ...get().settings, ...patch }) })
        deps.persist()
      },

      ...createProjectActions(ctx),
      ...createTreeActions(ctx),
      ...createEditorTabActions(ctx),
      ...createFileActions(ctx),
      ...createModToolActions(ctx),
    }
  }
}

/** 项目管理动作：打开/导入（含回滚清理）/注册/切换/移除 */
function createProjectActions(ctx: {
  set: StoreApi<WorkspaceStore>['setState']
  get: () => WorkspaceStore
  deps: ProjectSliceDeps
  historyByTab: Map<string, { undo: string[]; redo: string[] }>
  activeProject: () => ProjectInfo | null
}) {
  const { set, get, deps, historyByTab } = ctx
  return {
    async openProject() {
      const opened = await deps.bridge.project.openFolderDialog()
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
        historyByTab.clear()
        const others = get().projects.filter((p) => p.rootPath !== opened.rootPath)
        set({
          projects: [project, ...others],
          activeProjectId: project.id,
          ...resetProjectWorkspaceState(),
        })
        await get().refreshTree()
        deps.persist()
      })
    },

    /** 打开应用内导入类型选择框；实际磁盘选择由 startModImport 在用户选定来源后执行。 */
    async importModProject() {
      set({ modDialog: 'import' })
    },

    /** 导入文件包或文件夹：保留原有脏编辑确认、项目切换与解压回滚语义。 */
    async startModImport(kind: ModImportKind) {
      try {
        const imported = await deps.bridge.mod.import(kind)
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
          historyByTab.clear()
          const others = get().projects.filter((p) => p.rootPath !== imported.rootPath)
          set({
            projects: [project, ...others],
            activeProjectId: project.id,
            ...resetProjectWorkspaceState(),
          })
          await get().refreshTree()
          deps.persist()
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
          void deps.bridge.mod.discardImport(imported.rootPath).catch(() => undefined)
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
            deps.persist()
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
          historyByTab.clear()
          const others = get().projects.filter((p) => p.rootPath !== rootPath)
          set({
            projects: [project, ...others],
            activeProjectId: project.id,
            ...resetProjectWorkspaceState(),
          })
          await get().refreshTree()
          deps.persist()
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
            deps.persist()
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
        historyByTab.clear()
        set({
          activeProjectId: id,
          ...resetProjectWorkspaceState(),
          // 切换回该项目时恢复它上次的活跃对话（其余工作区状态一律重置，防串数据）
          activeConversationId: get().lastActiveConversationByProject[id] ?? null,
        })
        await get().refreshTree()
        deps.persist()
      })
    },

    removeProject(id: string) {
      historyByTab.clear()
      const s = get()
      // 同步清理该项目的“最后活跃对话”记录，避免残留占用
      const lastActive = { ...s.lastActiveConversationByProject }
      delete lastActive[id]
      const removingActive = s.activeProjectId === id
      set({
        projects: s.projects.filter((p) => p.id !== id),
        conversations: s.conversations.filter((c) => c.projectId !== id),
        lastActiveConversationByProject: lastActive,
        openTabs: [],
        activeTabId: null,
        treeRoot: null,
        activeProjectId: removingActive ? null : s.activeProjectId,
        activeConversationId: removingActive ? null : s.activeConversationId,
        // M32：移除项目时清空其检查/优化/报告弹窗与结果（树已清空，弹窗数据不能残留）；
        // M39：translationRepair 一并清理（原版漏抄，串数据）
        modCheckResult: null,
        optimizeItems: null,
        optimizeError: null,
        modDialog: null,
        modReport: null,
        modReportOpen: false,
        modReportError: null,
        modReportProgress: null,
        translationRepairItems: null,
        translationRepairError: null,
      })
      deps.persist()
    },
  }
}
