/**
 * 单位检查结果弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）。
 */
import { useEscapeHandler } from '../../../utils/modalStack'
import { AppIcon } from '../../../components/AppIcon'

export function CheckModal({
  checkResult,
  errCount,
  warnCount,
  infoCount,
  onClose,
}: {
  checkResult: import('../../../stores/workspace').WorkspaceStore['modCheckResult']
  errCount: number
  warnCount: number
  infoCount: number
  onClose: () => void
}) {
  useEscapeHandler(onClose)

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
