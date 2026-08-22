/**
 * 项目切片 → 编辑器标签域（M39 巨型函数治理拆分）：
 * 打开（翻译显示层+中文键修复）、编辑/撤销/重做、保存（外部修改拦截/回译写盘）、
 * 重载、外部修改轮询、翻译切换、关闭（脏确认）。
 */
import type { EditorTab } from '../../types/domain'
import { basename, isPreviewableAudio, isPreviewableImage } from '../../utils/paths'
import { loadCodeData } from '../../services/codeData'
import { enToZh, zhToEn } from '../../services/translation'
import { normalizeKeyValueSeparators } from '../../services/configSyntax'
import { repairIniContent } from '../../services/translationRepair'
import { invalidateResourceCache } from '../../features/editor/completion'
import { normalizeOpenPath } from '../../utils/projectPath'
import { contentForDisk, projectTranslationDict, repairDictionary, sameTabPath, type ProjectSliceContext } from './projectShared'

/** 每标签撤销栈上限（防长编辑会话内存膨胀） */
const MAX_TAB_HISTORY = 100

export function createEditorTabActions(ctx: ProjectSliceContext) {
  const { set, get, deps, historyByTab } = ctx
  return {
    async openFile(path: string) {
      const pid = get().activeProjectId
      const project = ctx.activeProject()
      if (!project) return
      // 路径契约统一：绝对路径（文件树/收藏）原样，相对路径（单位库扫描结果）拼成项目内绝对路径，
      // 否则 bridge 的 requireRealInsideRoot 按 CWD 解析相对路径必然「超出项目目录范围」
      const absPath = normalizeOpenPath(project.rootPath, path)
      const existing = get().openTabs.find((t) => sameTabPath(t.path, absPath))
      if (existing) {
        // M33-社区：从社区浏览中打开文件 → 切回编辑器工作区（文件可见，不留在社区页）
        set({ activeTabId: existing.id, activeSurface: 'editor' })
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
          set({ activeTabId: again.id, activeSurface: 'editor' })
          return
        }
        const translationEnabled = get().settings.translateMode
        const source = result.content
        // 只在内存中修复已经写成中文的已知节名/字段名；这里不触碰磁盘。
        // 用户明确保存时，pendingRepair 会让规范化后的英文键一起写回。
        const repaired = /\.(ini|template)$/i.test(absPath) ? repairIniContent(source, repairDictionary()) : { content: source, changes: [] }
        const original = repaired.content
        // 翻译追踪表：记录「中文显示串 → 原始英文串」，保存时精确还原（含大小写），
        // 未追踪的中文（文件里原有的中文数据/用户手写）保留不动，防止保存改写数据
        const dict = projectTranslationDict()
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
          pendingRepair: repaired.changes.length > 0,
          translationEnabled,
          translationMap: translationEnabled ? tracker : undefined,
          size: result.size,
          mtimeMs: result.mtimeMs,
        }
        historyByTab.delete(tab.id)
        set({ openTabs: [...get().openTabs, tab], activeTabId: tab.id, activeSurface: 'editor' })
      } catch (err) {
        get().notify(`无法打开文件：${err instanceof Error ? err.message : String(err)}`)
      }
    },

    updateTabContent(id: string, content: string, options?: { history?: boolean }) {
      const shouldRecord = options?.history !== false
      const current = get().openTabs.find((tab) => tab.id === id)
      if (!current || current.content === content) return
      if (shouldRecord) {
        const history = historyByTab.get(id) ?? { undo: [], redo: [] }
        history.undo.push(current.content)
        if (history.undo.length > MAX_TAB_HISTORY) history.undo.shift()
        history.redo = []
        historyByTab.set(id, history)
      }
      set({
        openTabs: get().openTabs.map((t) => {
          if (t.id !== id) return t
          // 脏标记按「回译后是否等于磁盘原文」计算；程序同步和用户编辑共用同一比较规则。
          const toDisk = contentForDisk(content, t)
          return { ...t, content, dirty: toDisk !== t.original }
        }),
      })
    },

    undoTab(id: string) {
      const history = historyByTab.get(id)
      const tab = get().openTabs.find((item) => item.id === id)
      if (!history || !tab || history.undo.length === 0) return
      const previous = history.undo.pop()!
      history.redo.push(tab.content)
      historyByTab.set(id, history)
      const toDisk = contentForDisk(previous, tab)
      set({ openTabs: get().openTabs.map((item) => item.id === id ? { ...item, content: previous, dirty: toDisk !== item.original } : item) })
    },

    redoTab(id: string) {
      const history = historyByTab.get(id)
      const tab = get().openTabs.find((item) => item.id === id)
      if (!history || !tab || history.redo.length === 0) return
      const next = history.redo.pop()!
      history.undo.push(tab.content)
      historyByTab.set(id, history)
      const toDisk = contentForDisk(next, tab)
      set({ openTabs: get().openTabs.map((item) => item.id === id ? { ...item, content: next, dirty: toDisk !== item.original } : item) })
    },

    canUndoTab(id: string) {
      return (historyByTab.get(id)?.undo.length ?? 0) > 0
    },

    canRedoTab(id: string) {
      return (historyByTab.get(id)?.redo.length ?? 0) > 0
    },

    async saveTab(id: string, opts?: { force?: boolean }): Promise<boolean> {
      const project = ctx.activeProject()
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
        const toWrite = contentForDisk(tab.content, tab)
        await deps.bridge.project.writeFile(project.rootPath, tab.path, toWrite, { hasBom: tab.hasBom })
        const savedMeta = await deps.bridge.project.readFile(project.rootPath, tab.path)
        set({
          openTabs: get().openTabs.map((t) => {
            if (t.id !== id) return t
            // L1：保存期间用户可能已继续输入——比较「当前内容的回译」与「写盘内容」，
            // 在途编辑仍保持脏标记（否则会被误标为已保存、关闭时静默丢失）
            const currentDisk = contentForDisk(t.content, t)
            return {
              ...t,
              original: toWrite,
              dirty: currentDisk !== toWrite,
              pendingRepair: false,
              size: savedMeta.size,
              mtimeMs: savedMeta.mtimeMs,
              externalChanged: false,
            }
          }),
        })
        invalidateResourceCache()
        const hadPending = tab.pendingRepair
        get().notify(hadPending ? `已保存 ${tab.name}（中文键已写回英文）` : `已保存 ${tab.name}`)
        return true
      } catch (err) {
        get().notify(`保存失败：${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    },

    /** 重新加载标签页（丢弃本地修改）：用于文件被外部工具修改后，回到磁盘最新内容 */
    async reloadTab(id: string) {
      const project = ctx.activeProject()
      const tab = get().openTabs.find((t) => t.id === id)
      if (!project || !tab) return
      try {
        await loadCodeData()
        const result = await deps.bridge.project.readFile(project.rootPath, tab.path)
        const translationEnabled = tab.translationEnabled
        const repaired = /\.(ini|template)$/i.test(tab.path) ? repairIniContent(result.content, repairDictionary()) : { content: result.content, changes: [] }
        const original = repaired.content
        const dict = projectTranslationDict()
        const tracker = new Map<string, string>()
        const view = translationEnabled ? enToZh(original, dict, tracker) : original
        // reload 是磁盘同步边界，不能把被丢弃的旧内容留在即时撤销栈。
        historyByTab.delete(id)
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
                  pendingRepair: repaired.changes.length > 0,
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
      const project = ctx.activeProject()
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
      // 翻译显示层切换是程序同步边界；旧显示文本不应被撤销回灌到新模式。
      historyByTab.delete(id)
      const dict = projectTranslationDict()
      const tracker = tab.translationMap ?? new Map<string, string>()
      const content = tab.translationEnabled ? zhToEn(tab.content, dict, tracker) : enToZh(tab.content, dict, tracker)
      // 脏标记按切换后「回译是否等于磁盘原文」计算（切换视图本身不是编辑）
      const toDisk = normalizeKeyValueSeparators(tab.translationEnabled ? content : zhToEn(content, dict, tracker))
      set({
        openTabs: get().openTabs.map((t) =>
          t.id === id ? { ...t, translationEnabled: !t.translationEnabled, content, translationMap: tracker, dirty: toDisk !== t.original } : t,
        ),
      })
    },

    closeTab(id: string) {
      historyByTab.delete(id)
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
      if (!tab.dirty && !tab.pendingRepair) {
        get().closeTab(id)
        return
      }
      get().requestConfirm({
        title: tab.pendingRepair && !tab.dirty ? '有待写回的翻译修复' : '有未保存的修改',
        message: `「${tab.name}」${tab.pendingRepair && !tab.dirty ? '包含尚未写回磁盘的中文键修复。' : '的修改尚未保存，关闭后将丢失。'}`,
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
  }
}
