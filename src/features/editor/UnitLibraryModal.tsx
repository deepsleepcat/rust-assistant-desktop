/**
 * 单位库弹窗：扫描项目内全部单位（.ini/.template），
 * 显示单位名 / 描述 / 文件路径，支持搜索过滤，双击打开编辑。
 * 历史记录跟随编辑器标签（最近打开 = 当前已打开的文件优先展示）。
 */
import { useEffect, useMemo, useState } from 'react'
import { useEscapeHandler } from '../../utils/modalStack'
import { useWorkspaceStore } from '../../stores/workspace'
import { getBridge } from '../../services/bridge'
import { AppIcon } from '../../components/AppIcon'

interface Props {
  onClose: () => void
}

interface UnitEntry {
  path: string
  name: string
  description?: string
  image?: string
  modified: number
}

export function UnitLibraryModal({ onClose }: Props) {
  const [query, setQuery] = useState('')
  const [units, setUnits] = useState<UnitEntry[] | null>(null)
  const openFile = useWorkspaceStore((s) => s.openFile)

  useEscapeHandler(onClose)

  useEffect(() => {
    let alive = true
    const project = useWorkspaceStore.getState().projects.find((p) => p.id === useWorkspaceStore.getState().activeProjectId)
    if (!project) {
      alive = false
      return
    }
    void getBridge()
      .mod.scanUnits(project.rootPath)
      .then((list) => alive && setUnits(list))
      .catch(() => alive && setUnits([]))
    return () => { alive = false }
  }, [])

  const filtered = useMemo(() => {
    if (!units) return []
    const q = query.trim().toLowerCase()
    if (!q) return units
    return units.filter(
      (u) => u.name.toLowerCase().includes(q) || u.path.toLowerCase().includes(q) || (u.description ?? '').toLowerCase().includes(q),
    )
  }, [units, query])

  const open = (path: string) => {
    void openFile(path)
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card unitlib-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">单位库</div>
        <div className="modal-body unitlib-body">
          <input
            className="codetable-search"
            placeholder="搜索单位名 / 文件名 / 描述"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {units === null ? (
            <p className="codetable-empty">正在扫描单位…</p>
          ) : filtered.length === 0 ? (
            <p className="codetable-empty">
              {units.length === 0 ? '项目里还没有单位（.ini / .template 源文件）。' : '没有匹配的单位。'}
            </p>
          ) : (
            <div className="unitlib-list">
              {filtered.map((u) => (
                <button key={u.path} className="unitlib-item" onClick={() => open(u.path)} title={`打开 ${u.path}`}>
                  <span className="unitlib-icon">
                    <AppIcon name="tower" size={16} />
                  </span>
                  <span className="unitlib-info">
                    <span className="unitlib-name">{u.name}</span>
                    {u.description && <span className="unitlib-desc">{u.description}</span>}
                    <span className="unitlib-path">{u.path}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{units ? `共 ${units.length} 个单位，点击条目打开` : ''}</span>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
