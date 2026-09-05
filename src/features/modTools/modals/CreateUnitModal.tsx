/**
 * 新建单位弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）。
 * 第一步选模板（基础模板包），第二步填表单（名称/属性）+ 文件名。
 */
import { useEffect, useState } from 'react'
import { useEscapeHandler } from '../../../utils/modalStack'
import { getBridge } from '../../../services/bridge'
import type { TemplateMeta } from '../../../types/mod'

export function CreateUnitModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (p: { name: string; templateKey: string; values: Record<string, string> }) => void }) {
  const [templates, setTemplates] = useState<TemplateMeta[] | null>(null)
  const [step, setStep] = useState<1 | 2>(1)
  const [selected, setSelected] = useState<TemplateMeta | null>(null)
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

  const pick = (t: TemplateMeta) => {
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
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
