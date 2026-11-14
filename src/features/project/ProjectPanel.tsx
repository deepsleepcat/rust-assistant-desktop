/**
 * 左侧「项目」面板（合并版）：项目列表与文件树融为一体。
 * - 项目行即树的根行：点击未激活项目切换并就地展开它的文件树（手风琴式，其他项目收起）
 * - 再点激活项目行可折叠/展开其树
 * - 文件夹懒加载（展开时才读取子目录）；双击文件在中间编辑器打开
 * - 悬停操作：项目行=移除记录；文件行=重命名、删除（回收站）、收藏、复制路径
 * - 顶部工具栏：搜索、排序、刷新、新建文件/文件夹、模组工具、导入模组
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileSort, TreeNode } from '../../types/domain'
import { useWorkspaceStore } from '../../stores/workspace'
import { pathStartsWith } from '../../stores/slices/projectSlice'
import { FileTypeIcon, FolderIcon, IconChevronRight } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { BilingualLabel } from '../../components/BilingualLabel'
import { PromptModal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import { formatRelativeTime } from '../../utils/conversation'

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
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const selectProject = useWorkspaceStore((s) => s.selectProject)
  const removeProject = useWorkspaceStore((s) => s.removeProject)
  const importModProject = useWorkspaceStore((s) => s.importModProject)
  const fileSort = useWorkspaceStore((s) => s.settings.fileSort)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const treeRoot = useWorkspaceStore((s) => s.treeRoot)
  const treeError = useWorkspaceStore((s) => s.treeError)
  const refreshTree = useWorkspaceStore((s) => s.refreshTree)
  const createFile = useWorkspaceStore((s) => s.createFile)
  const createFolder = useWorkspaceStore((s) => s.createFolder)
  const setModDialog = useWorkspaceStore((s) => s.setModDialog)
  const packModProject = useWorkspaceStore((s) => s.packModProject)
  const checkModProject = useWorkspaceStore((s) => s.checkModProject)
  const settings = useWorkspaceStore((s) => s.settings)
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const [dialog, setDialog] = useState<null | { kind: 'file' | 'folder'; parent: string }>(null)
  const [renaming, setRenaming] = useState<null | TreeNode>(null)
  const [modMenu, setModMenu] = useState(false)
  const modMenuButton = useRef<HTMLButtonElement>(null)
  const [modMenuPosition, setModMenuPosition] = useState({ left: 0, top: 0 })
  /** 手风琴折叠视图状态：记录被用户手动收起的项目行（键=项目 id），不写入持久化设置 */
  const [collapsedIds, setCollapsedIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!modMenu) return
    const dismiss = () => setModMenu(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { dismiss(); modMenuButton.current?.focus() }
    }
    window.addEventListener('resize', dismiss)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('resize', dismiss); window.removeEventListener('keydown', onKey) }
  }, [modMenu])

  const toggleModMenu = () => {
    const rect = modMenuButton.current?.getBoundingClientRect()
    if (rect) setModMenuPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), top: rect.bottom + 4 })
    setModMenu((open) => !open)
  }
  // M37：文件搜索已并入标题栏命令面板（feat/git-visual-center），左栏只保留文件树。
  const treeRef = useRef<HTMLDivElement>(null)

  // M29：文件树键盘导航（roving tabindex：方向键在行间移动；行内 Enter/空格/左右键处理打开/展开）
  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    const el = treeRef.current
    if (!el) return
    const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-tree-row]'))
    if (rows.length === 0) return
    // M30：焦点可能落在行内操作按钮上——沿 DOM 向上找所属行，避免 indexOf(-1) 跳回第一行
    const activeEl = document.activeElement as HTMLElement | null
    const rowEl = activeEl?.closest?.('[data-tree-row]') as HTMLElement | null
    const idx = rowEl ? rows.indexOf(rowEl) : -1
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      rows[Math.min(idx + 1, rows.length - 1)]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      rows[Math.max(idx - 1, 0)]?.focus()
    }
  }

  /** 项目行点击：未激活 → 切换并展开；已激活 → 折叠/展开其树 */
  const toggleProjectRow = (id: string) => {
    if (id !== activeProjectId) {
      void selectProject(id)
      setCollapsedIds((s) => ({ ...s, [id]: false }))
    } else {
      setCollapsedIds((s) => ({ ...s, [id]: !s[id] }))
    }
  }

  return (
    <section className="panel" style={{ flex: 1, minHeight: 0 }}>
      <div className="panel-header project-panel-toolbar">
        <IconFolderOpen2 size={13} />
        <span className="project-panel-name" title={project?.name}>{project?.name}</span>
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
          onClick={() => project && setDialog({ kind: 'file', parent: project.rootPath })}
        >
          <AppIcon name="file-plus" size={14} />
        </button>
        <button
          className="icon-btn"
          title="新建文件夹"
          onClick={() => project && setDialog({ kind: 'folder', parent: project.rootPath })}
        >
          <AppIcon name="folder-plus" size={14} />
        </button>
        <div className="mod-tools-wrap">
          <button ref={modMenuButton} className="icon-btn" title="模组工具" aria-expanded={modMenu} onClick={toggleModMenu}>
            <AppIcon name="tools" size={13} />
          </button>
          {modMenu && createPortal(
            <>
              <div className="mod-tools-menu project-tools-popover" aria-label="模组工具箱" style={{ left: modMenuPosition.left, top: modMenuPosition.top, maxHeight: `calc(100vh - ${modMenuPosition.top + 8}px)` }}>
                <button onClick={() => { setModDialog('createMod'); setModMenu(false) }}><BilingualLabel zh="模组自述文件" en="Mod information" /></button>
                <button onClick={() => { setModMenu(false); useWorkspaceStore.getState().setUnitLibraryOpen(true) }}><BilingualLabel zh="单位库" en="Unit library" /></button>
                <button onClick={() => { setModDialog('createUnit'); setModMenu(false) }}><BilingualLabel zh="新建单位" en="New unit" /></button>
                <button className="mod-action-import" onClick={() => { setModMenu(false); void importModProject() }}><BilingualLabel zh="导入模组" en="Import mod" /></button>
                <button className="mod-action-pack" onClick={() => { setModMenu(false); void packModProject() }}><BilingualLabel zh="打包模组" en="Pack mod" /></button>
                <button onClick={() => { setModMenu(false); void checkModProject() }}><BilingualLabel zh="检查模组" en="Check mod" /></button>
                <button onClick={() => { setModMenu(false); useWorkspaceStore.getState().setModReportOpen(true) }}><BilingualLabel zh="质量报告" en="Quality report" /></button>
                <button onClick={() => { setModMenu(false); setModDialog('optimize') }}><BilingualLabel zh="优化模组" en="Optimize mod" /></button>
                <button onClick={() => { setModMenu(false); setModDialog('translationRepair') }}><BilingualLabel zh="修复中文翻译" en="Repair translated source" /></button>
                <button onClick={() => { setModMenu(false); setModDialog('globalOp') }}><BilingualLabel zh="全局操作" en="Global operations" /></button>
              </div>
              <div className="mod-tools-mask project-tools-mask" onClick={() => setModMenu(false)} />
            </>, document.body,
          )}
        </div>
        <button className="icon-btn" title="导入模组（文件夹或 rwmod/zip）" onClick={() => void importModProject()}>
          <AppIcon name="plus" size={14} />
        </button>
      </div>
      {projects.length === 0 ? (
        <div className="empty-state project-empty-state">
          <AppIcon name="folder" size={28} />
          <div>还没有项目</div>
          <button className="btn" onClick={() => void importModProject()}>
            导入模组
          </button>
        </div>
      ) : (
        <div className="projects-tree" ref={treeRef} role="tree" tabIndex={0} aria-label="项目与文件树" onKeyDown={onTreeKeyDown}>
          {projects.map((p) => {
            const active = p.id === activeProjectId
            const expanded = active && !collapsedIds[p.id]
            return (
              <div className="project-tree-group" key={p.id}>
                <div
                  className={`project-item${active ? ' active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => toggleProjectRow(p.id)}
                  onKeyDown={(e) => {
                    // M29：键盘切换/折叠项目（Enter/Space）
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleProjectRow(p.id)
                    }
                  }}
                  title={p.rootPath}
                >
                  <span className={`proj-chev${expanded ? ' open' : ''}`}>
                    <IconChevronRight size={13} />
                  </span>
                  <span className="proj-icon">
                    <AppIcon name="folder" size={15} />
                  </span>
                  <span className="proj-name">{p.name}</span>
                  <span className="proj-time">{formatRelativeTime(p.lastOpenedAt)}</span>
                  <span
                    className="row-actions"
                    onClick={(e) => {
                      e.stopPropagation()
                      requestConfirm({
                        title: '移除项目记录',
                        message: '只移除列表记录，不会删除项目文件。确认移除？',
                        danger: true,
                        confirmText: '移除',
                        onConfirm: () => removeProject(p.id),
                      })
                    }}
                  >
                    <button className="icon-btn" title="从列表移除">
                      <AppIcon name="close" size={13} />
                    </button>
                  </span>
                </div>
                {expanded && (p.id === activeProjectId) && (
                  <div className="project-tree-body">
                    {treeError ? (
                      <div className="tree-error">无法读取项目：{treeError}</div>
                    ) : treeRoot && treeRoot.path === p.rootPath ? (
                      <div className="tree" role="tree" aria-label="项目文件树">
                        {/* 顶层与子目录走同一排序（此前只排子目录，根目录切排序无效） */}
                        {sortChildren(treeRoot.children ?? [], fileSort).map((child) => (
                          <div className="tree-child" key={child.path}><TreeRow node={child} depth={0} onRename={setRenaming} onNewIn={setDialog} /></div>
                        ))}
                      </div>
                    ) : (
                      // M29：根树加载态——「正在读取」与「空项目」不再混为一种
                      <PanelState kind="loading" title="正在加载项目文件…" />
                    )}
                    <FavoritesList onOpenFile={(path) => void useWorkspaceStore.getState().openFile(path)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

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
  const openTabs = useWorkspaceStore((s) => s.openTabs)
  const isBookmarked = useWorkspaceStore((s) => s.bookmarks.some((b) => b.path === node.path && b.projectId === s.activeProjectId))
  const fileSort = useWorkspaceStore((s) => s.settings.fileSort)

  const indent = depth * 14

  /** 删除确认（文件/文件夹统一）：被删路径下打开的脏标签提示未保存修改，防止静默丢编辑 */
  const confirmDelete = (name: string, path: string) => {
    const dirtyTabs = openTabs.filter((t) => t.dirty && pathStartsWith(t.path, path))
    const dirtyTip = dirtyTabs.length > 0
      ? `\n\n⚠ ${dirtyTabs.length} 个已打开文件有未保存修改（${dirtyTabs.map((t) => t.name).join('、')}），删除后这些修改将丢失。`
      : ''
    requestConfirm({
      title: '删除到回收站',
      message: `确定把「${name}」移入回收站吗？\n此操作无法在应用内撤销。${dirtyTip}`,
      danger: true,
      confirmText: '删除',
      onConfirm: () => void deleteItem(path),
    })
  }

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
          data-tree-row
          role="treeitem"
          aria-expanded={expanded}
          aria-selected={selected}
          tabIndex={-1}
          style={{ paddingLeft: 6 + indent }}
          onClick={() => void useWorkspaceStore.getState().toggleDir(node.path)}
          onKeyDown={(e) => {
            // M29：键盘展开/收起目录（Enter/空格/右箭头展开、左箭头收起）
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              void useWorkspaceStore.getState().toggleDir(node.path)
            } else if (e.key === 'ArrowRight' && !expanded) {
              e.preventDefault()
              void useWorkspaceStore.getState().toggleDir(node.path)
            } else if (e.key === 'ArrowLeft' && expanded) {
              e.preventDefault()
              void useWorkspaceStore.getState().toggleDir(node.path)
            }
          }}
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
            {/* 新建文件/文件夹用带加号的专属图标（file-plus/folder-plus），避免与普通文件/文件夹混淆 */}
            <button
              className="icon-btn"
              title="新建文件"
              onClick={(e) => {
                e.stopPropagation()
                onNewIn({ kind: 'file', parent: node.path })
              }}
            >
              <AppIcon name="file-plus" size={12} />
            </button>
            <button
              className="icon-btn"
              title="新建文件夹"
              onClick={(e) => {
                e.stopPropagation()
                onNewIn({ kind: 'folder', parent: node.path })
              }}
            >
              <AppIcon name="folder-plus" size={12} />
            </button>
            <button
              className="icon-btn"
              title="删除（回收站）"
              onClick={(e) => {
                e.stopPropagation()
                confirmDelete(node.name, node.path)
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
      data-tree-row
      role="treeitem"
      aria-selected={selected}
      tabIndex={-1}
      style={{ paddingLeft: 22 + indent }}
      onDoubleClick={() => void openFile(node.path)}
      onKeyDown={(e) => {
        // M29：键盘打开文件（Enter/空格）
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          void openFile(node.path)
        }
      }}
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
          onClick={() => confirmDelete(node.name, node.path)}
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
