/**
 * 本地 git 辅助（M25，P3 任务 4）：历史可视化 / 冲突预览与选择 / 回滚。
 * - 状态行：分支 / 领先落后 / 未提交改动数；非 git 仓库给出提示
 * - 历史：提交列表（作者/时间/说明），选两个提交对比差异
 * - 改动：未提交文件清单；冲突文件（含 <<<<<<< 标记）可「全部保留 A/B」解决；
 *   普通文件可回滚到 HEAD 或选中的历史提交（仅工作区该文件）
 * - 仅本地单人使用；多人协作（邀请/权限）依赖服务器，不在本阶段
 */
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { useEscapeHandler } from '../../utils/modalStack'
import { getBridge } from '../../services/bridge'
import { joinProjectPath } from '../../utils/projectPath'
import { conflictMarkers, type ConflictBlock } from '../../utils/conflictMarkers'

interface Props {
  rootPath: string
  onClose: () => void
}

export function GitInfoModal({ rootPath, onClose }: Props) {
  const notify = useWorkspaceStore((s) => s.notify)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)
  const [info, setInfo] = useState<{
    available: boolean
    isRepo: boolean
    branch: string
    ahead: number
    behind: number
    changedCount: number
    branches: string[]
    message?: string
  } | null>(null)
  const [log, setLog] = useState<Array<{ hash: string; short: string; author: string; at: number; subject: string }>>([])
  const [status, setStatus] = useState<Array<{ status: string; path: string }>>([])
  const [conflicts, setConflicts] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'history' | 'changes'>('history')
  // 对比选择（历史 tab）：最多两个提交
  const [selected, setSelected] = useState<string[]>([])
  // 回滚目标提交（改动 tab 每行按钮用）
  const [rollbackTarget, setRollbackTarget] = useState<string>('HEAD')
  // 冲突展开
  const [conflictOpen, setConflictOpen] = useState<string | null>(null)
  const [conflictContent, setConflictContent] = useState<{ file: string; blocks: ConflictBlock[] } | null>(null)
  const [diff, setDiff] = useState<{ a: string; b: string; text: string } | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)

  useEscapeHandler(onClose)

  useEffect(() => {
    let alive = true
    void Promise.all([getBridge().git.info(rootPath), getBridge().git.log(rootPath), getBridge().git.status(rootPath), getBridge().git.conflicts(rootPath)])
      .then(([i, l, st, cf]) => {
        if (!alive) return
        setInfo(i)
        setLog(l)
        setStatus(st)
        setConflicts(cf)
      })
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [rootPath])

  /** 对比两个提交（或 提交 ↔ 工作区） */
  const runDiff = async (a: string, b: string) => {
    setDiffBusy(true)
    setDiff(null)
    try {
      const text = await getBridge().git.diff(rootPath, a, b)
      setDiff({ a, b, text })
    } catch (err) {
      notify(`对比失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDiffBusy(false)
    }
  }

  /** 读取冲突文件并解析标记块 */
  const openConflict = async (file: string) => {
    setConflictOpen(file)
    setConflictContent(null)
    try {
      const { content } = await getBridge().project.readFile(rootPath, joinProjectPath(rootPath, file))
      setConflictContent({ file, blocks: conflictMarkers(content) })
    } catch (err) {
      notify(`读取失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 解决冲突：全部保留 A（ours）或 B（theirs），写回工作区文件 */
  const resolveConflict = async (file: string, side: 'ours' | 'theirs') => {
    if (!conflictContent || conflictContent.file !== file) return
    try {
      const { content } = await getBridge().project.readFile(rootPath, joinProjectPath(rootPath, file))
      const blocks = conflictMarkers(content)
      if (blocks.length === 0) {
        notify('该文件已没有冲突标记')
        return
      }
      // 从后往前替换（行号随替换变化，倒序安全）；删除整块（startLine..endLine 含标记行）
      const lines = content.split(/\r?\n/)
      for (const block of [...blocks].reverse()) {
        const chosen = (side === 'ours' ? block.ours : block.theirs).split('\n')
        lines.splice(block.startLine - 1, block.endLine - block.startLine + 1, ...chosen)
      }
      await getBridge().project.writeFile(rootPath, joinProjectPath(rootPath, file), lines.join('\n'), { hasBom: false })
      setConflictOpen(null)
      setConflicts(await getBridge().git.conflicts(rootPath))
      notify(`已保留${side === 'ours' ? ' A' : ' B'}侧内容；建议在 git 里 git add 后提交`)
    } catch (err) {
      notify(`解决失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 回滚单个文件（到 HEAD 或选中的历史提交） */
  const rollbackFile = (file: string, target: string) => {
    requestConfirm({
      title: '回滚文件',
      message: `把「${file}」恢复到${target === 'HEAD' ? '最近一次提交' : `提交 ${target}`}的版本？当前未提交的修改会丢失（该操作不可撤销）。`,
      danger: true,
      confirmText: '回滚',
      onConfirm: async () => {
        const r = await getBridge().git.restore(rootPath, file, target)
        if (r.ok) {
          notify(`已回滚「${file}」`)
          // 刷新改动清单、冲突与头部统计（info 重新拉取）
          const [st, cf, inf] = await Promise.all([
            getBridge().git.status(rootPath),
            getBridge().git.conflicts(rootPath),
            getBridge().git.info(rootPath),
          ])
          setStatus(st)
          setConflicts(cf)
          setInfo(inf)
        } else {
          notify(`回滚失败：${r.message ?? '未知错误'}`)
        }
      },
    })
  }

  const statusLabel = (code: string): string =>
    ({ M: '修改', A: '新增', D: '删除', R: '重命名', '??': '未跟踪', U: '冲突' }[code] ?? code)

  if (error) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal-card vdiff-card">
          <div className="modal-header">Git 历史</div>
          <div className="modal-body">
            <div className="setting-error">加载失败：{error}</div>
          </div>
          <div className="modal-footer">
            <button className="btn primary" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    )
  }

  const notAvailable = info && (!info.available || !info.isRepo)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card vdiff-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Git 历史与回滚（本地）</div>
        <div className="modal-body vdiff-body">
          {!info ? (
            <p className="codetable-empty">加载中…</p>
          ) : notAvailable ? (
            <div className="setting-error">{info.message ?? 'git 不可用'}</div>
          ) : (
            <>
              <div className="vdiff-stats">
                <span className="vdiff-stat rep">分支 {info.branch}</span>
                {info.ahead > 0 && <span className="vdiff-stat add">领先 {info.ahead}</span>}
                {info.behind > 0 && <span className="vdiff-stat del">落后 {info.behind}</span>}
                <span className={`vdiff-stat ${info.changedCount > 0 ? 'del' : 'add'}`}>{info.changedCount} 个未提交改动</span>
                <span className="grow" />
                <span className="vdiff-hint">仅本地单人使用；多人协作不在本阶段</span>
              </div>
              <div className="relgraph-tabs">
                <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>历史与对比</button>
                <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
                  改动{conflicts.length > 0 ? `（${conflicts.length} 冲突）` : ''}
                </button>
              </div>

              {tab === 'history' && (
                <div className="relgraph-list">
                  <div className="vdiff-hint" style={{ marginBottom: 4 }}>
                    点击提交选中；选两个后点「对比」（再点一次可取消选中；「工作区」表示未提交的改动）。
                    差异方向：按选择的先后（第一个 → 第二个），新增/删除以第一个为基准显示。
                  </div>
                  <div className="vdiff-toolbar" style={{ marginBottom: 6 }}>
                    <button className="btn" disabled={selected.length < 2 || diffBusy} onClick={() => void runDiff(selected[0], selected[1])}>
                      <AppIcon name="search" size={12} /> 对比选中的两个提交
                    </button>
                    <button className="btn" disabled={selected.length !== 1 || diffBusy} onClick={() => void runDiff(selected[0], 'working')}>
                      对比选中提交与工作区
                    </button>
                    {selected.length > 0 && (
                      <button className="btn" onClick={() => setSelected([])}>清空选择</button>
                    )}
                  </div>
                  <div className="relgraph-unit-list" style={{ maxHeight: 180 }}>
                    {log.map((c) => (
                      <button
                        key={c.hash}
                        className={`relgraph-unit${selected.includes(c.hash) ? ' active' : ''}`}
                        onClick={() =>
                          setSelected((prev) => (prev.includes(c.hash) ? prev.filter((h) => h !== c.hash) : [...prev, c.hash].slice(-2)))
                        }
                      >
                        <span className="relgraph-unit-name" style={{ fontFamily: 'var(--font-mono)' }}>{c.short}</span>
                        <span className="relgraph-unit-file">{c.subject}</span>
                        <span className="relgraph-unit-count">{c.author} · {new Date(c.at * 1000).toLocaleString()}</span>
                      </button>
                    ))}
                    {log.length === 0 && <p className="codetable-empty">还没有提交</p>}
                  </div>
                  {diff && (
                    <div className="relgraph-canvas" style={{ justifyContent: 'flex-start', padding: 8 }}>
                      <pre className="git-diff-pre">{diff.text || '（两个版本内容一致）'}</pre>
                    </div>
                  )}
                </div>
              )}

              {tab === 'changes' && (
                <div className="relgraph-list">
                  <div className="vdiff-toolbar" style={{ marginBottom: 6 }}>
                    <span className="vdiff-hint">回滚目标：</span>
                    <select value={rollbackTarget} onChange={(e) => setRollbackTarget(e.target.value)} style={{ maxWidth: 220 }}>
                      <option value="HEAD">最近一次提交（丢弃未提交改动）</option>
                      {log.slice(0, 10).map((c) => (
                        <option key={c.hash} value={c.hash}>{c.short} {c.subject.slice(0, 30)}</option>
                      ))}
                    </select>
                  </div>
                  {status.length === 0 ? (
                    <p className="codetable-empty">工作区干净 ✓</p>
                  ) : (
                    status.map((f) => {
                      const isConflict = conflicts.includes(f.path)
                      return (
                        <div key={f.path} className={`vdiff-report-item ${isConflict ? 'must' : 'new'}`} style={{ alignItems: 'center' }}>
                          <span className={`vdiff-report-kind ${isConflict ? '' : 'rep'}`}>{isConflict ? '冲突' : statusLabel(f.status)}</span>
                          <code>{f.path}</code>
                          <span className="grow" />
                          {isConflict && (
                            <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => void openConflict(f.path)}>
                              <AppIcon name="edit" size={11} /> 解决冲突
                            </button>
                          )}
                          <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => rollbackFile(f.path, rollbackTarget)}>
                            <AppIcon name="undo" size={11} /> 回滚
                          </button>
                        </div>
                      )
                    })
                  )}
                  {conflictOpen && conflictContent && conflictContent.file === conflictOpen && (
                    <div className="vdiff-report" style={{ marginTop: 8 }}>
                      <div className="vdiff-report-title">
                        冲突块 {conflictContent.blocks.length} 个 · {conflictContent.file}
                        <span className="grow" />
                        <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => void resolveConflict(conflictOpen, 'ours')}>
                          全部保留 A（当前分支）
                        </button>
                        <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} onClick={() => void resolveConflict(conflictOpen, 'theirs')}>
                          全部保留 B（另一侧）
                        </button>
                      </div>
                      {conflictContent.blocks.slice(0, 3).map((b, i) => (
                        <div key={i} className="git-conflict-block">
                          <div className="lint-evidence">第 {b.startLine} 行起：</div>
                          <pre className="git-diff-pre conflict-ours">A：{b.ours.slice(0, 300)}{b.ours.length > 300 ? '…' : ''}</pre>
                          <pre className="git-diff-pre conflict-theirs">B：{b.theirs.slice(0, 300)}{b.theirs.length > 300 ? '…' : ''}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <span className="vdiff-hint">回滚只影响工作区指定文件，不碰其它文件与分支</span>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
