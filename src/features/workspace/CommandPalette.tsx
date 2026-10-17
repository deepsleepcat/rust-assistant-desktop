/**
 * 命令面板（Ctrl+K）：Codex 风格的命令搜索。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { IconClose, IconFolder, IconGear } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { useEscapeHandler } from '../../utils/modalStack'
import { DEFAULT_LAYOUT, DEFAULT_SETTINGS } from '../../utils/settings'
import { formatShortcut, resolveShortcuts } from '../../utils/shortcuts'

interface CommandItem {
  id: string
  title: string
  /** 小号英文提示（中文在上、英文在下，展示层双语） */
  en?: string
  hint?: string
  icon: ReactNode
  run: () => void
}

export function CommandPalette() {
  const open = useWorkspaceStore((s) => s.commandOpen)
  const setOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const importModProject = useWorkspaceStore((s) => s.importModProject)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const setModDialog = useWorkspaceStore((s) => s.setModDialog)
  const packModProject = useWorkspaceStore((s) => s.packModProject)
  const checkModProject = useWorkspaceStore((s) => s.checkModProject)
  const closeTab = useWorkspaceStore((s) => s.closeTabChecked)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)
  // M29：布局折叠状态（命令面板动态显示「显示/隐藏」文案）
  const leftCollapsed = useWorkspaceStore((s) => s.settings.layout.leftCollapsed)
  const settingsKey = useWorkspaceStore((s) => resolveShortcuts(s.settings.keyboardShortcuts).settings)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 全局 Escape 关闭：与 Modal 一致，焦点在任何位置都能按 Esc 关闭面板。
  // 面板常驻挂载但只在打开时占栈（enabled）——否则会永久吞掉全局 Escape
  // （编辑器补全弹层等都无法用 Esc 关闭）
  useEscapeHandler(() => setOpen(false), open)

  // 打开时聚焦输入框（重新打开时保留上次的搜索词，与 VS Code 行为一致）
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 10)
    return () => clearTimeout(t)
  }, [open])

  const commands = useMemo<CommandItem[]>(
    () => [
      { id: 'open-project', title: '导入模组…', en: 'Import mod…', icon: <IconFolder size={15} />, run: () => void importModProject() },
      { id: 'open-settings', title: '打开设置', en: 'Open settings', hint: settingsKey ? formatShortcut(settingsKey) : undefined, icon: <IconGear size={15} />, run: () => setSettingsOpen(true) },
      { id: 'surface-dashboard', title: '打开仪表盘', en: 'Open dashboard', icon: <AppIcon name="layout" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setActiveSurface('dashboard') } },
      { id: 'surface-community', title: '打开社区', en: 'Open community', icon: <AppIcon name="share" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setActiveSurface('community') } },
      { id: 'surface-cloud-bag', title: '打开云仓库', en: 'Open cloud repo', icon: <AppIcon name="cloud" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setActiveSurface('cloudBag') } },
      { id: 'surface-editor', title: '返回工作区（编辑器）', en: 'Back to workspace', icon: <AppIcon name="code" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setActiveSurface('editor') } },
      {
        id: 'close-tab',
        title: '关闭当前文件',
        en: 'Close current file',
        icon: <IconClose size={15} />,
        run: () => activeTabId && closeTab(activeTabId),
      },
      { id: 'mod-create', title: '模组：自述文件（创建/编辑）…', en: 'Mod: mod-info.txt…', icon: <AppIcon name="box" size={15} />, run: () => { setModDialog('createMod'); setOpen(false) } },
      { id: 'mod-create-unit', title: '模组：新建单位…', en: 'Mod: new unit…', icon: <AppIcon name="tower" size={15} />, run: () => { setModDialog('createUnit'); setOpen(false) } },
      { id: 'mod-unit-library', title: '模组：单位库', en: 'Mod: unit library', icon: <AppIcon name="tower" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setUnitLibraryOpen(true) } },
      { id: 'mod-pack', title: '模组：打包（.rwmod）', en: 'Mod: pack (.rwmod)', icon: <AppIcon name="box" size={15} />, run: () => { setOpen(false); void packModProject() } },
      { id: 'mod-check', title: '模组：检查单位', en: 'Mod: check units', icon: <AppIcon name="zoom" size={15} />, run: () => { setOpen(false); void checkModProject() } },
      { id: 'mod-optimize', title: '模组：优化（清理垃圾）', en: 'Mod: optimize', icon: <AppIcon name="tools" size={15} />, run: () => { setOpen(false); setModDialog('optimize') } },
      { id: 'mod-translation-repair', title: '模组：修复中文翻译损坏', en: 'Mod: repair translations', icon: <AppIcon name="text" size={15} />, run: () => { setOpen(false); setModDialog('translationRepair') } },
      { id: 'template-library', title: '模板库管理（本地浏览/导入/删除）', en: 'Template library', icon: <AppIcon name="box" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setTemplateLibraryOpen(true) } },
      { id: 'git-info', title: 'Git 历史与回滚（本地）', en: 'Git history & rollback', icon: <AppIcon name="clock" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setGitInfoOpen(true) } },
      { id: 'code-table', title: '浏览代码表', en: 'Browse code table', icon: <AppIcon name="text" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setCodeTableOpen(true) } },
      { id: 'version-diff', title: '版本差异对比（字段新增/弃用/迁移）', en: 'Version diff', icon: <AppIcon name="text" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setVersionDiffOpen(true) } },
      { id: 'relation-graph', title: '模组关系图（单位/资源/炮塔/弹体引用）', en: 'Relation graph', icon: <AppIcon name="zoom" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setRelationGraphOpen(true) } },
      { id: 'value-type', title: '值类型管理（自定义补全规则）', en: 'Value types', icon: <AppIcon name="tools" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setValueTypeOpen(true) } },
      // M29：布局命令（折叠状态动态切换文案；操作前读最新 state，避免闭包旧值）
      {
        id: leftCollapsed ? 'layout-show-left' : 'layout-hide-left',
        title: leftCollapsed ? '布局：显示项目区' : '布局：隐藏项目区',
        en: leftCollapsed ? 'Show projects' : 'Hide projects',
        icon: <AppIcon name={leftCollapsed ? 'eye' : 'eye-off'} size={15} />,
        run: () => {
          setOpen(false)
          const s = useWorkspaceStore.getState()
          s.updateSettings({ layout: { ...s.settings.layout, leftCollapsed: !s.settings.layout.leftCollapsed } })
        },
      },
      {
        id: 'layout-reset',
        title: '布局：恢复默认布局',
        en: 'Reset layout',
        icon: <AppIcon name="refresh" size={15} />,
        run: () => {
          setOpen(false)
          const s = useWorkspaceStore.getState()
          s.updateSettings({
            layout: { ...DEFAULT_LAYOUT },
            leftWidth: DEFAULT_SETTINGS.leftWidth,
            rightWidth: DEFAULT_SETTINGS.rightWidth,
          })
        },
      },
      {
        id: 'layout-toggle-outline',
        title: '布局：切换大纲',
        en: 'Toggle outline',
        icon: <AppIcon name="expand" size={15} />,
        run: () => {
          setOpen(false)
          const s = useWorkspaceStore.getState()
          s.updateSettings({ layout: { ...s.settings.layout, outlineCollapsed: !s.settings.layout.outlineCollapsed } })
        },
      },
    ],
    [importModProject, setSettingsOpen, setModDialog, packModProject, checkModProject, activeTabId, closeTab, setOpen, leftCollapsed, settingsKey],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.title.toLowerCase().includes(q) || (c.en ?? '').toLowerCase().includes(q) || (c.hint ?? '').toLowerCase().includes(q))
  }, [commands, query])

  if (!open) return null

  return (
    <div className="command-overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="command-card" role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="command-input"
          value={query}
          placeholder="输入命令名称…"
          onChange={(e) => {
            setQuery(e.target.value)
            setIndex(0)
          }}
          onKeyDown={(e) => {
            // Escape 由全局监听处理（焦点不在输入框时也能关闭）
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              // 空结果时保持 0：否则 index 变 -1，恢复查询后高亮与 Enter 短暂失效
              setIndex((i) => (filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1)))
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            }
            if (e.key === 'Enter' && filtered[index]) {
              filtered[index].run()
              setOpen(false)
            }
          }}
        />
        <div className="command-list">
          {filtered.length === 0 ? (
            <div className="command-empty">没有匹配的命令</div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                className={`command-item${i === index ? ' highlighted' : ''}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  c.run()
                  setOpen(false)
                }}
              >
                <span className="cmd-icon">{c.icon}</span>
                {c.title}
                {c.hint && <span className="cmd-kbd">{c.hint}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
