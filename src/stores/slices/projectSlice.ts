/**
 * 项目与编辑器切片（M26：从 createWorkspaceStore 拆出——原最大剩余块）：
 * - 项目：打开/导入/切换/移除，未保存编辑确认（confirmDirtySwitch）
 * - 文件树：整树刷新/懒加载/展开状态恢复/局部刷新（dirLoadSeqs 并发守卫）
 * - 编辑器标签：打开/编辑/保存（外部修改拦截/翻译回写）/重载/关闭/外部修改轮询
 * - 文件操作：新建/重命名/删除（标签与收藏同步改名/清理）+ 收藏
 * - 模组工具：新建模组/自述文件/模板/单位/打包（含打包后运行前检查）/检查/质量报告/优化/全局操作
 * - 自动更新
 */
import type { StoreApi } from 'zustand'
import type { AppSettings, EditorTab, ProjectInfo, TreeNode } from '../../types/domain'
import type { BridgeApi } from '../../types/bridge'
import type { WorkspaceStore } from '../types'
import { getBridge } from '../../services/bridge'
import { sanitizeSettings } from '../../utils/settings'
import { findTreeNode, updateTreeNode } from '../../utils/tree'
import { basename, isPreviewableAudio, isPreviewableImage } from '../../utils/paths'
import { getEnToZhDict, getKeyZhToEnDict, getZhToEnDict, loadCodeData } from '../../services/codeData'
import { enToZh, makeDict, zhToEn } from '../../services/translation'
import { invalidateResourceCache } from '../../features/editor/completion'
import { normalizeOpenPath } from '../../utils/projectPath'
import { generateModReport as generateModReportFn } from '../../features/modTools/modReport'

export interface ProjectSliceDeps {
  bridge: BridgeApi
  /** 持久化（由组合根注入：防抖写 settings + workspace） */
  persist: () => void
}

/** loadDir 同目录并发守卫：目录路径 → 最近一次请求序号（旧响应落地前丢弃） */
const dirLoadSeqs = new Map<string, number>()

/** 标签路径去重比较：Windows 分隔符/大小写不敏感——
 * 树节点（反斜杠绝对路径）与单位库（joinProjectPath 混合分隔符）打开同一文件
 * 时按字符串比较会变成两个标签，这里统一规范化后比较 */
function sameTabPath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/** 路径归一化（分隔符 → /，小写）：用于前缀匹配与替换定位（\\/ 与大小写均为 1:1 映射，
 * 归一化后的长度与原串一致，slice 索引可直接用于原串） */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 路径前缀匹配（目录 target 匹配自身与子路径；分隔符/大小写不敏感） */
export function pathStartsWith(path: string, target: string): boolean {
  if (path === target) return true
  return normPath(path).startsWith(normPath(target) + '/')
}

/** 替换路径前缀（target 匹配到的最前位置；分隔符/大小写不敏感，替换段保持 replacement 原文） */
export function replacePathPrefix(path: string, target: string, replacement: string): string {
  const idx = normPath(path).indexOf(normPath(target))
  if (idx < 0) return path
  return path.slice(0, idx) + replacement + path.slice(idx + target.length)
}

export function createProjectSlice(deps: ProjectSliceDeps) {
  return (set: StoreApi<WorkspaceStore>['setState'], get: () => WorkspaceStore) => {
    const activeProject = (): ProjectInfo | null =>
      get().projects.find((p) => p.id === get().activeProjectId) ?? null

    async function dirToNode(dirPath: string, expanded: boolean): Promise<TreeNode> {
      const project = activeProject()
      if (!project) throw new Error('当前没有打开的项目')
      const entries = await deps.bridge.project.readDir(project.rootPath, dirPath, get().settings.showHiddenFiles)
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
      updateSettings(patch: Partial<AppSettings>) {
        set({ settings: sanitizeSettings({ ...get().settings, ...patch }) })
        deps.persist()
      },

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
            // M32：切换/导入项目时清空上个项目的报告弹窗（与 selectProject 一致，防串数据）
            modReport: null,
            modReportOpen: false,
            modReportError: null,
            modReportProgress: null,
          })
          await get().refreshTree()
          deps.persist()
        })
      },

      /** M6.5 导入 .rwmod：选包+目标目录 → 解压 → 注册为模组项目 */
      async importModProject() {
        try {
          const imported = await deps.bridge.mod.import()
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
              // M32：切换/导入项目时清空上个项目的报告弹窗（与 selectProject 一致，防串数据）
              modReport: null,
              modReportOpen: false,
              modReportError: null,
              modReportProgress: null,
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
              // M32：切换/导入项目时清空上个项目的报告弹窗（与 selectProject 一致，防串数据）
              modReport: null,
              modReportOpen: false,
              modReportError: null,
              modReportProgress: null,
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
            modReport: null,
            modReportOpen: false,
            modReportError: null,
            modReportProgress: null,
          })
          await get().refreshTree()
          deps.persist()
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
          // M32：移除项目时清空其检查/优化/报告弹窗与结果（树已清空，弹窗数据不能残留）
          modCheckResult: null,
          optimizeItems: null,
          optimizeError: null,
          modDialog: null,
          modReport: null,
          modReportOpen: false,
          modReportError: null,
          modReportProgress: null,
        })
        deps.persist()
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
          const entries = await deps.bridge.project.readDir(project.rootPath, node.path, get().settings.showHiddenFiles)
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
        // 路径契约统一：绝对路径（文件树/收藏）原样，相对路径（单位库扫描结果）拼成项目内绝对路径，
        // 否则 bridge 的 requireRealInsideRoot 按 CWD 解析相对路径必然「超出项目目录范围」
        const absPath = normalizeOpenPath(project.rootPath, path)
        const existing = get().openTabs.find((t) => sameTabPath(t.path, absPath))
        if (existing) {
          set({ activeTabId: existing.id })
          return
        }
        try {
          await loadCodeData()
          const result = await deps.bridge.project.readFile(project.rootPath, absPath)
          // 读取期间切换了项目：丢弃，别把旧项目的标签塞进新会话
          if (get().activeProjectId !== pid) return
          // 读取期间可能已被并发打开：复用已有标签
          const again = get().openTabs.find((t) => sameTabPath(t.path, absPath))
          if (again) {
            set({ activeTabId: again.id })
            return
          }
          const translationEnabled = get().settings.translateMode
          const original = result.content
          // 翻译追踪表：记录「中文显示串 → 原始英文串」，保存时精确还原（含大小写），
          // 未追踪的中文（文件里原有的中文数据/用户手写）保留不动，防止保存改写数据
          const dict = makeDict(getEnToZhDict(), getZhToEnDict(), getKeyZhToEnDict())
          const tracker = new Map<string, string>()
          const view = translationEnabled ? enToZh(original, dict, tracker) : original
          const tab: EditorTab = {
            id: crypto.randomUUID(),
            path: absPath,
            name: basename(absPath),
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
            const toDisk = t.translationEnabled ? zhToEn(content, makeDict(getEnToZhDict(), getZhToEnDict(), getKeyZhToEnDict()), t.translationMap) : content
            return { ...t, content, dirty: toDisk !== t.original }
          }),
        })
      },

      async saveTab(id: string, opts?: { force?: boolean }): Promise<boolean> {
        const project = activeProject()
        const tab = get().openTabs.find((t) => t.id === id)
        if (!project || !tab) return false
        try {
          // 外部修改拦截只在普通保存时生效；force（用户明确「覆盖保存」）跳过检查直接写盘
          if (!opts?.force) {
            const disk = await deps.bridge.project.readFile(project.rootPath, tab.path)
            if (disk.mtimeMs !== tab.mtimeMs || disk.size !== tab.size) {
              set({ openTabs: get().openTabs.map((t) => t.id === id ? { ...t, externalChanged: true } : t) })
              get().notify('文件已被外部修改，已阻止覆盖；可「重新加载」丢弃本地修改，或「覆盖保存」用当前内容覆盖磁盘')
              return false
            }
          }
          // 翻译模式下：先把显示内容转回英文再写盘（追踪表精确还原；未追踪中文保留），并更新快照
          const dict = makeDict(getEnToZhDict(), getZhToEnDict(), getKeyZhToEnDict())
          const toWrite = tab.translationEnabled ? zhToEn(tab.content, dict, tab.translationMap) : tab.content
          await deps.bridge.project.writeFile(project.rootPath, tab.path, toWrite, { hasBom: tab.hasBom })
          const savedMeta = await deps.bridge.project.readFile(project.rootPath, tab.path)
          set({
            openTabs: get().openTabs.map((t) => {
              if (t.id !== id) return t
              // L1：保存期间用户可能已继续输入——比较「当前内容的回译」与「写盘内容」，
              // 在途编辑仍保持脏标记（否则会被误标为已保存、关闭时静默丢失）
              const dict2 = makeDict(getEnToZhDict(), getZhToEnDict(), getKeyZhToEnDict())
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
          const result = await deps.bridge.project.readFile(project.rootPath, tab.path)
          const translationEnabled = tab.translationEnabled
          const original = result.content
          const dict = makeDict(getEnToZhDict(), getZhToEnDict(), getKeyZhToEnDict())
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

      /** 外部修改轮询：只读元数据（stat）对比，避免每 3 秒全量读盘 */
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
            const meta = await deps.bridge.project.stat(project.rootPath, tab.path)
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
        const dict = makeDict(getEnToZhDict(), getZhToEnDict(), getKeyZhToEnDict())
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

      /** 带脏确认的关闭（命令面板等无标签栏上下文入口用）：
       * 有未保存修改时弹全局确认（直接关闭/保存并关闭），防止静默丢编辑 */
      closeTabChecked(id: string) {
        const tab = get().openTabs.find((t) => t.id === id)
        if (!tab) return
        if (!tab.dirty) {
          get().closeTab(id)
          return
        }
        get().requestConfirm({
          title: '有未保存的修改',
          message: `「${tab.name}」的修改尚未保存，关闭后将丢失。`,
          danger: true,
          confirmText: '直接关闭',
          cancelText: '取消',
          onCancel: () => get().dismissConfirm(),
          // 保存成功才关闭：保存被外部修改拦截或失败时保留标签，防止丢未保存修改
          saveThen: {
            label: '保存并关闭',
            save: () => get().saveTab(id),
            done: () => get().closeTab(id),
          },
          onConfirm: () => {
            get().dismissConfirm()
            get().closeTab(id)
          },
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
          await deps.bridge.project.createFile(project.rootPath, parentPath, name)
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
          await deps.bridge.project.createFolder(project.rootPath, parentPath, name)
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
          await deps.bridge.project.rename(project.rootPath, targetPath, newPath)
          set({
            // 标签同步改名（文件夹重命名时其内部文件的标签路径也要跟着改，否则保存指向失效路径；
            // 前缀匹配对分隔符/大小写不敏感——单位库打开的标签可能是正斜杠路径）
            openTabs: get().openTabs.map((t) =>
              pathStartsWith(t.path, targetPath)
                ? {
                    ...t,
                    path: replacePathPrefix(t.path, targetPath, newPath),
                    // M32：重命名对象本身的标签名更新（严格相等会因分隔符/大小写差异
                    // 漏掉——单位库打开的标签是混合分隔符路径，改名后名字仍是旧名）
                    name: normPath(t.path) === normPath(targetPath) ? newName : t.name,
                  }
                : t,
            ),
            // 收藏同步改名（文件夹重命名时子项前缀也变）
            bookmarks: get().bookmarks.map((b) =>
              b.projectId === project.id && pathStartsWith(b.path, targetPath)
                ? { ...b, path: replacePathPrefix(b.path, targetPath, newPath) }
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
          await deps.bridge.project.delete(project.rootPath, targetPath)
          // 删除文件夹时其内部文件的标签一并关闭（前缀匹配，与收藏清理一致）
          const remaining = get().openTabs.filter((t) => !pathStartsWith(t.path, targetPath))
          set({
            openTabs: remaining,
            // 删除的是当前活动标签：回退到相邻标签，避免编辑器区域空白
            activeTabId: remaining.some((t) => t.id === get().activeTabId) ? get().activeTabId : (remaining[0]?.id ?? null),
            // 删除文件夹时其内部收藏一并清理（前缀匹配）
            bookmarks: get().bookmarks.filter(
              (b) => !(b.projectId === project.id && pathStartsWith(b.path, targetPath)),
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
        deps.persist()
        get().notify(exists ? '已取消收藏' : `已收藏 ${name}`)
      },

      isBookmarked(path: string) {
        return get().bookmarks.some((b) => b.path === path && b.projectId === get().activeProjectId)
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

      // ── M5 模组工具 ─────────────────────────────────────────────
      async createModProject(params: { title: string; description?: string; author?: string; version?: string; musicFiles?: string[]; musicExclusive?: boolean; updateUrl?: string }) {
        const project = activeProject()
        if (!project) return
        try {
          const { files, musicFailed } = await deps.bridge.mod.create(project.rootPath, params)
          await get().refreshTree()
          const failedTip = musicFailed && musicFailed.length > 0 ? `；${musicFailed.length} 首音乐转换失败：${musicFailed.join('、')}` : ''
          get().notify(`模组已创建：${files.join('、')}${failedTip}`)
        } catch (err) {
          get().notify(`创建模组失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async saveModInfo(data: { title: string; description?: string; author?: string; version?: string; thumbnail?: string; minVersion?: string; musicFiles: string[]; musicExclusive: boolean; mapsFiles: string[]; mapsExtra: boolean; musicSourceFolder?: string; mapsSourceFolder?: string; updateUrl?: string }) {
        const project = activeProject()
        if (!project) return
        try {
          await deps.bridge.mod.writeModInfo(project.rootPath, data)
          await get().refreshTree()
          get().notify('模组自述文件已保存')
        } catch (err) {
          get().notify(`保存失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async saveActiveFileAsTemplate(name: string) {
        const project = activeProject()
        const tab = get().openTabs.find((t) => t.id === get().activeTabId)
        if (!project || !tab) return
        try {
          // 保存模板 = 保存当前编辑内容（中文显示层需先回译成英文，与 saveTab 一致；追踪表精确还原）
          const dict = makeDict(getEnToZhDict(), getZhToEnDict(), getKeyZhToEnDict())
          const content = tab.translationEnabled ? zhToEn(tab.content, dict, tab.translationMap) : tab.content
          const { key } = await deps.bridge.mod.saveFileAsTemplate(project.rootPath, tab.path, name, content)
          get().notify(`已保存为模板：${name}（${key}），可在「新建单位」中选择`)
        } catch (err) {
          get().notify(`保存模板失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async createUnitFile(params: { name: string; templateKey: string; values: Record<string, string> }) {
        const project = activeProject()
        if (!project) return
        try {
          const { path: rel } = await deps.bridge.mod.createUnitFromTemplate(project.rootPath, params)
          await get().refreshTree()
          get().notify(`已创建单位：${rel}`)
        } catch (err) {
          get().notify(`创建单位失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async packModProject() {
        // M32：打开打包选项弹窗前提示未保存文件——打包读的是磁盘内容，
        // 未保存的编辑不会进产物（不阻塞打包，用户可先保存）
        const dirtyTabs = get().openTabs.filter((t) => t.dirty)
        if (dirtyTabs.length > 0) {
          const names = dirtyTabs.slice(0, 3).map((t) => t.name).join('、')
          get().notify(`⚠ ${dirtyTabs.length} 个文件有未保存修改（${names}${dirtyTabs.length > 3 ? '…' : ''}），打包可能不含最新内容`)
        }
        // 打开打包选项弹窗（由 ModToolModals 渲染），确认后调用 packModWithOptions
        set({ modDialog: 'pack' })
      },

      async packModWithOptions(options: { removeEmptyFiles?: boolean; removeEmptyFolders?: boolean; removeEmptyLines?: boolean; removeComments?: boolean; formatCode?: boolean }) {
        const project = activeProject()
        if (!project) return
        set({ modDialog: null })
        get().notify('正在打包模组…')
        try {
          const result = await deps.bridge.mod.pack(project.rootPath, options)
          if ('canceled' in result && result.canceled) {
            get().notify('已取消打包')
            return
          }
          const mb = (result.size / 1024 / 1024).toFixed(2)
          // LOW-1：指向项目外的链接被跳过时给出提示（不再中止整次打包）
          const skippedTip = result.skippedLinks ? `；已跳过 ${result.skippedLinks} 个指向项目外的链接` : ''
          get().notify(`打包完成：${result.files} 个文件，${mb} MB → ${result.filePath}${skippedTip}`)
          // M12：打包后自动运行前检查（不阻塞；结果持久化到设置「试玩联动」，
          // 失败时追加提示引导去查看/修复——「打包 → 检查 → 进游戏」闭环）
          void getBridge()
            .game.preflight(project.rootPath)
            .then((r) => {
              if (!r) return
              // 打包后项目可能已被关闭/切换：仅当仍是当前项目时才追加失败通知
              // （检查结果本身仍写入设置，供设置页「上次检查」查看）
              const stillActive = get().activeProjectId === project.id
              const errors = r.issues.filter((i) => i.severity === 'error').length
              const warnings = r.issues.filter((i) => i.severity === 'warning').length
              // 经 updateSettings（sanitize + 持久化）
              get().updateSettings({
                gameLastCheck: {
                  at: Date.now(),
                  ok: r.ok,
                  message: r.issues.length === 0 ? '检查通过' : `${errors} 个错误，${warnings} 个警告`,
                },
              })
              if (!r.ok && stillActive) {
                get().notify(`运行前检查发现 ${errors} 个错误（设置 → 试玩联动 查看详情）`)
              }
            })
            .catch(() => undefined)
        } catch (err) {
          get().notify(`打包失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async checkModProject() {
        const project = activeProject()
        if (!project) return
        try {
          const result = await deps.bridge.mod.check(project.rootPath)
          set({ modCheckResult: result, modDialog: 'check' })
        } catch (err) {
          get().notify(`检查失败：${err instanceof Error ? err.message : String(err)}`)
        }
      },

      // M13：生成模组质量报告（全量语义检查汇总；脱敏——仅相对路径）
      async generateModReport() {
        const project = activeProject()
        if (!project || get().modReportBusy) return
        const pid = project.id
        set({ modReportBusy: true, modReportOpen: true, modReportError: null, modReportProgress: null })
        try {
          const report = await generateModReportFn(
            project.rootPath,
            {
              projectName: project.name,
              semanticCheckers: get().settings.semanticCheckers,
              targetVersionName: get().settings.targetGameVersion,
              onProgress: (done, total) => {
                // 生成期间用户可能已切换项目：进度只写给当前项目
                if (get().activeProjectId === pid) set({ modReportProgress: { done, total } })
              },
            },
          )
          // 竞态守卫：生成期间切换项目 → 丢弃旧项目报告（对齐 scanOptimizeProject 模式）
          if (get().activeProjectId !== pid) return
          set({ modReport: report })
        } catch (err) {
          // 保留弹窗内联展示错误（不突然关闭，用户可重试或关闭）
          if (get().activeProjectId === pid) set({ modReportError: err instanceof Error ? err.message : String(err) })
        } finally {
          set({ modReportBusy: false })
        }
      },

      setModReportOpen(open: boolean) {
        set({ modReportOpen: open, modReport: open ? get().modReport : null, modReportError: open ? null : get().modReportError, modReportProgress: open ? get().modReportProgress : null })
      },

      // M13：导出质量报告（文本/JSON；保存位置由系统对话框决定）
      async exportModReport(kind: 'text' | 'json') {
        const report = get().modReport
        if (!report) return
        const { reportToJson, reportToText } = await import('../../features/modTools/modReport')
        const content = kind === 'json' ? reportToJson(report) : reportToText(report)
        // 项目名可能含 Windows 非法文件名字符：清洗后作为建议文件名
        const safeName = report.meta.projectName.replace(/[\\/:*?"<>|]/g, '-').replace(/[\s.]+$/g, '')
        const defaultName = `mod-report-${safeName || 'mod'}-${new Date().toISOString().slice(0, 10)}.${kind === 'json' ? 'json' : 'txt'}`
        try {
          const result = await deps.bridge.project.saveText('导出模组质量报告', defaultName, content)
          if (result.ok) get().notify(`报告已导出：${result.path}`)
          else if (!result.canceled) get().notify(`导出失败：${result.message ?? '未知原因'}`)
        } catch (err) {
          get().notify(`导出失败：${err instanceof Error ? err.message : String(err)}`)
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
          const items = await deps.bridge.mod.optimizeScan(project.rootPath)
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
          const { done, failed } = await deps.bridge.mod.optimizeApply(project.rootPath, ids)
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
          const result = await deps.bridge.mod.globalOp(project.rootPath, params)
          // 内容变化：失效补全资源缓存（@file 引用内容可能已变）
          invalidateResourceCache()
          return result
        } catch (err) {
          // 返回 null：弹窗显示错误状态（不显示误导的「0 个文件」成功文案）
          get().notify(`全局操作失败：${err instanceof Error ? err.message : String(err)}`)
          return null
        }
      },

      // ── M6 自动更新 ─────────────────────────────────────────────
      async checkUpdate() {
        set({ updateState: { status: 'checking' } })
        try {
          const result = await deps.bridge.app.checkUpdate()
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
          await deps.bridge.app.downloadUpdate()
          set({ updateState: { status: 'downloading', percent: 0 } })
        } catch (err) {
          set({ updateState: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
        }
      },

      installUpdate() {
        void deps.bridge.app.installUpdate()
      },
    }
  }
}
