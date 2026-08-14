/**
 * 命令面板（Ctrl+K）：Codex 风格的命令搜索。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { IconChat, IconClose, IconFolder, IconGear } from '../../components/icons'
import { AppIcon } from '../../components/AppIcon'
import { useEscapeHandler } from '../../utils/modalStack'

interface CommandItem {
  id: string
  title: string
  hint?: string
  icon: ReactNode
  run: () => void
}

export function CommandPalette() {
  const open = useWorkspaceStore((s) => s.commandOpen)
  const setOpen = useWorkspaceStore((s) => s.setCommandOpen)
  const importModProject = useWorkspaceStore((s) => s.importModProject)
  const createConversation = useWorkspaceStore((s) => s.createConversation)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const setModDialog = useWorkspaceStore((s) => s.setModDialog)
  const packModProject = useWorkspaceStore((s) => s.packModProject)
  const checkModProject = useWorkspaceStore((s) => s.checkModProject)
  const closeTab = useWorkspaceStore((s) => s.closeTab)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)

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
      { id: 'open-project', title: '导入模组…', hint: 'Ctrl+O', icon: <IconFolder size={15} />, run: () => void importModProject() },
      { id: 'new-conversation', title: '新建 AI 对话', hint: 'Ctrl+Shift+C', icon: <IconChat size={15} />, run: () => createConversation() },
      { id: 'open-settings', title: '打开设置', hint: 'Ctrl+,', icon: <IconGear size={15} />, run: () => setSettingsOpen(true) },
      {
        id: 'close-tab',
        title: '关闭当前文件',
        icon: <IconClose size={15} />,
        run: () => activeTabId && closeTab(activeTabId),
      },
      { id: 'mod-create', title: '模组：自述文件（创建/编辑）…', icon: <AppIcon name="box" size={15} />, run: () => { setModDialog('createMod'); setOpen(false) } },
      { id: 'mod-create-unit', title: '模组：新建单位…', icon: <AppIcon name="tower" size={15} />, run: () => { setModDialog('createUnit'); setOpen(false) } },
      { id: 'mod-unit-library', title: '模组：单位库', icon: <AppIcon name="tower" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setUnitLibraryOpen(true) } },
      { id: 'mod-pack', title: '模组：打包（.rwmod）', icon: <AppIcon name="box" size={15} />, run: () => { setOpen(false); void packModProject() } },
      { id: 'mod-check', title: '模组：检查单位', icon: <AppIcon name="zoom" size={15} />, run: () => { setOpen(false); void checkModProject() } },
      { id: 'mod-optimize', title: '模组：优化（清理垃圾）', icon: <AppIcon name="tools" size={15} />, run: () => { setOpen(false); setModDialog('optimize') } },
      { id: 'code-table', title: '浏览代码表', icon: <AppIcon name="text" size={15} />, run: () => { setOpen(false); useWorkspaceStore.getState().setCodeTableOpen(true) } },
    ],
    [importModProject, createConversation, setSettingsOpen, setModDialog, packModProject, checkModProject, activeTabId, closeTab, setOpen],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.title.toLowerCase().includes(q) || (c.hint ?? '').toLowerCase().includes(q))
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
