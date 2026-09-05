/**
 * M13 模组质量报告弹窗（M40 巨型文件拆分：自 ModToolModals.tsx 迁出）：
 * 生成中显示加载；结果含汇总/问题清单/导出按钮。
 */
import { useEffect } from 'react'
import { useWorkspaceStore } from '../../../stores/workspace'
import { AppIcon } from '../../../components/AppIcon'
import { useEscapeHandler } from '../../../utils/modalStack'

export function ReportModal({ onClose }: { onClose: () => void }) {
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
                <div className="report-section-title">检查器汇总</div>
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
