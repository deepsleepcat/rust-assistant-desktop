/**
 * M5 模组工具弹窗（容器组件：按 modDialog 状态分发到子弹窗）：
 * - ModToolModals（主）——根据 modDialog 状态渲染对应子弹窗
 * - CreateModModal  创建模组自述文件：表单 → 生成 mod-info.txt（已存在不覆盖）
 * - CreateUnitModal 新建单位：表单 → 生成最小可玩单位骨架
 * - CheckModal      检查模组：显示单位检查结果（name 缺失 / [core] 缺失 / 重名）
 * - OptimizeModal   目录优化：删冗余/重写空行注释（互斥域批量改写）
 * - GlobalOpModal   全局批量改写：按规则替换/前缀/后缀
 * - PackModal       打包模组：.rwmod 生成（清理选项）
 * - ReportModal     模组报告：完整性/统计导出
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { useEscapeHandler } from '../../utils/modalStack'
import type { ModImportKind } from '../../types/bridge'
import { getBridge } from '../../services/bridge'

export function ModToolModals() {
  const kind = useWorkspaceStore((s) => s.modDialog)
  const setModDialog = useWorkspaceStore((s) => s.setModDialog)
  const createModProject = useWorkspaceStore((s) => s.createModProject)
  const createUnitFile = useWorkspaceStore((s) => s.createUnitFile)
  const startModImport = useWorkspaceStore((s) => s.startModImport)
  const checkResult = useWorkspaceStore((s) => s.modCheckResult)
  const reportOpen = useWorkspaceStore((s) => s.modReportOpen)

  // M13：质量报告弹窗（独立于 modDialog——报告生成是异步的，先显示加载态）
  if (reportOpen) {
    return <ReportModal onClose={() => useWorkspaceStore.getState().setModReportOpen(false)} />
  }

  if (!kind) return null
  if (kind === 'check') {
    const errCount = checkResult?.issues.filter((i) => i.level === 'error').length ?? 0
    const warnCount = checkResult?.issues.filter((i) => i.level === 'warning').length ?? 0
    const infoCount = checkResult?.issues.filter((i) => i.level === 'info').length ?? 0
    return <CheckModal errCount={errCount} warnCount={warnCount} infoCount={infoCount} checkResult={checkResult} onClose={() => setModDialog(null)} />
  }

  if (kind === 'optimize') {
    return <OptimizeModal onClose={() => setModDialog(null)} />
  }

  if (kind === 'globalOp') {
    return <GlobalOpModal onClose={() => setModDialog(null)} />
  }

  if (kind === 'pack') {
    return <PackModal onClose={() => setModDialog(null)} />
  }

  if (kind === 'createUnit') {
    return <CreateUnitModal onClose={() => setModDialog(null)} onSubmit={createUnitFile} />
  }

  if (kind === 'import') {
    return <ImportModModal onClose={() => setModDialog(null)} onSelect={startModImport} />
  }

  return <CreateModModal onClose={() => setModDialog(null)} onSubmit={createModProject} />
}

function ImportModModal({ onClose, onSelect }: { onClose: () => void; onSelect: (kind: ModImportKind) => Promise<void> }) {
  const choose = (kind: ModImportKind) => {
    onClose()
    void onSelect(kind)
  }

  return (
    <Modal
      title="导入模组"
      onClose={onClose}
      footer={<button className="btn" onClick={onClose}>取消</button>}
    >
      <p className="import-mod-intro">选择导入来源</p>
      <div className="import-mod-options">
        <button className="import-mod-option" onClick={() => choose('archive')} autoFocus>
          <span className="import-mod-icon"><AppIcon name="archive" size={20} /></span>
          <span className="import-mod-copy">
            <strong>模组文件</strong>
            <span>.rwmod / .zip</span>
          </span>
          <span className="import-mod-detail">解压到指定位置</span>
        </button>
        <button className="import-mod-option" onClick={() => choose('folder')}>
          <span className="import-mod-icon"><AppIcon name="folder" size={20} /></span>
          <span className="import-mod-copy">
            <strong>模组文件夹</strong>
            <span>已有项目目录</span>
          </span>
          <span className="import-mod-detail">直接作为项目打开</span>
        </button>
      </div>
    </Modal>
  )
}

function CreateModModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { title: string; description?: string; author?: string; version?: string; musicFiles?: string[]; musicExclusive?: boolean; updateUrl?: string }) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [author, setAuthor] = useState('')
  const [version, setVersion] = useState('1.0')
  // M8 更新链接（http/https，写入 [mod] update: 键）
  const [updateUrl, setUpdateUrl] = useState('')
  // M6.5 背景音乐：源文件绝对路径列表 + 独占播放开关
  const [musicFiles, setMusicFiles] = useState<string[]>([])
  const [musicExclusive, setMusicExclusive] = useState(true)
  // M7 编辑模式：已有 mod-info.txt 时回填，保存走覆盖式写回。
  // 初始即 'loading'：读取完成前不渲染表单、提交按钮禁用（此前从 null 起步，
  // 'loading' 分支永不成立，读取期间快速点击会误走创建分支）
  const [existing, setExisting] = useState<ModInfoEditorData | null | 'loading'>('loading')

  useEscapeHandler(onClose)

  // 打开时读取已有自述文件（存在则进入编辑模式）
  useEffect(() => {
    let alive = true
    const project = useWorkspaceStore.getState().projects.find((p) => p.id === useWorkspaceStore.getState().activeProjectId)
    if (!project) return
    void getBridge()
      .mod.readModInfo(project.rootPath)
      .then((info) => {
        if (!alive) return
        if (info) {
          setExisting(info)
          setTitle(info.title)
          setDescription(info.description ?? '')
          setAuthor(info.author ?? '')
          setVersion(info.version ?? '1.0')
          setUpdateUrl(info.updateUrl ?? '')
          setMusicExclusive(info.musicExclusive)
          // 已存在的 music/ 文件作为只读展示（源路径不可反推，仅展示）
        } else {
          setExisting(null)
        }
      })
      .catch(() => alive && setExisting(null))
    return () => { alive = false }
  }, [])

  const chooseMusic = async () => {
    try {
      const files = await getBridge().mod.chooseMusic()
      if (files.length > 0) setMusicFiles((prev) => [...prev, ...files.filter((f) => !prev.includes(f))])
    } catch {
      /* 用户取消或失败：保持原状 */
    }
  }

  const submit = () => {
    if (!title.trim()) return
    if (existing === 'loading') return // 加载中不允许提交
    // 更新链接校验：为空或合法 http(s) 链接（不符合就拦截并提示，避免写入脏数据）
    if (updateUrl.trim() && !/^https?:\/\/\S+$/i.test(updateUrl.trim())) {
      useWorkspaceStore.getState().notify('更新链接需以 http:// 或 https:// 开头')
      return
    }
    if (existing) {
      // 编辑模式：覆盖式写回
      void useWorkspaceStore.getState().saveModInfo({
        title: title.trim(),
        description: description.trim() || undefined,
        author: author.trim() || undefined,
        version: version.trim() || undefined,
        thumbnail: existing.thumbnail,
        minVersion: existing.minVersion,
        musicFiles: existing.musicFiles,
        musicExclusive: musicExclusive,
        mapsFiles: existing.mapsFiles,
        mapsExtra: existing.mapsExtra,
        // M8：原样传回自定义目录，防止覆盖用户手改的 sourceFolder
        musicSourceFolder: existing.musicSourceFolder,
        mapsSourceFolder: existing.mapsSourceFolder,
        updateUrl: updateUrl.trim() || undefined,
      })
      onClose()
      return
    }
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      author: author.trim() || undefined,
      version: version.trim() || undefined,
      musicFiles: musicFiles.length > 0 ? musicFiles : undefined,
      musicExclusive: musicFiles.length > 0 ? musicExclusive : undefined,
      updateUrl: updateUrl.trim() || undefined,
    })
    onClose()
  }

  const musicNames = musicFiles.map((f) => f.split(/[\\/]/).pop() ?? f)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{existing === 'loading' ? '模组自述文件' : existing ? '编辑模组自述文件' : '创建模组自述文件'}</div>
        <div className="modal-body mod-form">
          {existing === 'loading' ? (
            <p className="mod-tip">正在读取 mod-info.txt…</p>
          ) : (
          <>
          <p className="mod-tip">
            {existing
              ? '已检测到 mod-info.txt，保存将覆盖原内容（游戏内显示的模组标题与信息）。'
              : '模组自述文件（mod-info.txt）用于描述模组信息，游戏会读取它显示模组标题。已存在时不会覆盖。'}
          </p>
          <label className="mod-field">
            <span>模组标题（游戏内显示）<em>*</em></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如 我的模组" autoFocus />
          </label>
          <label className="mod-field">
            <span>描述（可选）</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="模组介绍，将写入 mod-info.txt" />
          </label>
          <div className="mod-row">
            <label className="mod-field">
              <span>作者</span>
              <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="可选" />
            </label>
            <label className="mod-field">
              <span>版本</span>
              <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0" />
            </label>
          </div>
          <label className="mod-field">
            <span>更新链接（可选）</span>
            <input value={updateUrl} onChange={(e) => setUpdateUrl(e.target.value)} placeholder="https://…（写入 mod-info.txt 的 update 键）" />
          </label>
          {!existing && (
            <div className="mod-field">
              <span>背景音乐（可选）</span>
              <div className="music-picker">
                <button type="button" className="btn" onClick={() => void chooseMusic()}>
                  选择音乐…
                </button>
                {musicNames.length > 0 && (
                  <ul className="music-list">
                    {musicNames.map((n, i) => (
                      <li key={`${n}-${i}`}>
                        <span title={musicFiles[i]}>{n}</span>
                        <button type="button" className="icon-btn" title="移除" onClick={() => setMusicFiles((prev) => prev.filter((_, j) => j !== i))}>
                          <AppIcon name="close" size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="mod-tip">支持 mp3 / wav / flac / m4a / ogg，将自动转换为 ogg 并放入 music/ 目录。</div>
            </div>
          )}
          {existing && existing.musicFiles.length > 0 && (
            <div className="mod-field">
              <span>背景音乐（music/ 目录）</span>
              <ul className="music-list">
                {existing.musicFiles.map((f) => (
                  <li key={f}>
                    <span title={f}>{f.split('/').pop()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {existing && existing.mapsFiles.length > 0 && (
            <div className="mod-field">
              <span>地图（maps/ 目录）</span>
              <ul className="music-list">
                {existing.mapsFiles.map((f) => (
                  <li key={f}>
                    <span title={f}>{f.split('/').pop()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(existing ? existing.musicFiles.length > 0 : musicFiles.length > 0) && (
            <div className="setting-row">
              <span className="label">
                独占播放
                <div className="desc">使用本模组单位时独占播放背景音乐</div>
              </span>
              <button
                className={`switch${musicExclusive ? ' on' : ''}`}
                role="switch"
                aria-checked={musicExclusive}
                onClick={() => setMusicExclusive(!musicExclusive)}
              >
                <span className="knob" />
              </button>
            </div>
          )}
          <p className="mod-tip">{existing ? '保存将覆盖 mod-info.txt，音乐/地图清单来自 music/ 与 maps/ 目录。' : '将在项目根目录生成 mod-info.txt（模组自述文件），不创建示例单位。'}</p>
          </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={existing === 'loading' || !title.trim()} onClick={submit}>
            {existing === 'loading' ? '读取中…' : existing ? '保存修改' : '创建自述文件'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 编辑模式的回填数据（来自 mod:readModInfo） */
interface ModInfoEditorData {
  title: string
  description?: string
  author?: string
  version?: string
  thumbnail?: string
  minVersion?: string
  musicFiles: string[]
  musicExclusive: boolean
  mapsFiles: string[]
  mapsExtra: boolean
  /** M8：自定义音乐/地图目录（编辑保存时原样传回，防止覆盖用户手改的 sourceFolder） */
  musicSourceFolder?: string
  mapsSourceFolder?: string
  /** M8：更新链接（写入 [mod] update: 键） */
  updateUrl?: string
}

/**
 * 新建单位（M6.5 模板系统版）：
 * 第一步选模板（基础模板包），第二步填表单（名称/属性）+ 文件名。
 */
function CreateUnitModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { name: string; templateKey: string; values: Record<string, string> }) => void }) {
  const [templates, setTemplates] = useState<import('../../types/mod').TemplateMeta[] | null>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [selected, setSelected] = useState<import('../../types/mod').TemplateMeta | null>(null)
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})

  useEscapeHandler(onClose)

  // 打开时加载模板列表
  useEffect(() => {
    let alive = true
    void getBridge()
      .mod.listTemplates()
      .then((list) => alive && setTemplates(list))
      .catch(() => alive && setTemplates([]))
    return () => { alive = false }
  }, [])

  const pick = (t: import('../../types/mod').TemplateMeta) => {
    setSelected(t)
    setValues({ ...t.defaults })
    setStep(2)
  }

  const submit = () => {
    if (!selected || !name.trim()) return
    onSubmit({ name: name.trim(), templateKey: selected.key, values })
    onClose()
  }

  if (step === 1) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">新建单位 · 选择模板</div>
          <div className="modal-body mod-form">
            <p className="mod-tip">从基础模板包选择一个起点，选中后可修改各项属性。</p>
            <div className="template-grid">
              {(templates ?? []).map((t) => (
                <button key={t.key} className="template-item" onClick={() => pick(t)}>
                  <span className="template-name">{t.name}</span>
                  {t.nameEn && <span className="template-en">{t.nameEn}</span>}
                </button>
              ))}
              {templates && templates.length === 0 && <span style={{ gridColumn: '1/-1', color: 'var(--text-3)' }}>模板加载失败或为空</span>}
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn" onClick={onClose}>取消</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">新建单位 · {selected?.name}</div>
        <div className="modal-body mod-form">
          <label className="mod-field">
            <span>单位英文名（文件名）<em>*</em></span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 scout-tank" autoFocus />
          </label>
          {selected?.actions.map((a) => (
            <label className="mod-field" key={a.tag}>
              <span>{a.label}</span>
              <input
                value={values[a.tag] ?? ''}
                onChange={(e) => setValues({ ...values, [a.tag]: e.target.value })}
                placeholder={a.key}
              />
            </label>
          ))}
          <p className="mod-tip">将生成 {name || '单位'}/{name || '单位'}.ini（模板内容 + 你填写的属性）。</p>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={() => setStep(1)}>返回模板</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!name.trim()} onClick={submit}>创建单位</button>
        </div>
      </div>
    </div>
  )
}

/**
 * 优化工具弹窗：扫描模组内可清理项（空文件/空文件夹/.bak/空行/注释），
 * 分组勾选后批量执行。勾选即代表「删除/清理」，执行前二次确认。
 */
function CheckModal({
  checkResult,
  errCount,
  warnCount,
  infoCount,
  onClose,
}: {
  checkResult: import('../../stores/workspace').WorkspaceStore['modCheckResult']
  errCount: number
  warnCount: number
  infoCount: number
  onClose: () => void
}) {
  useEscapeHandler(onClose)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">单位检查结果</div>
        <div className="modal-body mod-check-body">
          <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-secondary)' }}>
            共扫描 {checkResult?.fileCount ?? 0} 个 ini 文件，识别 {checkResult?.unitCount ?? 0} 个单位。
            {errCount > 0 && <span style={{ color: 'var(--danger)' }}> 错误 {errCount}</span>}
            {warnCount > 0 && <span style={{ color: 'var(--warn)' }}> 建议 {warnCount}</span>}
            {infoCount > 0 && <span> 提示 {infoCount}</span>}
          </p>
          {checkResult && checkResult.issues.length === 0 ? (
            <p className="mod-check-ok"><AppIcon name="check" size={14} /> 未发现问题，单位命名规范良好</p>
          ) : (
            <ul className="mod-check-list">
              {(checkResult?.issues ?? []).map((issue, i) => (
                <li key={i} className={`mod-check-${issue.level}`}>
                  <AppIcon name={issue.level === 'error' ? 'cross' : issue.level === 'warning' ? 'warn' : 'info'} size={12} className="tool-icon" />
                  <code>{issue.file}</code> — {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  )
}

/**
 * 优化工具弹窗：扫描模组内可清理项（空文件/空文件夹/.bak/空行/注释），
 * 分组勾选后批量执行。勾选即代表「删除/清理」，执行前二次确认。
 */
function OptimizeModal({ onClose }: { onClose: () => void }) {
  const items = useWorkspaceStore((s) => s.optimizeItems)
  const optimizeError = useWorkspaceStore((s) => s.optimizeError)
  const scanOptimizeProject = useWorkspaceStore((s) => s.scanOptimizeProject)
  const applyOptimizeProject = useWorkspaceStore((s) => s.applyOptimizeProject)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEscapeHandler(onClose)

  // 打开时自动扫描：状态驱动——弹窗已打开时再次触发（命令面板重复打开清空 items）
  // 也会重新扫描；扫描成功/失败后条件不再成立，不会死循环
  useEffect(() => {
    if (items === null && optimizeError === null) void scanOptimizeProject()
  }, [items, optimizeError, scanOptimizeProject])

  const groups: Array<{ kind: OptimizeItemKind; label: string; desc: string; list: OptimizeItem[] }> = [
    { kind: 'emptyFile', label: '空文件', desc: '内容为空，删除', list: [] },
    { kind: 'emptyFolder', label: '空文件夹', desc: '没有任何内容，删除', list: [] },
    { kind: 'backupFile', label: '备份文件', desc: '.bak 后缀，删除', list: [] },
    { kind: 'emptyLine', label: '空行', desc: '重写文件去除所有空行', list: [] },
    { kind: 'comment', label: '注释行', desc: '重写文件去除 # 注释', list: [] },
  ]
  for (const g of groups) g.list = (items ?? []).filter((i) => i.kind === g.kind)

  const total = items?.length ?? 0
  const groupChecked = (g: typeof groups[number]) => g.list.length > 0 && g.list.every((i) => checked.has(i.id))
  const toggleGroup = (g: typeof groups[number]) => {
    const next = new Set(checked)
    const allOn = groupChecked(g)
    for (const i of g.list) {
      if (allOn) next.delete(i.id)
      else next.add(i.id)
    }
    setChecked(next)
  }
  const toggleItem = (id: string) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }

  const run = () => {
    setConfirming(false)
    setApplying(true)
    void applyOptimizeProject([...checked]).finally(() => setApplying(false))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card optimize-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">优化模组</div>
        <div className="modal-body mod-check-body">
          {items === null && optimizeError === null ? (
            <p className="mod-tip">正在扫描模组目录…</p>
          ) : optimizeError !== null ? (
            <div className="mod-check-error">
              <p className="mod-tip">{optimizeError}</p>
              {/* 重试 = 重新触发自动扫描（清空状态后由上面的 effect 发起，避免双扫描） */}
              <button className="btn primary" onClick={() => useWorkspaceStore.getState().setModDialog('optimize')}>重试扫描</button>
            </div>
          ) : total === 0 ? (
            <p className="mod-check-ok"><AppIcon name="check" size={14} /> 没有可优化的内容，模组很干净</p>
          ) : (
            <>
              <p className="mod-tip">共发现 {total} 项可优化内容。勾选后点击「执行优化」批量处理（删除类操作不可撤销，建议先备份）。</p>
              <div className="optimize-groups">
                {groups.filter((g) => g.list.length > 0).map((g) => (
                  <div key={g.kind} className="optimize-group">
                    <div className="optimize-group-head">
                      <label className="optimize-check">
                        <input type="checkbox" checked={groupChecked(g)} onChange={() => toggleGroup(g)} />
                        <span className="optimize-label">{g.label}</span>
                        <span className="optimize-desc">{g.desc}</span>
                      </label>
                      <span className="optimize-count">{g.list.length}</span>
                    </div>
                    <ul className="optimize-list">
                      {g.list.map((i) => (
                        <li key={i.id} className="optimize-item">
                          <label>
                            <input type="checkbox" checked={checked.has(i.id)} onChange={() => toggleItem(i.id)} />
                            <code>{i.rel}</code>
                            {i.detail && <span className="optimize-detail">{i.detail}</span>}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              {confirming && (
                <div className="optimize-confirm">
                  <p className="mod-tip">确定执行 {checked.size} 项优化吗？空文件/备份文件/空文件夹将被删除，无法在应用内恢复。</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => setConfirming(false)}>再想想</button>
                    <button className="btn primary" onClick={run} disabled={applying}>
                      {applying ? '处理中…' : '确定执行'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {items && items.length > 0 && (
          <div className="modal-footer">
            {checked.size === 0 ? (
              <>
                <button className="btn" onClick={() => setChecked(new Set(items.map((i) => i.id)))}>全选</button>
                <button className="btn primary" onClick={onClose}>关闭</button>
              </>
            ) : confirming ? null : (
              <>
                <button className="btn" onClick={() => setChecked(new Set())} disabled={applying}>清空选择</button>
                <button className="btn primary" onClick={() => setConfirming(true)} disabled={applying}>执行优化（{checked.size}）</button>
              </>
            )}
          </div>
        )}
        {/* L2：扫描中/干净态/错误态都提供关闭按钮（否则只能 ESC 或点遮罩） */}
        {(items === null && optimizeError === null) || (items !== null && items.length === 0 && optimizeError === null) || (items === null && optimizeError !== null) ? (
          <div className="modal-footer">
            <button className="btn primary" onClick={onClose}>{items === null && optimizeError === null ? '取消' : '关闭'}</button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

type OptimizeItemKind = 'emptyFile' | 'emptyFolder' | 'backupFile' | 'emptyLine' | 'comment'
interface OptimizeItem {
  id: string
  kind: OptimizeItemKind
  rel: string
  detail?: string
}

/** 全局操作弹窗：对整个模组源文件批量替换/头部附加/尾部附加（对 .ini/.template 生效） */
function GlobalOpModal({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<'replace' | 'prepend' | 'append'>('replace')
  const [find, setFind] = useState('')
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ files: number; changed: number; skipped: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEscapeHandler(onClose)

  const canRun = kind === 'replace' ? find.trim().length > 0 : text.length > 0

  const run = () => {
    setConfirming(false)
    setRunning(true)
    setResult(null)
    setError(null)
    void useWorkspaceStore
      .getState()
      .globalOpProject({ kind, find: kind === 'replace' ? find : undefined, text: kind === 'replace' ? text : undefined })
      .then((r) => {
        setRunning(false)
        if (r === null) {
          // 失败：显示错误状态（不显示误导的「0 个文件」成功文案）
          setError('执行失败：文件未被修改，请查看底部提示了解原因')
          return
        }
        setResult(r)
      })
  }

  const kinds: Array<{ value: 'replace' | 'prepend' | 'append'; label: string; desc: string }> = [
    { value: 'replace', label: '替换文本', desc: '把文件中所有匹配的文本替换为指定内容（全局替换，支持中英文）' },
    { value: 'prepend', label: '头部附加', desc: '在每个源文件开头插入一段文本（如通用声明/头注释）' },
    { value: 'append', label: '尾部附加', desc: '在每个源文件末尾追加一段文本' },
  ]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card optimize-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">全局操作</div>
        <div className="modal-body mod-form">
          <p className="mod-tip">对模组内全部 .ini / .template 源文件批量处理。操作会直接修改文件，执行前请确认。</p>
          <div className="mod-row" style={{ gap: 6 }}>
            {kinds.map((k) => (
              <button
                key={k.value}
                type="button"
                className={kind === k.value ? 'btn primary' : 'btn'}
                style={{ flex: 1 }}
                onClick={() => { setKind(k.value); setResult(null) }}
              >
                {k.label}
              </button>
            ))}
          </div>
          <p className="mod-tip">{kinds.find((k) => k.value === kind)?.desc}</p>
          {kind === 'replace' && (
            <label className="mod-field">
              <span>查找文本 <em>*</em></span>
              <textarea value={find} onChange={(e) => setFind(e.target.value)} rows={2} placeholder="要替换掉的文本，如：maxHp: 100" />
            </label>
          )}
          <label className="mod-field">
            <span>{kind === 'replace' ? '替换为' : '文本内容'} {kind !== 'replace' && <em>*</em>}</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={kind === 'replace' ? '替换成的新文本（留空 = 删除匹配项）' : '要附加的文本'} />
          </label>
          {result && (
            <p className="mod-check-ok">
              <AppIcon name="check" size={14} />
              {result.changed > 0
                ? `已处理 ${result.files} 个源文件，${result.changed} 个文件有改动${result.skipped > 0 ? `，跳过 ${result.skipped} 个（过大/不可读）` : ''}`
                : `扫描了 ${result.files} 个源文件，没有匹配内容需要改动`}
            </p>
          )}
          {error && (
            <p className="mod-check-error" style={{ margin: 0 }}>
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          {result ? (
            <button className="btn primary" onClick={onClose}>关闭</button>
          ) : confirming ? (
            <>
              <button className="btn" onClick={() => setConfirming(false)} disabled={running}>取消</button>
              <button className="btn-danger" onClick={run} disabled={running}>
                {running ? '执行中…' : `确认${kinds.find((k) => k.value === kind)?.label}`}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={onClose}>取消</button>
              <button className="btn primary" onClick={() => setConfirming(true)} disabled={!canRun || running}>
                {running ? '执行中…' : '下一步：确认'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 打包选项弹窗：选择打包时对源文件做的清理/格式化（默认为空，原样打包）。
 */
function PackModal({ onClose }: { onClose: () => void }) {
  const packModWithOptions = useWorkspaceStore((s) => s.packModWithOptions)
  const [options, setOptions] = useState({
    removeEmptyFiles: false,
    removeEmptyFolders: false,
    removeEmptyLines: false,
    removeComments: false,
    formatCode: false,
  })
  const [packing, setPacking] = useState(false)

  useEscapeHandler(onClose)

  const items: Array<{ key: keyof typeof options; label: string; desc: string }> = [
    { key: 'removeEmptyFiles', label: '移除空文件', desc: '内容为空的 .ini/.template 不进入压缩包' },
    { key: 'removeEmptyFolders', label: '移除空文件夹', desc: '没有任何文件的目录不进入压缩包' },
    { key: 'removeEmptyLines', label: '移除空行', desc: '源文件中的所有空行被删除' },
    { key: 'removeComments', label: '移除注释', desc: '源文件中的 # 注释行被删除' },
    { key: 'formatCode', label: '格式化代码', desc: '规整缩进与冒号空格，节前留空行' },
  ]

  const toggle = (key: keyof typeof options) => setOptions({ ...options, [key]: !options[key] })

  const run = () => {
    setPacking(true)
    void packModWithOptions(options).finally(() => setPacking(false))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card pack-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">打包模组</div>
        <div className="modal-body mod-check-body">
          <p className="mod-tip">选择打包时对源文件做的清理（不勾选 = 原样打包）。打包文件将通过系统对话框保存为 .rwmod。</p>
          <div className="pack-options">
            {items.map((it) => (
              <label key={it.key} className="pack-option">
                <input type="checkbox" checked={options[it.key]} onChange={() => toggle(it.key)} />
                <span className="pack-label">{it.label}</span>
                <span className="pack-desc">{it.desc}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={run} disabled={packing}>
            {packing ? '打包中…' : '开始打包'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** M13：模组质量报告弹窗（生成中显示加载；结果含汇总/问题清单/导出按钮） */
function ReportModal({ onClose }: { onClose: () => void }) {
  const report = useWorkspaceStore((s) => s.modReport)
  const busy = useWorkspaceStore((s) => s.modReportBusy)
  const reportError = useWorkspaceStore((s) => s.modReportError)
  const reportProgress = useWorkspaceStore((s) => s.modReportProgress)
  const generateModReport = useWorkspaceStore((s) => s.generateModReport)
  const exportModReport = useWorkspaceStore((s) => s.exportModReport)
  useEscapeHandler(onClose)

  // 打开弹窗后自动生成（幂等：busy 守卫；已生成不重复跑）
  useEffect(() => {
    if (!busy && !report && !reportError) void generateModReport()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时触发一次
  }, [])

  // 徽标/统计用报告的全量计数（issues 清单有 500 条 cap，filter 会低估）
  const errorCount = report?.errorCount ?? 0

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card report-card">
        <div className="modal-header">
          <span>模组质量报告</span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <AppIcon name="close" size={14} />
          </button>
        </div>

        {!report && reportError ? (
          <div className="report-loading report-error">
            报告生成失败：{reportError}
            <button className="btn" onClick={() => void generateModReport()}>
              重试
            </button>
          </div>
        ) : !report ? (
          <div className="report-loading">
            <span className="report-spinner" />
            {reportProgress && reportProgress.total > 0
              ? `正在检查文件 ${reportProgress.done}/${reportProgress.total}…`
              : '正在检查全部文件…'}
          </div>
        ) : (
          <div className="report-body">
            <div className="report-meta">
              <div className="report-meta-line">
                <b>{report.meta.projectName}</b>
                <span className={`report-badge${report.ok ? ' ok' : ' bad'}`}>{report.ok ? '✓ 通过' : `✕ ${errorCount} 个错误`}</span>
              </div>
              <div className="report-meta-sub">
                文件 {report.meta.fileCount} · 单位 {report.meta.unitCount} · 图片 {report.meta.imageCount} · 音频 {report.meta.audioCount} · 目标版本 {report.meta.targetVersion}
              </div>
              <div className="report-meta-sub">版本兼容：{report.versionConclusion}</div>
              <div className="report-meta-sub">生成时间：{new Date(report.meta.generatedAt).toLocaleString()}</div>
            </div>

            {report.checkerSummary.length > 0 && (
              <div className="report-section">
                <div className="report-section-title">检查器汇总（{report.checkerSummary.length}）</div>
                <ul className="report-summary">
                  {report.checkerSummary.map((c) => (
                    <li key={c.ruleId}>
                      <span className="report-rule">{c.ruleId}</span>
                      <span className={`report-count${c.errors > 0 ? ' err' : ''}`}>{c.errors} 错误</span>
                      <span className={`report-count${c.warnings > 0 ? ' warn' : ''}`}>{c.warnings} 警告</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="report-section">
              <div className="report-section-title">
                问题清单（{report.issues.length}）
                {report.issues.length > 0 && <span className="report-tip">路径已脱敏（相对项目根），可安全分享</span>}
              </div>
              {report.issues.length === 0 ? (
                <div className="report-clean">未发现问题 ✓</div>
              ) : (
                <ul className="report-issues">
                  {report.issues.map((it, i) => (
                    <li key={i} className={`report-issue report-issue-${it.severity}`}>
                      <span className="report-issue-mark">{it.severity === 'error' ? '✕' : '⚠'}</span>
                      <div className="report-issue-body">
                        <div className="report-issue-msg">
                          {it.ruleId && <code className="report-rule-tag">{it.ruleId}</code>}
                          {it.file && <code className="report-file">{it.file}{it.line > 0 ? `:${it.line}` : ''}</code>}
                          {it.message}
                        </div>
                        {it.suggestion && <div className="report-suggestion">建议：{it.suggestion}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="report-actions">
              <button className="btn" onClick={() => void exportModReport('text')}>
                导出文本
              </button>
              <button className="btn" onClick={() => void exportModReport('json')}>
                导出 JSON
              </button>
              <button className="btn primary" onClick={() => void generateModReport()} disabled={busy}>
                重新生成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
