/**
 * 版本差异视图（M17，P2 任务 1）：两个游戏版本之间代码表字段差异一览。
 * - 顶部选择起始/目标版本（默认 1.15 → 最新）
 * - 三类差异：新增字段 / 弃用字段（带迁移建议）/ 改版替代关系
 * - 「生成升级改动清单」：扫描当前项目，列出用到弃用/新增字段的位置，可导出文本
 * - 「设置目标版本」：与版本兼容检查联动（设置后编辑器 lint 立即生效）
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { useEscapeHandler } from '../../utils/modalStack'
import { getBridge } from '../../services/bridge'
import { getGameVersions, loadCodeData } from '../../services/codeData'
import { getVersionDiff, buildUpgradeReport, upgradeReportToText, type UpgradeReport } from '../../services/versionDiff'

interface Props {
  onClose: () => void
}

export function VersionDiffModal({ onClose }: Props) {
  const updateSettings = useWorkspaceStore((s) => s.updateSettings)
  const notify = useWorkspaceStore((s) => s.notify)
  const project = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId))

  const [versions, setVersions] = useState<Array<{ versionName: string; versionNumber: number }>>([])
  const [ready, setReady] = useState(false)
  const [fromName, setFromName] = useState('1.15')
  const [toName, setToName] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  // 升级报告状态：idle / running / done / error
  const [reportBusy, setReportBusy] = useState(false)
  const [report, setReport] = useState<UpgradeReport | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  useEscapeHandler(onClose)

  useEffect(() => {
    let alive = true
    void loadCodeData().then(() => {
      if (!alive) return
      const list = getGameVersions()
      setVersions(list)
      if (list.length > 0) {
        // 默认对比：1.15（存在时）→ 最新；目标版本跟随当前设置
        const target = useWorkspaceStore.getState().settings.targetGameVersion
        const validTarget = target && list.some((v) => v.versionName === target) ? target : ''
        setFromName(list.some((v) => v.versionName === '1.15') ? '1.15' : list[0].versionName)
        setToName(validTarget || list[list.length - 1].versionName)
      }
      setReady(true)
    })
    return () => {
      alive = false
    }
  }, [])

  // 差异结果（版本选择非法时 error 非空，界面禁用生成报告）
  const { diff, diffError } = useMemo(() => {
    if (!ready || versions.length === 0 || !fromName || !toName) return { diff: null, diffError: null }
    try {
      return { diff: getVersionDiff(fromName, toName), diffError: null }
    } catch (err) {
      return { diff: null, diffError: err instanceof Error ? err.message : String(err) }
    }
  }, [ready, versions, fromName, toName])

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(text)
      setTimeout(() => setCopied(null), 1200)
    })
  }

  /** 生成当前项目的「升级到目标版本改动清单」 */
  const runUpgradeReport = async () => {
    if (!project || !diff) return
    setReportBusy(true)
    setReport(null)
    setReportError(null)
    setProgress({ done: 0, total: 1 })
    try {
      const r = await buildUpgradeReport(project.rootPath, diff.from.versionName, diff.to.versionName, {
        projectName: project.name,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setReport(r)
    } catch (err) {
      setReportError(err instanceof Error ? err.message : String(err))
    } finally {
      setReportBusy(false)
    }
  }

  const exportReport = async () => {
    if (!report) return
    const text = upgradeReportToText(report)
    await getBridge().project.saveText('导出版本升级改动清单', `升级清单-${report.meta.fromVersion}-到-${report.meta.toVersion}.txt`, text)
  }

  /** 设置目标游戏版本（与编辑器版本兼容检查联动） */
  const setAsTarget = () => {
    if (!toName) return
    updateSettings({ targetGameVersion: toName })
    notify(`目标游戏版本已设为 ${toName}（编辑器版本兼容提示立即生效）`)
  }

  const mustFixCount = report?.mustFixCount ?? 0

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card vdiff-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">版本差异对比</div>
        <div className="modal-body vdiff-body">
          {!ready ? (
            <p className="codetable-empty">正在加载版本数据…</p>
          ) : versions.length === 0 ? (
            <p className="codetable-empty">版本数据不可用（离线数据缺失，重启应用后重试）</p>
          ) : (
            <>
              <div className="vdiff-toolbar">
                <label className="vdiff-select">
                  起始版本
                  <select value={fromName} onChange={(e) => setFromName(e.target.value)}>
                    {versions.map((v) => (
                      <option key={v.versionNumber} value={v.versionName}>
                        {v.versionName}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="vdiff-arrow">→</span>
                <label className="vdiff-select">
                  目标版本
                  <select value={toName} onChange={(e) => setToName(e.target.value)}>
                    {versions.map((v) => (
                      <option key={v.versionNumber} value={v.versionName}>
                        {v.versionName}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="btn" onClick={setAsTarget} title="把目标版本写入设置，版本兼容检查立即生效">
                  <AppIcon name="check" size={12} />
                  设为目标版本
                </button>
                {project ? (
                  <button className="btn primary" disabled={reportBusy || !diff || !!diffError} onClick={() => void runUpgradeReport()}>
                    <AppIcon name="tools" size={12} />
                    {reportBusy ? `生成中… ${progress ? `${progress.done}/${progress.total}` : ''}` : '生成升级改动清单'}
                  </button>
                ) : (
                  <span className="vdiff-hint">打开项目后可生成升级改动清单</span>
                )}
              </div>

              {diffError && <div className="setting-error">版本选择无效：{diffError}</div>}

              {diff && (
                <>
                  <div className="vdiff-stats">
                    <span className="vdiff-stat add">新增 {diff.added.length}</span>
                    <span className="vdiff-stat del">弃用 {diff.removed.length}</span>
                    <span className="vdiff-stat rep">替代 {diff.replaced.length}</span>
                    <span className="grow" />
                    <span className="vdiff-hint">
                      {diff.from.versionName}（{diff.from.versionNumber}）→ {diff.to.versionName}（{diff.to.versionNumber}）
                    </span>
                  </div>

                  <div className="vdiff-groups">
                    <div className="vdiff-group">
                      <div className="vdiff-group-title">
                        <span className="vdiff-badge add">新增字段</span>
                        <span className="vdiff-desc">目标版本开始可用的字段（旧版本游戏会忽略）</span>
                      </div>
                      {diff.added.length === 0 ? (
                        <p className="codetable-empty">无</p>
                      ) : (
                        diff.added.map((c) => (
                          <div key={c.code} className="vdiff-row" onClick={() => copy(c.code)} title="点击复制键名">
                            <code className="vdiff-code">{c.code}</code>
                            {c.translate && <span className="vdiff-zh">{c.translate}</span>}
                            <span className="vdiff-meta">{c.section.split(',')[0]}</span>
                            <span className="vdiff-meta">{c.type}</span>
                            <span className="vdiff-version add">v{c.version}</span>
                            <span className="grow" />
                            <span className="vdiff-desc">{c.description}</span>
                          </div>
                        ))
                      )}
                    </div>

                    <div className="vdiff-group">
                      <div className="vdiff-group-title">
                        <span className="vdiff-badge del">弃用字段</span>
                        <span className="vdiff-desc">目标版本已失效的字段，带迁移建议</span>
                      </div>
                      {diff.removed.length === 0 ? (
                        <p className="codetable-empty">无（当前数据没有标记弃用的字段）</p>
                      ) : (
                        diff.removed.map((c) => (
                          <div key={c.code} className="vdiff-row" onClick={() => copy(c.code)} title="点击复制键名">
                            <code className="vdiff-code">{c.code}</code>
                            {c.translate && <span className="vdiff-zh">{c.translate}</span>}
                            <span className="vdiff-meta">{c.section.split(',')[0]}</span>
                            <span className="vdiff-version del">v{c.version} 移除</span>
                            <span className="grow" />
                            <span className="vdiff-desc">{c.description}</span>
                            {c.migrateTo && <div className="vdiff-migrate">迁移建议：改用 <code>{c.migrateTo}</code>{c.migrateHint ? `（${c.migrateHint}）` : ''}</div>}
                          </div>
                        ))
                      )}
                    </div>

                    {diff.replaced.length > 0 && (
                      <div className="vdiff-group">
                        <div className="vdiff-group-title">
                          <span className="vdiff-badge rep">改版替代</span>
                          <span className="vdiff-desc">官方描述声明的旧名→现名替代（历史全量，不限于本次版本窗口）</span>
                        </div>
                        {diff.replaced.map((p) => (
                          <div key={`${p.oldCode}->${p.newCode}`} className="vdiff-row" onClick={() => copy(p.newCode)} title="点击复制新键名">
                            <code className="vdiff-code old">{p.oldCode}</code>
                            {p.oldTranslate && <span className="vdiff-zh">{p.oldTranslate}</span>}
                            <span className="vdiff-arrow">→</span>
                            <code className="vdiff-code">{p.newCode}</code>
                            {p.newTranslate && <span className="vdiff-zh">{p.newTranslate}</span>}
                            <span className="vdiff-version add">v{p.newVersion} 起</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {report && (
                    <div className="vdiff-report">
                      <div className="vdiff-report-title">
                        <span>升级改动清单（{report.meta.fromVersion} → {report.meta.toVersion}）</span>
                        <span className="vdiff-stat del">必须处理 {mustFixCount}</span>
                        <span className="vdiff-stat add">新增字段引用 {report.newFieldCount}</span>
                        <span className="grow" />
                        <button className="btn" onClick={() => void exportReport()}>
                          <AppIcon name="download" size={12} />
                          导出文本
                        </button>
                      </div>
                      {report.items.length === 0 ? (
                        <p className="codetable-empty">项目里没有用到本次版本差异涉及的字段 ✓</p>
                      ) : (
                        <div className="vdiff-report-list">
                          {report.items.map((it, idx) => (
                            <div key={idx} className={`vdiff-report-item ${it.kind === 'must_migrate' ? 'must' : 'new'}`}>
                              <span className="vdiff-report-kind">{it.kind === 'must_migrate' ? '必须处理' : '可选用'}</span>
                              <code>{it.file}{it.line > 0 ? `:${it.line}` : ''}</code>
                              <span className="vdiff-desc">{it.message}</span>
                              <span className="vdiff-desc">{it.suggestion}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {reportError && <div className="setting-error">生成失败：{reportError}</div>}
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          {copied && (
            <span className="codetable-copied">
              <AppIcon name="check" size={12} /> 已复制 {copied}
            </span>
          )}
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
