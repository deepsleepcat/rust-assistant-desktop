/**
 * M5 模组工具弹窗：
 * - 新建模组：表单 → 生成 mod-info.txt + units/ + 示例单位
 * - 新建单位：表单 → 生成最小可玩单位骨架
 * - 检查模组：显示单位检查结果（name 缺失 / [core] 缺失 / 重名）
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'

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

function CreateModModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { name: string; title: string; description?: string; author?: string; version?: string }) => void }) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [author, setAuthor] = useState('')
  const [version, setVersion] = useState('1.0')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = () => {
    if (!name.trim() || !title.trim()) return
    onSubmit({ name: name.trim(), title: title.trim(), description: description.trim() || undefined, author: author.trim() || undefined, version: version.trim() || undefined })
    onClose()
  }

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

function CreateUnitModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { name: string; displayName?: string }) => void }) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = () => {
    if (!name.trim()) return
    onSubmit({ name: name.trim(), displayName: displayName.trim() || undefined })
    onClose()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">新建单位</div>
        <div className="modal-body mod-form">
          <label className="mod-field">
            <span>单位英文名（文件名）<em>*</em></span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 scout-tank" autoFocus />
          </label>
          <label className="mod-field">
            <span>游戏内显示名（name: 字段）</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="如 侦察坦克" />
          </label>
          <p className="mod-tip">将生成 units/{name || '单位'}/{name || '单位'}.ini 最小可玩骨架（[core]/[graphics]/[attack]/[movement] 四个节）。</p>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={!name.trim()} onClick={submit}>创建单位</button>
        </div>
      </div>
    </div>
  )
}
