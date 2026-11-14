/**
 * Git 中心弹窗（M25，P3 任务 4；feat/git-visual-center 扩展）：
 * - 状态行：分支 / 领先落后 / 未提交改动数；非 git 仓库给出提示
 * - 历史：提交列表（作者/时间/说明），选两个提交对比差异
 * - 改动：未提交文件清单；冲突文件（含 <<<<<<< 标记）可「全部保留 A/B」解决；
 *   普通文件可回滚到 HEAD 或选中的历史提交（仅工作区该文件）
 * - 分支（feat/git-visual-center）：切换 / 新建 / 删除
 * - 云版本（feat/git-visual-center）：云书包版本列表 + 拉取任意版本覆盖本地（自动备份）
 * - 本地 git 与云书包推送双轨并存；详细同步冲突在云仓库页的同步向导处理
 */
import { useEffect, useMemo, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { PromptModal } from '../../components/Modal'
import { useEscapeHandler } from '../../utils/modalStack'
import { getBridge } from '../../services/bridge'
import { getCommunityEndpoint } from '../../services/communityConfig'
import { createCloudBagApi, type CloudBagApi, type CloudBagVersion } from '../../services/cloudBagApi'
import { acquireCloudBagOperation } from '../../services/cloudBagOperation'
import { pullRemoteVersion, readCloudBagAnchor, writeCloudBagAnchor } from '../../services/cloudBagSync'
import { cloudBagGate, type CloudBagAnchor } from '../community/cloudBagData'
import { joinProjectPath } from '../../utils/projectPath'
import { conflictMarkers, type ConflictBlock } from '../../utils/conflictMarkers'

interface Props {
  rootPath: string
  onClose: () => void
}

export function GitInfoModal({ rootPath, onClose }: Props) {
  const notify = useWorkspaceStore((s) => s.notify)
  const requestConfirm = useWorkspaceStore((s) => s.requestConfirm)
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const setActiveSurface = useWorkspaceStore((s) => s.setActiveSurface)
  const [info, setInfo] = useState<{
    available: boolean
    isRepo: boolean
    branch: string
    ahead: number
    behind: number
    changedCount: number
    branches: string[]
    hasIdentity: boolean
    hasCommits?: boolean
    message?: string
  } | null>(null)
  const [log, setLog] = useState<Array<{ hash: string; short: string; author: string; at: number; subject: string }>>([])
  const [status, setStatus] = useState<Array<{ status: string; path: string }>>([])
  const [conflicts, setConflicts] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'history' | 'changes' | 'branches' | 'cloud'>('history')
  // 对比选择（历史 tab）：最多两个提交
  const [selected, setSelected] = useState<string[]>([])
  // 回滚目标提交（改动 tab 每行按钮用）
  const [rollbackTarget, setRollbackTarget] = useState<string>('HEAD')
  // 冲突展开
  const [conflictOpen, setConflictOpen] = useState<string | null>(null)
  const [conflictContent, setConflictContent] = useState<{ file: string; blocks: ConflictBlock[] } | null>(null)
  const [diff, setDiff] = useState<{ a: string; b: string; text: string } | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  // 分支管理（feat/git-visual-center）
  const [branchPrompt, setBranchPrompt] = useState(false)
  const [branchBusy, setBranchBusy] = useState(false)
  // 云仓库版本（feat/git-visual-center）：锚点 + 版本列表 + 拉取中的版本号
  const [anchor, setAnchor] = useState<CloudBagAnchor | null>(null)
  const [cloudVersions, setCloudVersions] = useState<CloudBagVersion[] | null>(null)
  const [cloudLoading, setCloudLoading] = useState(false)
  const [cloudPulling, setCloudPulling] = useState<number | null>(null)
  const gate = cloudBagGate(communityAuth.status, communityAuth.user)
  const api = useMemo<CloudBagApi | null>(() => {
    try {
      return createCloudBagApi(getCommunityEndpoint(), undefined, () => notify('云仓库登录已失效，请重新登录'))
    } catch {
      return null
    }
  }, [notify])

  useEscapeHandler(onClose)

  useEffect(() => {
    let alive = true
    void Promise.all([getBridge().git.info(rootPath), getBridge().git.log(rootPath), getBridge().git.status(rootPath), getBridge().git.conflicts(rootPath)])
      .then(async ([i, l, st, cf]) => {
        if (!alive) return
        setInfo(i)
        setLog(l)
        setStatus(st)
        setConflicts(cf)
        setAnchor(await readCloudBagAnchor(getBridge(), rootPath))
      })
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [rootPath])

  /** 云版本列表：切到云页签且已绑定时按需加载（网络失败静默降级；先让出主线程避免同步 setState） */
  useEffect(() => {
    if (tab !== 'cloud' || !anchor || !gate.canBrowse || !api) return
    let alive = true
    void (async () => {
      await Promise.resolve()
      if (!alive) return
      setCloudLoading(true)
      try {
        const page = await api.versions(anchor.repoSlug, undefined, 30)
        if (alive) setCloudVersions(page.items)
      } catch {
        if (alive) setCloudVersions(null)
      } finally {
        if (alive) setCloudLoading(false)
      }
    })()
    return () => { alive = false }
  }, [tab, anchor, gate.canBrowse, api])

  /** 弹窗内全量刷新（写操作后调用） */
  const reloadAll = async () => {
    const [i, l, st, cf] = await Promise.all([
      getBridge().git.info(rootPath), getBridge().git.log(rootPath), getBridge().git.status(rootPath), getBridge().git.conflicts(rootPath),
    ])
    setInfo(i)
    setLog(l)
    setStatus(st)
    setConflicts(cf)
  }

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
      // 磁盘内容变了：Git 面板/状态栏摘要自动刷新
      useWorkspaceStore.getState().bumpGitChangeTick()
      notify(`已保留${side === 'ours' ? ' A' : ' B'}侧内容；到 Git 面板暂存并提交即可完成合并`)
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
          // 磁盘内容变了：Git 面板/状态栏摘要自动刷新
          useWorkspaceStore.getState().bumpGitChangeTick()
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

  // ── 分支管理（feat/git-visual-center）──────────────────────────────────────
  const checkoutBranch = async (branch: string) => {
    if (branchBusy) return
    setBranchBusy(true)
    try {
      const r = await getBridge().git.checkout(rootPath, branch)
      if (r.ok) {
        notify(`已切换到 ${branch}`)
        await reloadAll()
      } else {
        notify(`切换失败：${r.message ?? '未知错误'}`)
      }
    } finally {
      setBranchBusy(false)
    }
  }

  const createBranch = async (name: string) => {
    if (branchBusy) return
    setBranchBusy(true)
    try {
      const r = await getBridge().git.createBranch(rootPath, name.trim(), true)
      if (r.ok) {
        notify(`已创建并切换到 ${name.trim()}`)
        await reloadAll()
      } else {
        notify(`新建失败：${r.message ?? '未知错误'}`)
      }
    } finally {
      setBranchBusy(false)
    }
  }

  const deleteBranch = (branch: string) => {
    requestConfirm({
      title: '删除分支',
      message: `确定删除分支「${branch}」吗？未合并的提交会丢失。`,
      danger: true,
      confirmText: '删除',
      onConfirm: async () => {
        const r = await getBridge().git.deleteBranch(rootPath, branch)
        if (r.ok) {
          notify(`已删除分支 ${branch}`)
          await reloadAll()
        } else if (/not fully merged/i.test(r.message ?? '')) {
          // git -d 拒绝删未合并分支：引导确认后强删（-D）
          requestConfirm({
            title: '强制删除分支',
            message: `「${branch}」包含尚未合并的提交，确定连同这些提交一起丢弃吗？`,
            danger: true,
            confirmText: '强制删除',
            onConfirm: async () => {
              const fr = await getBridge().git.deleteBranch(rootPath, branch, true)
              if (fr.ok) {
                notify(`已强制删除分支 ${branch}`)
                await reloadAll()
              } else {
                notify(`删除失败：${fr.message ?? '未知错误'}`)
              }
            },
          })
        } else {
          notify(`删除失败：${r.message ?? '未知错误'}`)
        }
      },
    })
  }

  // ── 云仓库版本（feat/git-visual-center）───────────────────────────────────
  /** 拉取指定云版本覆盖本地（restore 内置备份；成功后基线锚点推进到该版本） */
  const pullCloudVersion = (versionNo: number) => {
    if (!api || !anchor) return
    requestConfirm({
      title: '拉取云仓库版本',
      message: `把项目恢复到云仓库「${anchor.repoSlug}」的版本 #${versionNo}？当前本地未推送的改动会被覆盖（被覆盖的文件自动备份到 .ohmytx/backup/）。`,
      danger: true,
      confirmText: '拉取覆盖',
      onConfirm: async () => {
        const lease = acquireCloudBagOperation(rootPath)
        if (!lease) { notify('该目录已有同步操作正在进行'); return }
        setCloudPulling(versionNo)
        try {
          const outcome = await pullRemoteVersion({
            api, bridge: getBridge(), rootPath, repoSlug: anchor.repoSlug,
            onProgress: () => undefined, isAborted: () => false, operationLease: lease,
          }, { versionNo })
          if (outcome.status === 'pulled') {
            const nextAnchor: CloudBagAnchor = {
              repoSlug: anchor.repoSlug,
              baselineSeq: outcome.versionNo ?? versionNo,
              baselineTreeDigest: outcome.treeDigest ?? '',
              lastSyncedAt: Math.floor(Date.now() / 1000),
            }
            try {
              await writeCloudBagAnchor(getBridge(), rootPath, nextAnchor)
              setAnchor(nextAnchor)
            } catch { /* 锚点写失败：下次打开走服务端基线补齐的迁移路径 */ }
            notify(`已拉取版本 #${outcome.versionNo}：写入 ${outcome.written ?? 0} 个文件，备份 ${outcome.backedUp ?? 0} 个被覆盖文件`)
            await reloadAll()
          } else {
            notify(`拉取失败：${outcome.error ?? '未知错误'}`)
          }
        } catch (err) {
          notify(`拉取失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          lease()
          setCloudPulling(null)
        }
      },
    })
  }

  const statusLabel = (code: string): string =>
    ({ M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', '??': '未跟踪', U: '冲突' }[code] ?? code)

  if (error) {
    return (
      <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card vdiff-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Git 中心</div>
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
                <span className="vdiff-hint">本地提交与云仓库推送双轨并存</span>
              </div>
              <div className="relgraph-tabs">
                <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>历史与对比</button>
                <button className={tab === 'changes' ? 'active' : ''} onClick={() => setTab('changes')}>
                  改动{conflicts.length > 0 ? `（${conflicts.length} 冲突）` : ''}
                </button>
                <button className={tab === 'branches' ? 'active' : ''} onClick={() => setTab('branches')}>分支（{info.branches.length}）</button>
                <button className={tab === 'cloud' ? 'active' : ''} onClick={() => setTab('cloud')}>云仓库版本</button>
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
                        <span className="relgraph-unit-count">{c.author}，{new Date(c.at * 1000).toLocaleString()}</span>
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
                            <button className="btn" style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => void openConflict(f.path)}>
                              <AppIcon name="edit" size={11} /> 解决冲突
                            </button>
                          )}
                          <button className="btn" style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => rollbackFile(f.path, rollbackTarget)}>
                            <AppIcon name="undo" size={11} /> 回滚
                          </button>
                        </div>
                      )
                    })
                  )}
                  {conflictOpen && conflictContent && conflictContent.file === conflictOpen && (
                    <div className="vdiff-report" style={{ marginTop: 8 }}>
                      <div className="vdiff-report-title">
                        冲突块 {conflictContent.blocks.length} 个：{conflictContent.file}
                        <span className="grow" />
                        <button className="btn" style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => void resolveConflict(conflictOpen, 'ours')}>
                          全部保留 A（当前分支）
                        </button>
                        <button className="btn" style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => void resolveConflict(conflictOpen, 'theirs')}>
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

              {tab === 'branches' && (
                <div className="relgraph-list">
                  <div className="vdiff-toolbar" style={{ marginBottom: 6 }}>
                    {/* 空仓库（无提交）分支不存在：建分支只会顶掉占位名，先引导提交 */}
                    <button className="btn" disabled={branchBusy || info.hasCommits === false} onClick={() => setBranchPrompt(true)}>
                      <AppIcon name="plus" size={12} /> 新建分支
                    </button>
                    <span className="vdiff-hint">
                      {info.hasCommits === false ? '还没有任何提交——先「全部暂存并提交」一次，分支才会真正创建' : '切换前建议先提交；工作区改动冲突时 git 会拒绝切换'}
                    </span>
                  </div>
                  <div className="relgraph-unit-list" style={{ maxHeight: 260 }}>
                    {info.branches.map((b) => (
                      <div key={b} className={`relgraph-unit${b === info.branch ? ' active' : ''}`} style={{ cursor: 'default', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="relgraph-unit-name" style={{ fontFamily: 'var(--font-mono)' }}>{b}</span>
                        <span className="relgraph-unit-file">{b === info.branch ? '当前分支' : ''}</span>
                        <span className="grow" />
                        {b !== info.branch && (
                          <>
                            <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} disabled={branchBusy} onClick={() => void checkoutBranch(b)}>切换</button>
                            <button className="btn" style={{ padding: '1px 8px', fontSize: 11 }} disabled={branchBusy} onClick={() => deleteBranch(b)}>删除</button>
                          </>
                        )}
                      </div>
                    ))}
                    {info.branches.length === 0 && <p className="codetable-empty">还没有分支（首次提交后会自动创建）</p>}
                  </div>
                </div>
              )}

              {tab === 'cloud' && (
                <div className="relgraph-list">
                  {!gate.canBrowse ? (
                    <div className="setting-error">{gate.notice}</div>
                  ) : !anchor ? (
                    <div className="setting-error">
                      本项目还未绑定云仓库——在云仓库页打开你的模组仓库并同步一次即可绑定；
                      之后「推送到云仓库」会把整个项目内容生成云端新版本。
                      <button className="btn" style={{ marginLeft: 8 }} onClick={() => { onClose(); setActiveSurface('cloudBag') }}>去云仓库</button>
                    </div>
                  ) : (
                    <>
                      <div className="vdiff-hint" style={{ marginBottom: 4 }}>
                        云仓库「{anchor.repoSlug}」的版本列表（本地基线 #{anchor.baselineSeq}）。
                        拉取任意版本会把整个项目恢复到那个版本（被覆盖文件自动备份）。
                      </div>
                      <div className="relgraph-unit-list" style={{ maxHeight: 300 }}>
                        {cloudLoading && <p className="codetable-empty">加载云版本中…</p>}
                        {!cloudLoading && cloudVersions?.length === 0 && <p className="codetable-empty">云仓库还没有版本</p>}
                        {!cloudLoading && cloudVersions?.map((v) => (
                          <div key={v.versionNo} className="relgraph-unit" style={{ cursor: 'default', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="relgraph-unit-name" style={{ fontFamily: 'var(--font-mono)' }}>#{v.versionNo}</span>
                            <span className="relgraph-unit-file">{v.message || '（无描述）'}</span>
                            <span className="relgraph-unit-count">{new Date(v.createdAt).toLocaleString()} · {v.fileCount} 文件</span>
                            {v.versionNo === anchor.baselineSeq ? (
                              <span className="vdiff-hint">本地基线</span>
                            ) : (
                              <button
                                className="btn"
                                style={{ padding: '1px 8px', fontSize: 11 }}
                                disabled={cloudPulling !== null}
                                onClick={() => pullCloudVersion(v.versionNo)}
                              >
                                <AppIcon name="download" size={11} />{cloudPulling === v.versionNo ? '拉取中…' : '拉取此版本'}
                              </button>
                            )}
                          </div>
                        ))}
                        {!cloudLoading && cloudVersions === null && <p className="codetable-empty">云版本加载失败（网络问题或未登录）</p>}
                      </div>
                    </>
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
      {branchPrompt && (
        <PromptModal
          title="新建分支"
          placeholder="分支名（如 feat/new-unit）"
          confirmText="创建并切换"
          validateName={false}
          onSubmit={(value) => { setBranchPrompt(false); void createBranch(value) }}
          onClose={() => setBranchPrompt(false)}
        />
      )}
    </div>
  )
}
