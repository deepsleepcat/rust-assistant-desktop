/**
 * 优化工具弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）：
 * 扫描模组内可清理项（空文件/空文件夹/.bak/空行/注释），
 * 分组勾选后批量执行。勾选即代表「删除/清理」，执行前二次确认。
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { AppIcon } from '../../../components/AppIcon'
import { useEscapeHandler } from '../../../utils/modalStack'

type OptimizeItemKind = 'emptyFile' | 'emptyFolder' | 'backupFile' | 'emptyLine' | 'comment'
interface OptimizeItem {
  id: string
  kind: OptimizeItemKind
  rel: string
  detail?: string
}

export function OptimizeModal({ onClose }: { onClose: () => void }) {
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
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
              <p className="mod-tip">共发现 {total} 项可优化内容。勾选后点击「执行优化」批量处理（删除类操作不可恢复，请先备份）。</p>
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
