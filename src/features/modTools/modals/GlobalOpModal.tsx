/**
 * 全局操作弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）：
 * 对整个模组源文件批量替换/头部附加/尾部附加（对 .ini/.template 生效）。
 */
import { useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { AppIcon } from '../../../components/AppIcon'
import { useEscapeHandler } from '../../../utils/modalStack'

export function GlobalOpModal({ onClose }: { onClose: () => void }) {
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
