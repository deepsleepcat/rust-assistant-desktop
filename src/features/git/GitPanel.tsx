/**
 * Git 面板（feat/git-visual-center）：编辑器右侧的可视化 Git 中心。
 *
 * 双轨制设计（与云书包同步解耦）：
 * - 本地轨：暂存 / 提交 / 分支切换与新建 / 行数统计与差异展开（走 git:* 通道）
 * - 云轨：推送 / 拉取当前项目树到云书包（复用 pushLocalTree / pullRemoteVersion；
 *   冲突不在此展开 A/B 面板，引导到云仓库页的同步向导处理）
 *
 * 数据流沿用 GitInfoModal 的 alive 标志模式；写操作全部 {ok, message?} 结果 +
 * notify 提示；危险操作（丢弃改动/拉取覆盖）走 requestConfirm。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { PanelState } from '../../components/PanelState'
import { PromptModal } from '../../components/Modal'
import { getBridge } from '../../services/bridge'
import type { BridgeApi } from '../../types/bridge'
import { getCommunityEndpoint } from '../../services/communityConfig'
import { createCloudBagApi, type CloudBagApi } from '../../services/cloudBagApi'
import { acquireCloudBagOperation } from '../../services/cloudBagOperation'
import { pullRemoteVersion, pushLocalTree, readCloudBagAnchor, writeCloudBagAnchor } from '../../services/cloudBagSync'
import { cloudBagGate, newClientOpId, type CloudBagAnchor } from '../community/cloudBagData'
import '../../styles/gitPanel.css'

type GitInfo = Awaited<ReturnType<BridgeApi['git']['info']>>
type StatusDetail = Awaited<ReturnType<BridgeApi['git']['statusDetailed']>>[number]
type Numstat = Awaited<ReturnType<BridgeApi['git']['numstat']>>
type NumstatEntry = Numstat['unstaged'][number]

/** 行数统计片段：+N -N 或「二进制」；查不到（未跟踪文件）返回 fallback 文案 */
function NumstatView({ stat, fallback }: { stat: NumstatEntry | null; fallback?: string }) {
  if (!stat) return fallback ? <span className="gitp-numstat gitp-muted">{fallback}</span> : null
  if (stat.add === null || stat.del === null) return <span className="gitp-numstat gitp-muted">二进制</span>
  return (
    <span className="gitp-numstat">
      <span className="gitp-add">+{stat.add}</span>
      <span className="gitp-del">-{stat.del}</span>
    </span>
  )
}

export function GitPanel() {
  const project = useWorkspaceStore((s) => s.projects.find((item) => item.id === s.activeProjectId) ?? null)
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const notify = useWorkspaceStore((s) => s.notify)
  const requestConfirmAction = useWorkspaceStore((s) => s.requestConfirm)
  const setGitInfoOpen = useWorkspaceStore((s) => s.setGitInfoOpen)
  const setActiveSurface = useWorkspaceStore((s) => s.setActiveSurface)
  const refreshGitSummary = useWorkspaceStore((s) => s.refreshGitSummary)

  const rootPath = project?.rootPath
  const gate = cloudBagGate(communityAuth.status, communityAuth.user)

  // api 只依赖端点：凭据由主进程注入（与 CloudBagPanel 同构）；无效端点为 null
  const api = useMemo<CloudBagApi | null>(() => {
    try {
      return createCloudBagApi(getCommunityEndpoint(), undefined, () => notify('云仓库登录已失效，请重新登录'))
    } catch {
      return null
    }
  }, [notify])

  const [info, setInfo] = useState<GitInfo | null>(null)
  const [status, setStatus] = useState<StatusDetail[]>([])
  const [numstat, setNumstat] = useState<Numstat>({ unstaged: [], staged: [] })
  const [lastSubject, setLastSubject] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  /** 差异请求序号：慢响应不会覆盖用户点开的另一个文件（最后点击者胜） */
  const diffSeqRef = useRef(0)
  const [identityName, setIdentityName] = useState('')
  const [identityEmail, setIdentityEmail] = useState('')
  const [showIdentity, setShowIdentity] = useState(false)
  const [branchPrompt, setBranchPrompt] = useState(false)
  const [unstagedOpen, setUnstagedOpen] = useState(true)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [anchor, setAnchor] = useState<CloudBagAnchor | null>(null)
  const [cloudHead, setCloudHead] = useState<number | null>(null)
  const [cloudBusy, setCloudBusy] = useState<'push' | 'pull' | null>(null)
  const [cloudStatus, setCloudStatus] = useState<string | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    // StrictMode 双调 effect：二次 setup 必须复位存活标志，否则面板永停在加载态
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  const unstagedMap = useMemo(() => new Map(numstat.unstaged.map((e) => [e.path, e])), [numstat])
  const stagedMap = useMemo(() => new Map(numstat.staged.map((e) => [e.path, e])), [numstat])
  /** 未暂存 = 工作区有改动或未跟踪（未跟踪文件没有暂存列含义，归入未暂存区） */
  const unstaged = useMemo(() => status.filter((s) => s.untracked || s.unstaged), [status])
  const staged = useMemo(() => status.filter((s) => !s.untracked && s.staged), [status])

  /** 刷新全部本地数据 + 云端 head（网络失败静默，不阻塞本地区）。
   * 首个 await 先让出主线程：effect 首次调用时避免同步 setState（react-hooks 规则）。 */
  const refresh = useCallback(async () => {
    if (!rootPath) return
    await Promise.resolve()
    const bridge = getBridge()
    setLoading(true)
    try {
      const [nextInfo, nextStatus, nextNumstat, log] = await Promise.all([
        bridge.git.info(rootPath),
        bridge.git.statusDetailed(rootPath),
        bridge.git.numstat(rootPath),
        bridge.git.log(rootPath, 1).catch(() => []),
      ])
      if (!aliveRef.current) return
      setInfo(nextInfo)
      setStatus(nextStatus)
      setNumstat(nextNumstat)
      setLastSubject(log[0]?.subject ?? null)
      setError(null)
      const nextAnchor = await readCloudBagAnchor(bridge, rootPath)
      if (!aliveRef.current) return
      setAnchor(nextAnchor)
      if (nextAnchor && communityAuth.status === 'signed_in' && api) {
        void api.repo(nextAnchor.repoSlug)
          .then((repo) => { if (aliveRef.current) setCloudHead(repo.headVersionNo) })
          .catch(() => { if (aliveRef.current) setCloudHead(null) })
      } else {
        setCloudHead(null)
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [rootPath, api, communityAuth.status])

  useEffect(() => {
    // 定时器回调里触发：effect 体不同步 setState（react-hooks 规则），0ms 无感延迟
    const t = setTimeout(() => { void refresh() }, 0)
    return () => clearTimeout(t)
  }, [refresh])

  // 保存/回滚/解决冲突改了磁盘内容（store 计数 +1）：面板自动刷新
  // （状态栏摘要由 bumpGitChangeTick 顺带刷新）。tick===0 是首次挂载，
  // 交给上面的初始化 effect，避免重复拉取。
  const gitChangeTick = useWorkspaceStore((s) => s.gitChangeTick)
  useEffect(() => {
    if (gitChangeTick === 0) return
    const t = setTimeout(() => { void refresh() }, 0)
    return () => clearTimeout(t)
  }, [gitChangeTick, refresh])

  /** 统一收尾：刷新面板数据 + 状态栏摘要 */
  const afterChange = useCallback(() => {
    void refresh()
    void refreshGitSummary()
  }, [refresh, refreshGitSummary])

  /** 结果型写操作的统一提示（okText 为空时不弹成功提示） */
  const report = (r: { ok: boolean; message?: string }, okText: string, failText: string) => {
    if (r.ok) {
      if (okText) notify(okText)
      return true
    }
    notify(`${failText}：${r.message ?? '未知错误'}`)
    return false
  }

  const stageFile = async (path: string) => {
    if (busy) return
    setBusy(true)
    try {
      report(await getBridge().git.stage(rootPath!, [path]), '已暂存', '暂存失败')
      afterChange()
    } finally { setBusy(false) }
  }

  const unstageFile = async (path: string) => {
    if (busy) return
    setBusy(true)
    try {
      report(await getBridge().git.unstage(rootPath!, [path]), '已取消暂存', '取消暂存失败')
      afterChange()
    } finally { setBusy(false) }
  }

  const discardFile = (path: string) => {
    requestConfirmAction({
      title: '丢弃改动',
      message: `确定丢弃「${path}」的未暂存改动吗？未跟踪文件会被删除。`,
      danger: true,
      confirmText: '丢弃',
      onConfirm: async () => {
        report(await getBridge().git.discard(rootPath!, path), '已丢弃改动', '丢弃失败')
        afterChange()
      },
    })
  }

  const saveIdentity = async () => {
    if (!identityName.trim() || !identityEmail.trim()) { notify('用户名与邮箱都要填写'); return }
    const bridge = getBridge()
    if (!report(await bridge.git.configSet(rootPath!, 'user.name', identityName.trim()), '', '保存用户名失败')) return
    if (!report(await bridge.git.configSet(rootPath!, 'user.email', identityEmail.trim()), '提交者身份已保存', '保存邮箱失败')) return
    setShowIdentity(false)
    afterChange()
  }

  const runCommit = async () => {
    if (busy) return
    if (!info?.hasIdentity && !showIdentity) { setShowIdentity(true); return }
    setBusy(true)
    try {
      const bridge = getBridge()
      if (staged.length === 0) {
        if (!report(await bridge.git.stageAll(rootPath!), '', '暂存失败')) return
      }
      const r = await bridge.git.commit(rootPath!, message)
      if (r.ok) {
        notify(`已提交 ${r.hash?.slice(0, 7) ?? ''}`)
        setMessage('')
        afterChange()
      } else if (r.code === 'identity') {
        setShowIdentity(true)
        notify(r.message ?? '需要先设置提交者身份')
      } else {
        notify(`提交失败：${r.message ?? '未知错误'}`)
      }
    } finally { setBusy(false) }
  }

  const checkout = async (branch: string) => {
    if (busy || branch === info?.branch) return
    setBusy(true)
    try {
      report(await getBridge().git.checkout(rootPath!, branch), `已切换到 ${branch}`, '切换分支失败')
      afterChange()
    } finally { setBusy(false) }
  }

  const createBranch = async (name: string) => {
    const r = await getBridge().git.createBranch(rootPath!, name.trim(), true)
    if (report(r, `已创建并切换到 ${name.trim()}`, '新建分支失败')) afterChange()
  }

  const initRepo = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (report(await getBridge().git.init(rootPath!), '仓库已初始化，现在可以首次提交了', '初始化失败')) afterChange()
    } finally { setBusy(false) }
  }

  /** 展开文件行：懒加载差异（未暂存=工作区 vs HEAD；已暂存=暂存区 vs HEAD） */
  const toggleDiff = async (entry: StatusDetail, isStaged: boolean) => {
    // 展开键带分组前缀：同名文件在已暂存/未暂存两组各自独立展开
    const key = `${isStaged ? 's' : 'w'}:${entry.path}`
    if (expanded === key && diff !== null) { setExpanded(null); setDiff(null); return }
    const seq = ++diffSeqRef.current
    setExpanded(key)
    setDiff(null)
    setDiffBusy(true)
    try {
      const text = await getBridge().git.diff(rootPath!, 'HEAD', isStaged ? 'staged' : 'working', entry.path)
      if (aliveRef.current && seq === diffSeqRef.current) setDiff(text)
    } catch (err) {
      if (aliveRef.current && seq === diffSeqRef.current) setDiff(`（无法生成差异：${err instanceof Error ? err.message : String(err)}）`)
    } finally {
      if (aliveRef.current && seq === diffSeqRef.current) setDiffBusy(false)
    }
  }

  // ── 云轨：推送 / 拉取（复用云书包同步编排；冲突引导到云仓库页）──────────────
  const runCloudPush = async () => {
    if (!api || !rootPath || !anchor || cloudBusy) return
    const lease = acquireCloudBagOperation(rootPath)
    if (!lease) { notify('该目录已有同步操作正在进行'); return }
    setCloudBusy('push')
    setCloudStatus('正在扫描本地文件…')
    const bridge = getBridge()
    try {
      const repo = await api.repo(anchor.repoSlug)
      // 冲突保护：推送基线必须是本地锚点基线（本地已同步到的版本）。
      // 远端已领先时禁止以最新 head 为 base 强推——那会把过期的本地内容
      // 发布成新版本覆盖远端；交给云仓库页的同步向导二选一。
      if (repo.headVersionNo > anchor.baselineSeq) {
        notify(`云仓库已有更新的版本（云端 #${repo.headVersionNo}，本地基线 #${anchor.baselineSeq}）——请到云仓库页打开同步向导处理后再推送`)
        return
      }
      const outcome = await pushLocalTree({
        api, bridge, rootPath, repoSlug: anchor.repoSlug,
        onProgress: (p) => setCloudStatus(p.total > 0 ? `正在上传 ${p.done}/${p.total} 个文件…` : '正在上传…'),
        isAborted: () => false,
        operationLease: lease,
      }, { message: message.trim() || lastSubject || '更新模组', baseVersionNo: anchor.baselineSeq, clientOpId: newClientOpId() })
      if (outcome.status === 'pushed' && outcome.versionNo) {
        const nextAnchor: CloudBagAnchor = {
          repoSlug: anchor.repoSlug,
          baselineSeq: outcome.versionNo,
          baselineTreeDigest: outcome.treeDigest ?? '',
          lastSyncedAt: Math.floor(Date.now() / 1000),
        }
        try {
          await writeCloudBagAnchor(bridge, rootPath, nextAnchor)
          setAnchor(nextAnchor)
          setCloudHead(outcome.versionNo)
          notify(`已推送到云仓库：新版本 #${outcome.versionNo}（${outcome.uploaded.length} 个文件）`)
        } catch (anchorError) {
          setAnchor(null)
          notify(`版本已发布 #${outcome.versionNo}，但本地锚点写入失败（${anchorError instanceof Error ? anchorError.message : String(anchorError)}）：请重试同步以重建基线`)
        }
        setMessage('')
        afterChange()
      } else if (outcome.status === 'conflict') {
        notify('云仓库已有更新的版本（双向修改）——请到云仓库页打开同步向导选择保留哪一侧')
      } else if (outcome.status === 'failed') {
        notify(`推送失败：${outcome.error ?? '未知错误'}`)
      } else {
        notify('已取消推送')
      }
    } catch (err) {
      notify(`推送失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      lease()
      setCloudStatus(null)
      if (aliveRef.current) setCloudBusy(null)
    }
  }

  const runCloudPull = () => {
    if (!api || !rootPath || !anchor || cloudBusy) return
    requestConfirmAction({
      title: '从云仓库拉取',
      message: `把云仓库「${anchor.repoSlug}」最新版本覆盖到本地项目吗？被覆盖的文件会自动备份到 .ohmytx/backup/。`,
      danger: true,
      confirmText: '拉取覆盖',
      onConfirm: async () => {
        const lease = acquireCloudBagOperation(rootPath)
        if (!lease) { notify('该目录已有同步操作正在进行'); return }
        setCloudBusy('pull')
        setCloudStatus('正在下载云仓库版本…')
        const bridge = getBridge()
        try {
          const repo = await api.repo(anchor.repoSlug)
          if (repo.headVersionNo === 0) { notify('云仓库还没有版本，先推送一次'); return }
          if (repo.headVersionNo === anchor.baselineSeq) { notify('本地已与云仓库最新版本一致'); return }
          const outcome = await pullRemoteVersion({
            api, bridge, rootPath, repoSlug: anchor.repoSlug,
            onProgress: (p) => setCloudStatus(p.phase === 'downloading' ? '正在下载…' : p.phase === 'restoring' ? '正在恢复文件…' : '正在校验…'),
            isAborted: () => false,
            operationLease: lease,
          }, { versionNo: repo.headVersionNo })
          if (outcome.status === 'pulled') {
            const nextAnchor: CloudBagAnchor = {
              repoSlug: anchor.repoSlug,
              baselineSeq: outcome.versionNo ?? repo.headVersionNo,
              baselineTreeDigest: outcome.treeDigest ?? '',
              lastSyncedAt: Math.floor(Date.now() / 1000),
            }
            try {
              await writeCloudBagAnchor(bridge, rootPath, nextAnchor)
              setAnchor(nextAnchor)
              setCloudHead(nextAnchor.baselineSeq)
              notify(`已拉取版本 #${outcome.versionNo}：写入 ${outcome.written ?? 0} 个文件，备份 ${outcome.backedUp ?? 0} 个被覆盖文件`)
            } catch (anchorError) {
              setAnchor(null)
              notify(`已拉取版本 #${outcome.versionNo}，但本地锚点写入失败（${anchorError instanceof Error ? anchorError.message : String(anchorError)}）：请重试同步以重建基线`)
            }
            afterChange()
          } else if (outcome.status === 'failed') {
            notify(`拉取失败：${outcome.error ?? '未知错误'}`)
          } else {
            notify('已取消拉取')
          }
        } catch (err) {
          notify(`拉取失败：${err instanceof Error ? err.message : String(err)}`)
        } finally {
          lease()
          setCloudStatus(null)
          if (aliveRef.current) setCloudBusy(null)
        }
      },
    })
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  if (!rootPath) {
    return <section className="panel gitp-panel" aria-label="Git"><PanelState kind="empty" icon="folder" title="先打开一个模组项目" /></section>
  }

  const header = (
    <div className="panel-header gitp-header">
      <AppIcon name="code" size={13} />
      <span>Git</span>
      <span className="grow" />
      {info?.isRepo && (
        <>
          <select
            className="select gitp-branch"
            value={info.branch}
            aria-label="切换分支"
            onChange={(e) => void checkout(e.target.value)}
          >
            {info.branch && !info.branches.includes(info.branch) && <option value={info.branch}>{info.branch}</option>}
            {info.branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          {/* 空仓库（无提交）分支不存在：建分支只会顶掉占位名，先引导提交 */}
          <button
            type="button"
            className="icon-btn"
            title={info.hasCommits === false ? '还没有提交——先提交一次，分支才会真正创建' : '新建分支'}
            aria-label="新建分支"
            disabled={info.hasCommits === false}
            onClick={() => setBranchPrompt(true)}
          >
            <AppIcon name="plus" size={14} />
          </button>
        </>
      )}
      <button type="button" className="icon-btn" title="刷新" aria-label="刷新 Git 状态" onClick={() => void refresh()}>
        <AppIcon name="refresh" size={14} />
      </button>
      <button type="button" className="icon-btn" title="打开 Git 中心（历史对比 / 冲突回滚）" aria-label="打开 Git 中心" onClick={() => setGitInfoOpen(true)}>
        <AppIcon name="clock" size={14} />
      </button>
    </div>
  )

  if (loading && !info) {
    return <section className="panel gitp-panel" aria-label="Git">{header}<PanelState kind="loading" title="正在读取 Git 状态…" /></section>
  }
  if (error) {
    return (
      <section className="panel gitp-panel" aria-label="Git">
        {header}
        <PanelState kind="error" title="Git 状态读取失败" description={error} onRetry={() => void refresh()} />
      </section>
    )
  }
  if (!info?.available) {
    return (
      <section className="panel gitp-panel" aria-label="Git">
        {header}
        <PanelState kind="error" icon="warn" title="git 不可用" description={info?.message ?? '未检测到 git（需安装 Git for Windows）'} />
      </section>
    )
  }
  if (!info.isRepo) {
    return (
      <section className="panel gitp-panel" aria-label="Git">
        {header}
        <div className="gitp-body">
          <PanelState
            kind="empty"
            icon="folder"
            title="项目还不是 git 仓库"
            description="初始化后可以在这里暂存、提交、管理分支，历史随时可回滚。"
            action={<button type="button" className="btn primary" disabled={busy} onClick={() => void initRepo()}>一键初始化仓库</button>}
          />
        </div>
      </section>
    )
  }

  return (
    <section className="panel gitp-panel" aria-label="Git">
      {header}
      <div className="gitp-body">
        {/* 云轨：云书包同步状态（不阻塞本地区渲染） */}
        <div className="gitp-cloud" role="status">
          <AppIcon name="cloud" size={13} />
          {!gate.canBrowse ? (
            <span className="gitp-muted gitp-cloud-note">{gate.notice}</span>
          ) : !anchor ? (
            <>
              <span className="gitp-muted gitp-cloud-note">未绑定云仓库——在云仓库页打开你的模组仓库并同步一次即可绑定</span>
              <button type="button" className="btn-sm" onClick={() => setActiveSurface('cloudBag')}>去云仓库</button>
            </>
          ) : (
            <>
              <span className="gitp-cloud-repo" title={anchor.repoSlug}>{anchor.repoSlug}</span>
              <span className="gitp-muted">基线 #{anchor.baselineSeq}{cloudHead !== null && cloudHead > anchor.baselineSeq ? ` · 云端有新版本 #${cloudHead}` : ''}</span>
              <span className="grow" />
              <button type="button" className="btn-sm" disabled={cloudBusy !== null} title="把本地项目内容推送到云仓库（生成新版本）" onClick={() => void runCloudPush()}>
                <AppIcon name="upload" size={12} /> 推送
              </button>
              <button type="button" className="btn-sm" disabled={cloudBusy !== null} title="把云仓库最新版本覆盖到本地（自动备份）" onClick={runCloudPull}>
                <AppIcon name="download" size={12} /> 拉取
              </button>
            </>
          )}
          {cloudStatus && <div className="gitp-cloud-status">{cloudStatus}</div>}
        </div>

        {/* 身份引导（首次提交前必须配置 user.name / user.email） */}
        {(showIdentity || info.hasIdentity === false) && (
          <div className="gitp-identity">
            <div className="gitp-identity-title">提交者身份（首次提交前设置一次，保存在本仓库）</div>
            <div className="gitp-identity-row">
              <input className="input" placeholder="用户名" value={identityName} aria-label="Git 用户名" onChange={(e) => setIdentityName(e.target.value)} />
              <input className="input" placeholder="邮箱" value={identityEmail} aria-label="Git 邮箱" onChange={(e) => setIdentityEmail(e.target.value)} />
              <button type="button" className="btn-sm primary" onClick={() => void saveIdentity()}>保存</button>
              {showIdentity && info.hasIdentity && <button type="button" className="btn-sm" onClick={() => setShowIdentity(false)}>收起</button>}
            </div>
          </div>
        )}

        {/* 未暂存区 */}
        <div className="gitp-section">
          <div className="gitp-section-head">
            <button type="button" className="gitp-section-toggle" aria-expanded={unstagedOpen} onClick={() => setUnstagedOpen((v) => !v)}>
              <span>未暂存</span>
              <span className="gitp-count">{unstaged.length}</span>
            </button>
            <span className="grow" />
            <button
              type="button" className="btn-sm" disabled={busy || unstaged.length === 0}
              // 必须走 stageAll（git add -A -- .）：把几百个路径塞进一条命令会超
              // Windows 命令行长度上限（32767 字符），命令根本没跑就失败
              onClick={() => {
                void getBridge().git.stageAll(rootPath).then((r) => { report(r, '已全部暂存', '暂存失败'); afterChange() })
              }}
            >全部暂存</button>
          </div>
          {unstagedOpen && (
            unstaged.length === 0
              ? <div className="gitp-empty gitp-muted">没有未暂存的改动</div>
              : unstaged.map((entry) => (
                <GitRow
                  key={entry.path}
                  entry={entry}
                  kind={entry.untracked ? '?' : (entry.unstaged || 'M')}
                  stat={unstagedMap.get(entry.path) ?? null}
                  expanded={expanded === `w:${entry.path}`}
                  diff={expanded === `w:${entry.path}` ? diff : null}
                  diffBusy={diffBusy}
                  busy={busy}
                  onToggle={() => void toggleDiff(entry, false)}
                  onStage={() => void stageFile(entry.path)}
                  onDiscard={() => discardFile(entry.path)}
                />
              ))
          )}
        </div>

        {/* 已暂存区 */}
        <div className="gitp-section">
          <div className="gitp-section-head">
            <button type="button" className="gitp-section-toggle" aria-expanded={stagedOpen} onClick={() => setStagedOpen((v) => !v)}>
              <span>已暂存</span>
              <span className="gitp-count">{staged.length}</span>
            </button>
          </div>
          {stagedOpen && (
            staged.length === 0
              ? <div className="gitp-empty gitp-muted">暂存区为空（点「全部暂存」或文件行的 ＋）</div>
              : staged.map((entry) => (
                <GitRow
                  key={entry.path}
                  entry={entry}
                  kind={entry.staged}
                  stat={stagedMap.get(entry.path) ?? null}
                  expanded={expanded === `s:${entry.path}`}
                  diff={expanded === `s:${entry.path}` ? diff : null}
                  diffBusy={diffBusy}
                  busy={busy}
                  onToggle={() => void toggleDiff(entry, true)}
                  onUnstage={() => void unstageFile(entry.path)}
                />
              ))
          )}
        </div>

        {/* 提交区：有暂存 → 提交暂存；无暂存 → 一键全部暂存并提交 */}
        <div className="gitp-commit">
          {info.hasCommits === false && (
            <p className="gitp-muted" style={{ margin: 0, fontSize: 12 }}>
              还没有任何提交：分支和历史都要在首次提交后才会出现，先提交一次吧。
            </p>
          )}
          <textarea
            className="input gitp-message"
            placeholder="提交描述（做什么改动？为什么？）"
            value={message}
            rows={2}
            aria-label="提交描述"
            onChange={(e) => setMessage(e.target.value)}
          />
          <button type="button" className="btn primary gitp-commit-btn" disabled={busy || !message.trim()} onClick={() => void runCommit()}>
            <AppIcon name="check" size={13} />
            {staged.length > 0 ? '提交暂存的改动' : '全部暂存并提交'}
          </button>
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
    </section>
  )
}

/** 改动文件行：状态徽标 + 路径 + 行数统计 + 悬停操作 + 点击展开差异 */
function GitRow({ entry, kind, stat, expanded, diff, diffBusy, busy, onToggle, onStage, onUnstage, onDiscard }: {
  entry: StatusDetail
  kind: string
  stat: NumstatEntry | null
  expanded: boolean
  diff: string | null
  diffBusy: boolean
  busy: boolean
  onToggle: () => void
  onStage?: () => void
  onUnstage?: () => void
  onDiscard?: () => void
}) {
  const name = entry.path.split('/').pop() ?? entry.path
  const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
  return (
    <div className={`gitp-row${expanded ? ' open' : ''}`}>
      <div className="gitp-row-line">
        <button type="button" className="gitp-row-main" onClick={onToggle} aria-expanded={expanded} title={`点击${expanded ? '收起' : '展开'}差异`}>
          <span className={`gitp-badge gitp-badge-${kind === '?' ? 'untracked' : kind.toLowerCase()}`}>{kind}</span>
          <span className="gitp-row-name">{name}</span>
          {dir && <span className="gitp-row-dir gitp-muted">{dir}/</span>}
          <span className="grow" />
          <NumstatView stat={stat} fallback={kind === '?' ? '新文件' : undefined} />
        </button>
        <div className="gitp-row-actions">
          {onStage && <button type="button" className="icon-btn" title="暂存（加入本次提交）" aria-label={`暂存 ${name}`} disabled={busy} onClick={onStage}><AppIcon name="add" size={13} /></button>}
          {onUnstage && <button type="button" className="icon-btn" title="取消暂存" aria-label={`取消暂存 ${name}`} disabled={busy} onClick={onUnstage}><AppIcon name="undo" size={13} /></button>}
          {onDiscard && <button type="button" className="icon-btn" title="丢弃未暂存改动" aria-label={`丢弃 ${name} 的改动`} disabled={busy} onClick={onDiscard}><AppIcon name="cross" size={13} /></button>}
        </div>
      </div>
      {expanded && (
        <div className="gitp-diff">
          {diffBusy ? <div className="gitp-empty gitp-muted">正在生成差异…</div> : diff ? <pre className="git-diff-pre">{diff || '（无差异内容）'}</pre> : null}
        </div>
      )}
    </div>
  )
}
