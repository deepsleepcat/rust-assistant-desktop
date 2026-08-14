/**
 * 左侧「文件」面板：当前项目的文件树。
 * - 文件夹懒加载（展开时才读取子目录）
 * - 双击文件在中间编辑器打开
 * - 悬停操作：重命名、删除（回收站）
 * - 顶部工具栏：刷新、新建文件、新建文件夹
 */
import { useState } from 'react'
import type { FileSort, TreeNode } from '../../types/domain'
import { useWorkspaceStore } from '../../stores/workspace'
import { FileTypeIcon, FolderIcon, IconChevronRight } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { PromptModal } from '../../components/Modal'

/** 排序树节点：文件夹始终优先，组内按所选字段（名称/类型/大小/修改时间） */
function sortChildren(children: TreeNode[], sort: FileSort): TreeNode[] {
  const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'zh-CN')
  const cmp: Record<FileSort, (a: TreeNode, b: TreeNode) => number> = {
    name: byName,
    type: (a, b) => {
      const extA = a.name.includes('.') ? a.name.slice(a.name.lastIndexOf('.') + 1).toLowerCase() : ''
      const extB = b.name.includes('.') ? b.name.slice(b.name.lastIndexOf('.') + 1).toLowerCase() : ''
      return extA.localeCompare(extB) || byName(a, b)
    },
    size: (a, b) => b.size - a.size || byName(a, b),
    mtime: (a, b) => b.mtimeMs - a.mtimeMs || byName(a, b),
  }
  const c = cmp[sort]
  const dirs = children.filter((x) => x.isDirectory)
  const files = children.filter((x) => !x.isDirectory)
  return [...dirs].sort(c).concat([...files].sort(c))
}

export function ProjectPanel() {
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const treeRoot = useWorkspaceStore((s) => s.treeRoot)
  const treeError = useWorkspaceStore((s) => s.treeError)
  const refreshTree = useWorkspaceStore((s) => s.refreshTree)
  const createFile = useWorkspaceStore((s) => s.createFile)
  const createFolder = useWorkspaceStore((s) => s.createFolder)
  const setModDialog = useWorkspaceStore((s) => s.setModDialog)
  const packModProject = useWorkspaceStore((s) => s.packModProject)
  const checkModProject = useWorkspaceStore((s) => s.checkModProject)
  const importModProject = useWorkspaceStore((s) => s.importModProject)
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const [dialog, setDialog] = useState<null | { kind: 'file' | 'folder'; parent: string }>(null)
  const [renaming, setRenaming] = useState<null | TreeNode>(null)
  const [modMenu, setModMenu] = useState(false)

  if (!project) {
    return (
      <section className="panel" style={{ flex: 1, minHeight: 0 }}>
        <div className="panel-header">
          <IconFolderOpen2 size={13} />
          文件
        </div>
        <div className="empty-state">
          <AppIcon name="folder" size={28} />
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
        <select
          className="sort-select"
          value={settings.fileSort}
          onChange={(e) => updateSettings({ fileSort: e.target.value as FileSort })}
          title="文件树排序"
        >
          <option value="name">名称</option>
          <option value="type">类型</option>
          <option value="size">大小</option>
          <option value="mtime">修改时间</option>
        </select>
        <button className="icon-btn" title="刷新" onClick={() => void refreshTree()}>
          <AppIcon name="refresh" size={13} />
        </button>
        <button
          className="icon-btn"
          title="新建文件"
          onClick={() => setDialog({ kind: 'file', parent: project.rootPath })}
        >
          <AppIcon name="file" size={14} />
        </button>
        <button
          className="icon-btn"
          title="新建文件夹"
          onClick={() => setDialog({ kind: 'folder', parent: project.rootPath })}
        >
          <AppIcon name="folder" size={14} />
        </button>
        <div className="mod-tools-wrap">
          <button className="icon-btn" title="模组工具" onClick={() => setModMenu((v) => !v)}>
            <AppIcon name="tools" size={13} />
          </button>
          {modMenu && (
            <>
              <div className="mod-tools-menu">
                <button onClick={() => { setModDialog('createMod'); setModMenu(false) }}>模组自述文件</button>
                <button onClick={() => { setModMenu(false); useWorkspaceStore.getState().setUnitLibraryOpen(true) }}>单位库</button>
                <button onClick={() => { setModDialog('createUnit'); setModMenu(false) }}>新建单位</button>
                <button className="mod-action-import" onClick={() => { setModMenu(false); void importModProject() }}><AppIcon name="import" size={16} />导入模组</button>
                <button className="mod-action-pack" onClick={() => { setModMenu(false); void packModProject() }}><AppIcon name="archive" size={16} />打包模组</button>
                <button onClick={() => { setModMenu(false); void checkModProject() }}>检查模组</button>
                <button onClick={() => { setModMenu(false); setModDialog('optimize') }}>优化模组</button>
                <button onClick={() => { setModMenu(false); setModDialog('globalOp') }}>全局操作</button>
                <button onClick={() => { setModMenu(false); useWorkspaceStore.getState().setCodeTableOpen(true) }}>浏览代码表</button>
              </div>
              <div className="mod-tools-mask" onClick={() => setModMenu(false)} />
            </>
          )}
        </div>
      </div>
      {treeError ? (
        <div className="tree-error">无法读取项目：{treeError}</div>
      ) : treeRoot ? (
        <div className="tree">
          <TreeRow node={treeRoot} depth={0} onRename={setRenaming} onNewIn={setDialog} />
        </div>
      ) : null}
      <FavoritesList onOpenFile={(path) => void useWorkspaceStore.getState().openFile(path)} />

      {dialog && (
        <PromptModal
          title={dialog.kind === 'file' ? '新建文件' : '新建文件夹'}
          placeholder={dialog.kind === 'file' ? '文件名，例如 units.txt' : '文件夹名称'}
          confirmText="创建"
          suffixes={dialog.kind === 'file' ? ['.ini', '.template', '.txt'] : undefined}
          validateName
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
          validateName
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
  return <AppIcon name="folder" size={size ?? 13} />
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
  const isBookmarked = useWorkspaceStore((s) => s.bookmarks.some((b) => b.path === node.path && b.projectId === s.activeProjectId))
  const fileSort = useWorkspaceStore((s) => s.settings.fileSort)

  const indent = depth * 14

  /** 复制游戏引用格式的相对路径（ROOT: 前缀，可直接粘进代码引用） */
  const copyRelPath = async () => {
    const s = useWorkspaceStore.getState()
    const project = s.projects.find((p) => p.id === s.activeProjectId)
    if (!project) return
    const rel =
      node.path === project.rootPath
        ? ''
        : node.path
            .slice(project.rootPath.length)
            .replace(/^[\\/]+/, '')
            .replace(/\\/g, '/')
    const text = rel ? `ROOT:${rel}` : 'ROOT:'
    try {
      await navigator.clipboard.writeText(text)
      s.notify(`已复制：${text}`)
    } catch {
      s.notify('复制失败：剪贴板不可用')
    }
  }

  const bookmarkBtn = (
    <button
      className={`icon-btn${isBookmarked ? ' bookmarked' : ''}`}
      title={isBookmarked ? '取消收藏' : '收藏（快速跳转）'}
      onClick={(e) => {
        e.stopPropagation()
        useWorkspaceStore.getState().toggleBookmark(node.path, node.isDirectory)
      }}
    >
      <AppIcon name="star" size={12} />
    </button>
  )

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
            {bookmarkBtn}
            <button className="icon-btn" title="重命名" onClick={(e) => { e.stopPropagation(); onRename(node) }}>
              <AppIcon name="rename" size={12} />
            </button>
            <button
              className="icon-btn"
              title="新建文件"
              onClick={(e) => {
                e.stopPropagation()
                onNewIn({ kind: 'file', parent: node.path })
              }}
            >
              <AppIcon name="add" size={12} />
            </button>
            <button
              className="icon-btn"
              title="复制路径（ROOT: 格式）"
              onClick={(e) => {
                e.stopPropagation()
                void copyRelPath()
              }}
            >
              <AppIcon name="copy" size={12} />
            </button>
            <button
              className="icon-btn"
              title="新建文件夹"
              onClick={(e) => {
                e.stopPropagation()
                onNewIn({ kind: 'folder', parent: node.path })
              }}
            >
              <AppIcon name="add" size={12} />
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
              <AppIcon name="delete" size={12} />
            </button>
          </span>
        </div>
        {expanded &&
          (node.loading ? (
            <div className="tree-row tree-loading" style={{ paddingLeft: 20 + indent, color: 'var(--text-3)', fontStyle: 'italic' }}>
              加载中…
            </div>
          ) : node.error ? (
            <div className="tree-row tree-error-inline" style={{ paddingLeft: 20 + indent }} title={node.error}>
              无法读取：{node.error}
            </div>
          ) : node.children === undefined ? (
            <div className="tree-row" style={{ paddingLeft: 20 + indent, color: 'var(--text-3)', fontStyle: 'italic' }}>
              尚未加载
            </div>
          ) : (
            sortChildren(node.children, fileSort).map((child) => (
              <div className="tree-child" key={child.path}><TreeRow node={child} depth={depth + 1} onRename={onRename} onNewIn={onNewIn} /></div>
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
        {bookmarkBtn}
        <button className="icon-btn" title="复制路径（ROOT: 格式）" onClick={() => void copyRelPath()}>
          <AppIcon name="copy" size={12} />
        </button>
        <button className="icon-btn" title="重命名" onClick={() => onRename(node)}>
          <AppIcon name="rename" size={12} />
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
          <AppIcon name="delete" size={12} />
        </button>
      </span>
    </div>
  )
}

/** 收藏列表：点击文件打开、点击文件夹展开定位（快速跳转；仅显示当前项目的收藏） */
function FavoritesList({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const bookmarks = useWorkspaceStore((s) => s.bookmarks)
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  if (!project) return null
  const mine = bookmarks.filter((b) => b.projectId === project.id)
  if (mine.length === 0) return null

  return (
    <div className="favorites">
      <div className="favorites-head">
        <AppIcon name="star" size={12} />
        收藏
        <span className="favorites-count">{mine.length}</span>
      </div>
      <div className="favorites-list">
        {mine.map((b) => (
          <div
            key={b.path}
            className="favorite-item"
            role="button"
            tabIndex={0}
            title={b.path}
            onClick={() => {
              if (b.isDirectory) {
                // 文件夹：展开/收起该目录
                useWorkspaceStore.getState().toggleDir(b.path)
              } else {
                onOpenFile(b.path)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                if (b.isDirectory) useWorkspaceStore.getState().toggleDir(b.path)
                else onOpenFile(b.path)
              }
            }}
          >
            <AppIcon name={b.isDirectory ? 'folder' : 'file'} size={12} />
            <span className="fav-name">{b.name}</span>
            <span
              className="row-actions"
              onClick={(e) => {
                e.stopPropagation()
                useWorkspaceStore.getState().toggleBookmark(b.path, b.isDirectory)
              }}
            >
              <button className="icon-btn" title="取消收藏">
                <AppIcon name="close" size={11} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
