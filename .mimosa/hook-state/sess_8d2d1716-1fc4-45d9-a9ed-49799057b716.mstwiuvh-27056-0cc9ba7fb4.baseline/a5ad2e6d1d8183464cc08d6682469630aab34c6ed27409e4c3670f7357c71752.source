/**
 * 文件树的纯函数：查找节点、更新节点（不可变更新）。
 */
import type { TreeNode } from '../types/domain'

/** 在树中按路径查找节点 */
export function findTreeNode(root: TreeNode | null, targetPath: string): TreeNode | null {
  if (!root) return null
  if (root.path === targetPath) return root
  for (const child of root.children ?? []) {
    const found = findTreeNode(child, targetPath)
    if (found) return found
  }
  return null
}

/** 不可变地更新一个节点及其祖先链 */
export function updateTreeNode(root: TreeNode, targetPath: string, updater: (node: TreeNode) => TreeNode): TreeNode {
  if (root.path === targetPath) return updater(root)
  if (!root.children) return root
  let changed = false
  const children = root.children.map((child) => {
    const next = updateTreeNode(child, targetPath, updater)
    if (next !== child) changed = true
    return next
  })
  return changed ? { ...root, children } : root
}

/** 展开/收起一个文件夹 */
export function toggleNode(root: TreeNode, targetPath: string): TreeNode {
  return updateTreeNode(root, targetPath, (node) => ({ ...node, expanded: !node.expanded }))
}

/** 统计当前树中有多少个目录（用于空状态判断） */
export function countDirectories(node: TreeNode): number {
  let count = node.isDirectory ? 1 : 0
  for (const child of node.children ?? []) count += countDirectories(child)
  return count
}
