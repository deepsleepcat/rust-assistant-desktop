/**
 * 项目切片 → 文件树域（M39 巨型函数治理拆分）：
 * 整树刷新（展开状态恢复）、目录懒加载（并发序号守卫）、展开/收起、局部刷新。
 */
import type { ProjectInfo, TreeNode } from '../../types/domain'
import { findTreeNode, updateTreeNode } from '../../utils/tree'
import { invalidateResourceCache } from '../../features/editor/completion'
import { basename } from '../../utils/paths'
import type { ProjectSliceContext } from './projectShared'

/** loadDir 同目录并发守卫：目录路径 → 最近一次请求序号（旧响应落地前丢弃） */
const dirLoadSeqs = new Map<string, number>()

async function dirToNode(ctx: ProjectSliceContext, dirPath: string, expanded: boolean): Promise<TreeNode> {
  const { get, deps } = ctx
  const project = get().projects.find((p) => p.id === get().activeProjectId) ?? null
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

export function createTreeActions(ctx: ProjectSliceContext) {
  const { set, get, deps } = ctx
  return {
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
        const root = await dirToNode(ctx, project.rootPath, true)
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
      const project: ProjectInfo | null = ctx.activeProject()
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
  }
}
