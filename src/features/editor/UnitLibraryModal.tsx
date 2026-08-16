/**
 * 单位库弹窗：官方参考单位（从游戏提取，只读）+ 项目内全部单位（可打开编辑）。
 * - 官方单位：中文名/描述/英文名，点击复制英文名（写 builtFrom 等字段时直接粘）
 * - 项目单位：扫描项目 .ini/.template，显示名称/描述/路径，双击打开编辑
 * 历史记录跟随编辑器标签（最近打开 = 当前已打开的文件优先展示）。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useEscapeHandler } from '../../utils/modalStack'
import { useWorkspaceStore } from '../../stores/workspace'
import { getBridge } from '../../services/bridge'
import { getAllOfficialUnits, loadCodeData, type OfficialUnitInfo } from '../../services/codeData'
import { AppIcon } from '../../components/AppIcon'
import { PanelState } from '../../components/PanelState'
import { useFocusTrap } from '../../utils/focusTrap'
import { joinProjectPath } from '../../utils/projectPath'

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
  const [official, setOfficial] = useState<OfficialUnitInfo[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [scanSeq, setScanSeq] = useState(0)
  // M29：扫描状态机——「加载中 / 失败可重试 / 成功」三者分明，失败不再伪装成空
  const [scan, setScan] = useState<{ status: 'loading' } | { status: 'error'; error: string } | { status: 'done'; units: UnitEntry[] }>({ status: 'loading' })
  const openFile = useWorkspaceStore((s) => s.openFile)
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)

  useEscapeHandler(onClose)
  useFocusTrap(cardRef, true)

  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)

  useEffect(() => {
    if (!project) return
    let alive = true
    void getBridge()
      .mod.scanUnits(project.rootPath)
      .then((list) => alive && setScan({ status: 'done', units: list }))
      .catch((err) => alive && setScan({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
    return () => { alive = false }
  }, [project, scanSeq])

  const retryScan = () => {
    setScan({ status: 'loading' })
    setScanSeq((n) => n + 1)
  }

  const units = scan.status === 'done' ? scan.units : null
  const scanError = scan.status === 'error' ? scan.error : null

  // 官方单位（units.json 随应用打包，加载失败时为空数组）
  useEffect(() => {
    let alive = true
    void loadCodeData().then(() => alive && setOfficial(getAllOfficialUnits()))
    return () => { alive = false }
  }, [])

  const match = (text: string | undefined, q: string) => (text ?? '').toLowerCase().includes(q)

  const officialFiltered = useMemo(() => {
    if (!official) return []
    const q = query.trim().toLowerCase()
    if (!q) return official
    return official.filter(
      (u) => match(u.name, q) || match(u.zhName, q) || match(u.zhDesc, q),
    )
  }, [official, query])

  const projectFiltered = useMemo(() => {
    if (!units) return []
    const q = query.trim().toLowerCase()
    if (!q) return units
    return units.filter((u) => match(u.name, q) || match(u.path, q) || match(u.description, q))
  }, [units, query])

  const open = (path: string) => {
    // 扫描结果路径是相对项目根的写法（units/tank/tank.ini），而 fs 通道要求绝对路径：
    // 打开前拼成项目内绝对路径（openFile 也有兜底归一化，双保险）
    if (!project) return
    void openFile(joinProjectPath(project.rootPath, path))
    onClose()
  }

  const copyName = (name: string) => {
    void navigator.clipboard.writeText(name).then(() => {
      setCopied(name)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  const loading = (scan.status === 'loading') || official === null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={cardRef} className="modal-card unitlib-card" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" id={titleId}>单位库</div>
        <div className="modal-body unitlib-body">
          {!project ? (
            // M29：无项目时明确提示，不再永久「正在加载」
            <PanelState kind="empty" icon="folder" title="还没有打开项目" description="打开一个模组项目后，这里会显示项目内全部单位。" />
          ) : scanError ? (
            <PanelState kind="error" icon="warn" title="读取项目单位失败" description={scanError} onRetry={retryScan} />
          ) : (
            <>
          <input
            className="codetable-search"
            placeholder="搜索单位名 / 文件名 / 描述"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          {loading ? (
            <p className="codetable-empty">正在加载…</p>
          ) : (
            <>
              {officialFiltered.length > 0 && (
                <div className="unitlib-group">
                  <div className="unitlib-group-head">
                    <AppIcon name="star" size={12} />
                    官方参考（{officialFiltered.length}）· 点击复制英文名
                  </div>
                  <div className="unitlib-list unitlib-official-list">
                    {officialFiltered.map((u) => (
                      <button key={u.name} className="unitlib-item" onClick={() => copyName(u.name)} title={`复制 ${u.name}`}>
                        <span className="unitlib-icon">
                          <AppIcon name="star" size={15} />
                        </span>
                        <span className="unitlib-info">
                          <span className="unitlib-name">{u.zhName ?? u.name}</span>
                          {u.zhDesc && <span className="unitlib-desc">{u.zhDesc}</span>}
                          <span className="unitlib-path">{u.name}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="unitlib-group">
                <div className="unitlib-group-head">
                  <AppIcon name="tower" size={12} />
                  项目单位（{projectFiltered.length}）· 点击打开编辑
                </div>
                {projectFiltered.length === 0 ? (
                  <p className="codetable-empty">
                    {units && units.length === 0 ? '项目里还没有单位（.ini / .template 源文件）。' : '没有匹配的单位。'}
                  </p>
                ) : (
                  <div className="unitlib-list unitlib-project-list">
                    {projectFiltered.map((u) => (
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
            </>
          )}
            </>
          )}
        </div>
        <div className="modal-footer">
          {copied && (
            <span className="codetable-copied"><AppIcon name="check" size={12} /> 已复制 {copied}</span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {units && official ? `项目 ${units.length} · 官方 ${official.length}` : ''}
          </span>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
