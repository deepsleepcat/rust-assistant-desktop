/**
 * M38 中文翻译损坏修复弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）：
 * 扫描项目中被错误翻译成中文的节名、字段名、布尔值和已知逻辑标识符，
 * 预览后用户确认才写回。不接受自定义替换文本——只能勾选扫描器已经列出的文件。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { AppIcon } from '../../../components/AppIcon'
import { useEscapeHandler } from '../../../utils/modalStack'

export function TranslationRepairModal({ onClose }: { onClose: () => void }) {
  const items = useWorkspaceStore((s) => s.translationRepairItems)
  const error = useWorkspaceStore((s) => s.translationRepairError)
  const scan = useWorkspaceStore((s) => s.scanTranslationRepairProject)
  const apply = useWorkspaceStore((s) => s.applyTranslationRepairProject)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)

  useEscapeHandler(onClose)

  useEffect(() => {
    if (items === null && error === null) void scan()
  }, [items, error, scan])

  const toggle = (path: string) => {
    const next = new Set(checked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChecked(next)
  }

  const run = () => {
    setConfirming(false)
    setRunning(true)
    const selections = (items ?? []).filter((i) => checked.has(i.path)).map((i) => ({ path: i.path, digest: i.digest }))
    void apply(selections).finally(() => setRunning(false))
  }

  const totalChanges = (items ?? []).reduce((sum, i) => sum + i.changeCount, 0)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card confirm-card optimize-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">修复中文翻译损坏</div>
        <div className="modal-body mod-check-body">
          {items === null && error === null ? (
            <p className="mod-tip">正在扫描模组目录…</p>
          ) : error !== null ? (
            <div className="mod-check-error">
              <p className="mod-tip">{error}</p>
              <button className="btn primary" onClick={() => useWorkspaceStore.getState().setModDialog('translationRepair')}>重试扫描</button>
            </div>
          ) : totalChanges === 0 ? (
            <p className="mod-check-ok"><AppIcon name="check" size={14} /> 未发现可确定的翻译损坏，模组节名和字段名正常</p>
          ) : (
            <>
              <p className="mod-tip">
                共发现 {items!.length} 个文件中有 {totalChanges} 处可恢复的翻译损坏。
                工具只会恢复引擎节名前缀（如 [行动_...] → [action_...]）、字段名、明确布尔值和已知 self 逻辑标识符，
                不会修改自定义中文单位名、资源名、说明、图片文件名或未知逻辑函数。
              </p>
              <ul className="optimize-list">
                {items!.map((item) => (
                  <li key={item.path} className="optimize-item">
                    <label>
                      <input type="checkbox" checked={checked.has(item.path)} onChange={() => toggle(item.path)} />
                      <code>{item.path}</code>
                      <span className="optimize-detail">{item.changeCount} 处</span>
                    </label>
                    <ul style={{ marginLeft: 20, marginTop: 2, listStyle: 'none' }}>
                      {item.changes.slice(0, 5).map((c, i) => (
                        <li key={i} style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          L{c.line} {c.kind}: {c.before} → {c.after}
                        </li>
                      ))}
                      {item.changes.length > 5 && <li style={{ fontSize: 11, color: 'var(--text-muted)' }}>…还有 {item.changes.length - 5} 处</li>}
                    </ul>
                  </li>
                ))}
              </ul>
              {confirming && (
                <div className="optimize-confirm">
                  <p className="mod-tip">确定修复 {checked.size} 个文件中的 {totalChanges} 处翻译损坏吗？此操作会修改源文件。</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => setConfirming(false)}>再想想</button>
                    <button className="btn primary" onClick={run} disabled={running}>
                      {running ? '修复中…' : '确定修复'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {items && totalChanges > 0 && (
          <div className="modal-footer">
            {checked.size === 0 ? (
              <>
                <button className="btn" onClick={() => setChecked(new Set(items.map((i) => i.path)))}>全选</button>
                <button className="btn primary" onClick={onClose}>关闭</button>
              </>
            ) : confirming ? null : (
              <>
                <button className="btn" onClick={() => setChecked(new Set())} disabled={running}>清空选择</button>
                <button className="btn primary" onClick={() => setConfirming(true)} disabled={running}>修复选中（{checked.size}）</button>
              </>
            )}
          </div>
        )}
        {(items === null && error === null) || (items !== null && totalChanges === 0 && error === null) || (items === null && error !== null) ? (
          <div className="modal-footer">
            <button className="btn primary" onClick={onClose}>{items === null && error === null ? '取消' : '关闭'}</button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
