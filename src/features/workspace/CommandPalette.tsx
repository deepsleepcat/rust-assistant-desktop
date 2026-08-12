/**
 * 命令面板（Ctrl+K）：Codex 风格的命令搜索。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { IconChat, IconClose, IconFolder, IconGear } from '../../components/icons'

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
  const openProject = useWorkspaceStore((s) => s.openProject)
  const createConversation = useWorkspaceStore((s) => s.createConversation)
  const setSettingsOpen = useWorkspaceStore((s) => s.setSettingsOpen)
  const closeTab = useWorkspaceStore((s) => s.closeTab)
  const activeTabId = useWorkspaceStore((s) => s.activeTabId)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开时聚焦输入框（重新打开时保留上次的搜索词，与 VS Code 行为一致）
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 10)
    return () => clearTimeout(t)
  }, [open])

  const commands = useMemo<CommandItem[]>(
    () => [
      { id: 'open-project', title: '打开项目…', hint: 'Ctrl+O', icon: <IconFolder size={15} />, run: () => void openProject() },
      { id: 'new-conversation', title: '新建 AI 对话', hint: 'Ctrl+Shift+C', icon: <IconChat size={15} />, run: () => createConversation() },
      { id: 'open-settings', title: '打开设置', hint: 'Ctrl+,', icon: <IconGear size={15} />, run: () => setSettingsOpen(true) },
      {
        id: 'close-tab',
        title: '关闭当前文件',
        hint: 'Ctrl+W',
        icon: <IconClose size={15} />,
        run: () => activeTabId && closeTab(activeTabId),
      },
    ],
    [openProject, createConversation, setSettingsOpen, activeTabId, closeTab],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.title.toLowerCase().includes(q) || (c.hint ?? '').toLowerCase().includes(q))
  }, [commands, query])

  // 打开时聚焦输入框（重新打开时保留上次的搜索词，与 VS Code 行为一致）
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 10)
    return () => clearTimeout(t)
  }, [open])

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
            if (e.key === 'Escape') setOpen(false)
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, filtered.length - 1))
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
