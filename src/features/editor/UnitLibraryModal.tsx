/**
 * 单位库弹窗：官方参考单位（从游戏提取，只读）+ 项目内全部单位。
 * - 官方单位：中文名/描述/英文名，点击复制英文名（写 builtFrom 等字段时直接粘）
 * - 项目单位：扫描所选项目的 .ini/.template，显示名称/描述/路径；
 *   当前项目单位双击打开编辑；任意项目（含其它模组/同模组）单位可「复制到当前模组」
 *   （M34：主进程 copyUnit——只复制单位配置文本，不复制图片/音频等外部资源）。
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
import { Modal } from '../../components/Modal'

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
  // 来源项目（M34）：默认当前项目；可切换到其它已登记项目浏览/复制
  const projects = useWorkspaceStore((s) => s.projects)
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const [sourceProjectId, setSourceProjectId] = useState<string | null>(null)
  const source = projects.find((p) => p.id === sourceProjectId) ?? activeProject
  const isCurrentProject = !!activeProject && !!source && source.id === activeProject.id
  // M29：扫描状态机——「加载中 / 失败可重试 / 成功」三者分明，失败不再伪装成空
  const [scan, setScan] = useState<{ status: 'loading' } | { status: 'error'; error: string } | { status: 'done'; units: UnitEntry[] }>({ status: 'loading' })
  const openFile = useWorkspaceStore((s) => s.openFile)
  const refreshTree = useWorkspaceStore((s) => s.refreshTree)
  const notify = useWorkspaceStore((s) => s.notify)
  const titleId = useId()
  const cardRef = useRef<HTMLDivElement>(null)

  // M34 复制表单状态
  const [copyTarget, setCopyTarget] = useState<{ sourceRoot: string; sourcePath: string; sourceName: string } | null>(null)
  const [copyFormName, setCopyFormName] = useState('')
  const [copyFolder, setCopyFolder] = useState('')
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copyBusy, setCopyBusy] = useState(false)

  useEscapeHandler(onClose)
  useFocusTrap(cardRef, true)

  useEffect(() => {
    if (!source) return
    let alive = true
    void getBridge()
      .mod.scanUnits(source.rootPath)
      .then((list) => alive && setScan({ status: 'done', units: list }))
      .catch((err) => alive && setScan({ status: 'error', error: err instanceof Error ? err.message : String(err) }))
    return () => { alive = false }
  }, [source, scanSeq])

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
    if (!activeProject) return
    void openFile(joinProjectPath(activeProject.rootPath, path))
    onClose()
  }

  const copyName = (name: string) => {
    void navigator.clipboard.writeText(name).then(() => {
      setCopied(name)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  const openCopyForm = (u: UnitEntry) => {
    if (!source || !activeProject) return
    setCopyTarget({ sourceRoot: source.rootPath, sourcePath: u.path, sourceName: u.name })
    setCopyFormName(u.name)
    setCopyFolder('')
    setCopyError(null)
  }

  /** 执行复制（M34）：主进程校验两侧项目根/越界/链接/单位格式/不覆盖 */
  const runCopy = async () => {
    if (!copyTarget || !activeProject) return
    const name = copyFormName.trim()
    if (!name) {
      setCopyError('请填写单位名称')
      return
    }
    setCopyBusy(true)
    setCopyError(null)
    try {
      const result = await getBridge().mod.copyUnit({
        sourceRoot: copyTarget.sourceRoot,
        sourceFilePath: copyTarget.sourcePath,
        targetRoot: activeProject.rootPath,
        targetName: name,
        targetFolder: copyFolder.trim() || undefined,
      })
      await refreshTree()
      await openFile(joinProjectPath(activeProject.rootPath, result.path))
      notify(`已把「${copyTarget.sourceName}」复制为「${name}」`)
      setCopyTarget(null)
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err))
    } finally {
      setCopyBusy(false)
    }
  }

  const copyNameText = () => (source && !isCurrentProject ? `复制到当前模组：${activeProject?.name ?? '当前项目'}` : '复制一份（同模组内）')

  const loading = (scan.status === 'loading') || official === null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={cardRef} className="modal-card unitlib-card" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" id={titleId}>单位库</div>
        <div className="modal-body unitlib-body">
          {!activeProject ? (
            // M29：无项目时明确提示，不再永久「正在加载」
            <PanelState kind="empty" icon="folder" title="还没有打开项目" description="打开一个模组项目后，这里会显示项目内全部单位。" />
          ) : scanError && source ? (
            <PanelState kind="error" icon="warn" title={`读取「${source.name}」单位失败`} description={scanError} onRetry={retryScan} />
          ) : (
            <>
          <div className="unitlib-source-row">
            <label htmlFor="unitlib-source-select">来源项目：</label>
            <select
              id="unitlib-source-select"
              value={source?.id ?? ''}
              onChange={(e) => {
                setSourceProjectId(e.target.value || null)
                // 立即回到加载态：防止旧项目列表在新项目名下短暂展示（复制时会用错路径）
                setScan({ status: 'loading' })
                setQuery('')
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.id === activeProject.id ? '（当前）' : ''}
                </option>
              ))}
            </select>
            <span className="unitlib-source-hint">{isCurrentProject ? '浏览/复制本项目单位' : '浏览其它模组单位，可复制到当前模组'}</span>
          </div>
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
                  {source?.name ?? ''} 的单位（{projectFiltered.length}）{isCurrentProject ? '· 点击打开编辑' : '· 可复制到当前模组'}
                </div>
                {projectFiltered.length === 0 ? (
                  <p className="codetable-empty">
                    {units && units.length === 0 ? '项目里还没有单位（.ini / .template 源文件）。' : '没有匹配的单位。'}
                  </p>
                ) : (
                  <div className="unitlib-list unitlib-project-list">
                    {projectFiltered.map((u) => (
                      <div key={u.path} className="unitlib-row">
                        <button className="unitlib-item" onClick={() => isCurrentProject && open(u.path)} title={isCurrentProject ? `打开 ${u.path}` : `查看 ${u.path}`}>
                          <span className="unitlib-icon">
                            <AppIcon name="tower" size={16} />
                          </span>
                          <span className="unitlib-info">
                            <span className="unitlib-name">{u.name}</span>
                            {u.description && <span className="unitlib-desc">{u.description}</span>}
                            <span className="unitlib-path">{u.path}</span>
                          </span>
                        </button>
                        <button
                          className="btn unitlib-copy-btn"
                          onClick={() => openCopyForm(u)}
                          title={copyNameText()}
                        >
                          <AppIcon name="copy" size={11} /> 复制
                        </button>
                      </div>
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

      {copyTarget && (
        <Modal
          title={`复制单位「${copyTarget.sourceName}」`}
          onClose={() => !copyBusy && setCopyTarget(null)}
          footer={
            <>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>仅复制单位配置文本；图片/音频等资源需在模组里手动放入或重新选择</span>
              <span className="grow" />
              <button className="btn" onClick={() => setCopyTarget(null)} disabled={copyBusy}>取消</button>
              <button className="btn primary" onClick={() => void runCopy()} disabled={copyBusy}>
                {copyBusy ? '复制中…' : '复制'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
              <span>目标单位名称（新文件夹名）</span>
              <input
                autoFocus
                value={copyFormName}
                onChange={(e) => { setCopyFormName(e.target.value); setCopyError(null) }}
                placeholder="例如：重型坦克改"
                style={inputStyle()}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12.5 }}>
              <span>目标文件夹（可留空；将创建 文件夹/名称/名称.ini）</span>
              <input
                value={copyFolder}
                onChange={(e) => { setCopyFolder(e.target.value); setCopyError(null) }}
                placeholder="例如：units"
                style={inputStyle()}
              />
            </label>
            {copyError && <p style={{ margin: 0, fontSize: 12, color: 'var(--danger)' }}>{copyError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}

/** 复制表单输入框样式（与 PromptModal 对齐） */
function inputStyle(): import('react').CSSProperties {
  return {
    width: '100%',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--bg-input)',
    color: 'var(--text-1)',
    font: '14px var(--font-ui)',
    padding: '8px 10px',
    outline: 'none',
  }
}