/**
 * M5 模组工具弹窗：
 * - 新建模组：表单 → 生成 mod-info.txt + units/ + 示例单位
 * - 新建单位：表单 → 生成最小可玩单位骨架
 * - 检查模组：显示单位检查结果（name 缺失 / [core] 缺失 / 重名）
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { getBridge } from '../../services/bridge'

export function ModToolModals() {
  const kind = useWorkspaceStore((s) => s.modDialog)
  const setModDialog = useWorkspaceStore((s) => s.setModDialog)
  const createModProject = useWorkspaceStore((s) => s.createModProject)
  const createUnitFile = useWorkspaceStore((s) => s.createUnitFile)
  const checkResult = useWorkspaceStore((s) => s.modCheckResult)

  if (!kind) return null
  if (kind === 'check') {
    return (
      <div className="modal-overlay" onClick={() => setModDialog(null)}>
        <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">单位检查结果</div>
          <div className="modal-body mod-check-body">
            <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-secondary)' }}>
              共扫描 {checkResult?.fileCount ?? 0} 个 ini 文件，识别 {checkResult?.unitCount ?? 0} 个单位。
            </p>
            {checkResult && checkResult.issues.length === 0 ? (
              <p className="mod-check-ok"><AppIcon name="check" size={14} /> 未发现问题，单位命名规范良好</p>
            ) : (
              <ul className="mod-check-list">
                {(checkResult?.issues ?? []).map((issue, i) => (
                  <li key={i} className={`mod-check-${issue.level}`}>
                    <AppIcon name={issue.level === 'error' ? 'cross' : 'warn'} size={12} className="tool-icon" />
                    <code>{issue.file}</code> — {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn primary" onClick={() => setModDialog(null)}>知道了</button>
          </div>
        </div>
      </div>
    )
  }

  if (kind === 'createUnit') {
    return <CreateUnitModal onClose={() => setModDialog(null)} onSubmit={createUnitFile} />
  }

  return <CreateModModal onClose={() => setModDialog(null)} onSubmit={createModProject} />
}

function CreateModModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { name: string; title: string; description?: string; author?: string; version?: string; musicFiles?: string[]; musicExclusive?: boolean }) => void }) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [author, setAuthor] = useState('')
  const [version, setVersion] = useState('1.0')
  // M6.5 背景音乐：源文件绝对路径列表 + 独占播放开关
  const [musicFiles, setMusicFiles] = useState<string[]>([])
  const [musicExclusive, setMusicExclusive] = useState(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const chooseMusic = async () => {
    try {
      const files = await getBridge().mod.chooseMusic()
      if (files.length > 0) setMusicFiles((prev) => [...prev, ...files.filter((f) => !prev.includes(f))])
    } catch {
      /* 用户取消或失败：保持原状 */
    }
  }

  const submit = () => {
    if (!name.trim() || !title.trim()) return
    onSubmit({
      name: name.trim(),
      title: title.trim(),
      description: description.trim() || undefined,
      author: author.trim() || undefined,
      version: version.trim() || undefined,
      musicFiles: musicFiles.length > 0 ? musicFiles : undefined,
      musicExclusive: musicFiles.length > 0 ? musicExclusive : undefined,
    })
    onClose()
  }

  const musicNames = musicFiles.map((f) => f.split(/[\\/]/).pop() ?? f)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">新建模组</div>
        <div className="modal-body mod-form">
          <label className="mod-field">
            <span>模组英文名（目录名）<em>*</em></span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 my-mod" autoFocus />
          </label>
          <label className="mod-field">
            <span>模组标题（游戏内显示）<em>*</em></span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如 我的模组" />
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
          {musicFiles.length > 0 && (
            <div className="setting-row">
              <span className="label">
                独占播放
                <div className="desc">使用本模组单位时独占播放背景音乐（手机版同款选项）</div>
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
          <p className="mod-tip">将在项目里生成 mod-info.txt、units/ 目录和一个示例单位（可直接改造成你的单位）。</p>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!name.trim() || !title.trim()} onClick={submit}>创建模组</button>
        </div>
      </div>
    </div>
  )
}

/**
 * 新建单位（M6.5 模板系统版）：
 * 第一步选模板（移植手机版基础模板包），第二步填表单（名称/属性）+ 文件名。
 */
function CreateUnitModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { name: string; templateKey: string; values: Record<string, string> }) => void }) {
  const [templates, setTemplates] = useState<import('../../types/mod').TemplateMeta[] | null>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [selected, setSelected] = useState<import('../../types/mod').TemplateMeta | null>(null)
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
            <p className="mod-tip">从基础模板包（移植自手机版）选择一个起点，选中后可修改各项属性。</p>
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
          <p className="mod-tip">将生成 units/{name || '单位'}/{name || '单位'}.ini（模板内容 + 你填写的属性）。</p>
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
