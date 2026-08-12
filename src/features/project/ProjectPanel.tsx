/**
 * 左侧「文件」面板：当前项目的文件树。
 * - 文件夹懒加载（展开时才读取子目录）
 * - 双击文件在中间编辑器打开
 * - 悬停操作：重命名、删除（回收站）
 * - 顶部工具栏：刷新、新建文件、新建文件夹
 */
import { useState } from 'react'
import type { TreeNode } from '../../types/domain'
import { useWorkspaceStore } from '../../stores/workspace'
import { FileTypeIcon, FolderIcon, IconChevronRight, IconFilePlus, IconFolderPlus, IconRefresh, IconRename, IconTrash } from '../../components/icons'
import { PromptModal } from '../../components/Modal'

export function ProjectPanel() {
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const treeRoot = useWorkspaceStore((s) => s.treeRoot)
  const treeError = useWorkspaceStore((s) => s.treeError)
  const refreshTree = useWorkspaceStore((s) => s.refreshTree)
  const createFile = useWorkspaceStore((s) => s.createFile)
  const createFolder = useWorkspaceStore((s) => s.createFolder)
  const [dialog, setDialog] = useState<null | { kind: 'file' | 'folder'; parent: string }>(null)
  const [renaming, setRenaming] = useState<null | TreeNode>(null)

  if (!project) {
    return (
      <section className="panel" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel-header">
          <IconFolderOpen2 size={13} />
          文件
        </div>
        <div className="empty-state">
          <span className="emoji">🗂️</span>
          <div>打开一个项目后<br />这里会显示项目文件</div>
        </div>
      </section>
    )
  }

  return (
    <section className="panel" style={{ flex: 1, minHeight: 0 }}>
      <div className="panel-header">
        <IconFolderOpen2 size={13} />
        {project.name}
        <span className="grow" />
        <button className="icon-btn" title="刷新" onClick={() => void refreshTree()}>
          <IconRefresh size={13} />
        </button>
        <button
          className="icon-btn"
          title="新建文件"
          onClick={() => setDialog({ kind: 'file', parent: project.rootPath })}
        >
          <IconFilePlus size={13} />
        </button>
        <button
          className="icon-btn"
          title="新建文件夹"
          onClick={() => setDialog({ kind: 'folder', parent: project.rootPath })}
        >
          <IconFolderPlus size={13} />
        </button>
      </div>
      {treeError ? (
        <div className="tree-error">无法读取项目：{treeError}</div>
      ) : treeRoot ? (
        <div className="tree">
          <TreeRow node={treeRoot} depth={0} onRename={setRenaming} onNewIn={setDialog} />
        </div>
      ) : null}

      {dialog && (
        <PromptModal
          title={dialog.kind === 'file' ? '新建文件' : '新建文件夹'}
          placeholder={dialog.kind === 'file' ? '文件名，例如 units.txt' : '文件夹名称'}
          confirmText="创建"
          onSubmit={(name) => {
            void (dialog.kind === 'file' ? createFile(dialog.parent, name) : createFolder(dialog.parent, name))
            setDialog(null)
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {renaming && (
        <PromptModal
          title={`重命名「${renaming.name}」`}
          initialValue={renaming.name}
          confirmText="重命名"
          onSubmit={(name) => {
            void useWorkspaceStore.getState().renameItem(renaming.path, name)
            setRenaming(null)
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </section>
  )
}

function IconFolderOpen2({ size }: { size?: number }) {
  return <span style={{ display: 'grid', color: 'var(--g-yellow)' }}>{<FolderIcon size={size ?? 13} />}</span>
}

function TreeRow({
  node,
  depth,
  onRename,
  onNewIn,
}: {
  node: TreeNode
  depth: number
  onRename: (node: TreeNode) => void
  onNewIn: (d: { kind: 'file' | 'folder'; parent: string }) => void
}) {
  const selected = useWorkspaceStore((s) => (s.activeTabId ? s.openTabs.some((t) => t.id === s.activeTabId && t.path === node.path) : false))
  const openFile = useWorkspaceStore((s) => s.openFile)
  const deleteItem = useWorkspaceStore((s) => s.deleteItem)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)

  const indent = depth * 14

  if (node.isDirectory) {
    const expanded = node.expanded
    return (
      <>
        <div
          className={`tree-row${selected ? ' selected' : ''}`}
          style={{ paddingLeft: 6 + indent }}
          onClick={() => void useWorkspaceStore.getState().toggleDir(node.path)}
          title={node.path}
        >
          <span className={`chev${expanded ? ' open' : ''}`}>
            <IconChevronRight size={13} />
          </span>
          <FolderIcon size={15} open={expanded} />
          <span className="tree-name">{node.name}</span>
          <span className="row-actions">
            <button className="icon-btn" title="重命名" onClick={(e) => { e.stopPropagation(); onRename(node) }}>
              <IconRename size={12} />
            </button>
            <button
              className="icon-btn"
              title="新建文件"
              onClick={(e) => {
                e.stopPropagation()
                onNewIn({ kind: 'file', parent: node.path })
              }}
            >
              <IconFilePlus size={12} />
            </button>
            <button
              className="icon-btn"
              title="新建文件夹"
              onClick={(e) => {
                e.stopPropagation()
                onNewIn({ kind: 'folder', parent: node.path })
              }}
            >
              <IconFolderPlus size={12} />
            </button>
            <button
              className="icon-btn"
              title="删除（回收站）"
              onClick={(e) => {
                e.stopPropagation()
                requestConfirm({
                  title: '删除到回收站',
                  message: `确定把「${node.name}」整个文件夹移入回收站吗？\n此操作无法在应用内撤销。`,
                  danger: true,
                  confirmText: '删除',
                  onConfirm: () => void deleteItem(node.path),
                })
              }}
            >
              <IconTrash size={12} />
            </button>
          </span>
        </div>
        {expanded &&
          (node.loading ? (
            <div className="tree-row" style={{ paddingLeft: 20 + indent, color: 'var(--text-3)', fontStyle: 'italic' }}>
              加载中…
            </div>
          ) : node.children === undefined ? (
            <div className="tree-row" style={{ paddingLeft: 20 + indent, color: 'var(--text-3)', fontStyle: 'italic' }}>
              尚未加载
            </div>
          ) : (
            node.children.map((child) => (
              <TreeRow key={child.path} node={child} depth={depth + 1} onRename={onRename} onNewIn={onNewIn} />
            ))
          ))}
      </>
    )
  }

  return (
    <div
      className={`tree-row${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 22 + indent }}
      onDoubleClick={() => void openFile(node.path)}
      title={node.path}
    >
      <span className="chev placeholder">
        <IconChevronRight size={13} />
      </span>
      <FileTypeIcon name={node.name} />
      <span className="tree-name">{node.name}</span>
      <span className="row-actions">
        <button className="icon-btn" title="重命名" onClick={() => onRename(node)}>
          <IconRename size={12} />
        </button>
        <button
          className="icon-btn"
          title="删除（回收站）"
          onClick={() =>
            requestConfirm({
              title: '删除到回收站',
              message: `确定把「${node.name}」移入回收站吗？`,
              danger: true,
              confirmText: '删除',
              onConfirm: () => void deleteItem(node.path),
            })
          }
        >
          <IconTrash size={12} />
        </button>
      </span>
    </div>
  )
}
