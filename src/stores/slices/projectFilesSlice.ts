/**
 * 项目切片 → 文件操作与收藏域（M39 巨型函数治理拆分）：
 * 新建文件/文件夹、重命名/删除（标签与收藏同步）、收藏切换、脏切换确认。
 */
import { invalidateResourceCache } from '../../features/editor/completion'
import { normPath, pathStartsWith, replacePathPrefix, type ProjectSliceContext } from './projectShared'

export function createFileActions(ctx: ProjectSliceContext) {
  const { set, get, deps, historyByTab } = ctx
  return {
    async createFile(parentPath: string, name: string) {
      const project = ctx.activeProject()
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
      const project = ctx.activeProject()
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
      const project = ctx.activeProject()
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
      const project = ctx.activeProject()
      const root = get().treeRoot
      if (!project || !root) return
      const parentPath = targetPath.replace(/[\\/][^\\/]+$/, '')
      try {
        await deps.bridge.project.delete(project.rootPath, targetPath)
        // 删除文件夹时其内部文件的标签一并关闭（前缀匹配，与收藏清理一致）
        const removedIds = get().openTabs.filter((t) => pathStartsWith(t.path, targetPath)).map((t) => t.id)
        for (const id of removedIds) historyByTab.delete(id)
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
  }
}
