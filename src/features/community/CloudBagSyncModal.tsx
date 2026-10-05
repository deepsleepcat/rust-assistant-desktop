import { useCallback, useEffect, useRef, useState } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import { getBridge } from '../../services/bridge'
import type { CloudBagApi, CloudBagHeadSummary, CloudBagRepo } from '../../services/cloudBagApi'
import { judgeSyncState, formatBytes, isForeignAnchor, newClientOpId, type CloudBagAnchor, type SyncState } from './cloudBagData'
import {
  listLocalChanges,
  pullRemoteVersion,
  pushLocalTree,
  readCloudBagAnchor,
  writeCloudBagAnchor,
  type PullOutcome,
  type PushOutcome,
  type SyncProgress,
} from '../../services/cloudBagSync'

/**
 * 云书包手动同步弹窗（V1 仅两个动作：发布新版本 / 拉取版本；无自动同步）。
 * 冲突界面（A 本地变更 / B 远端 head 双栏，窄窗口上下堆叠）：数据源是服务端版本清单
 * 摘要而非 <<<<<<< 标记；两个出口 = 以本地发布新版本（base=远端 head）或 放弃本地改动拉取
 * （主进程先备份再覆盖，失败自动回滚）。
 */

/**
 * 版本说明输入弹窗：Electron 渲染层把 window.prompt 覆写为直接抛错
 * （prompt 不受支持），所以发布/冲突重推必须用应用内输入框，否则点击即抛错、
 * 推送永不执行（桌面端永远创建不了第一个版本）。600 字上限与「不能为空」校验在此保留。
 */
function VersionNoteModal({ title, initial, onCancel, onSubmit }: {
  title: string
  initial: string
  onCancel: () => void
  onSubmit: (message: string) => void
}) {
  const [text, setText] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) { setError('版本说明不能为空'); return }
    onSubmit(trimmed.slice(0, 600))
  }
  return (
    <Modal title={title} onClose={onCancel} footer={<>
      <button className="btn" onClick={onCancel}>取消</button>
      <button className="btn primary" onClick={submit}>发布</button>
    </>}>
      <div className="community-form">
        <textarea
          aria-label="版本说明"
          autoFocus
          rows={4}
          maxLength={600}
          value={text}
          placeholder="版本说明（必填，最多 600 字）"
          onChange={(event) => { setText(event.target.value); setError(null) }}
        />
        <div className="local-note">{text.length}/600 字；版本说明会展示在版本列表中。</div>
        {error && <div className="community-warning">{error}</div>}
      </div>
    </Modal>
  )
}

interface SyncStateView {
  running: boolean
  phase: SyncProgress['phase'] | null
  done: number
  total: number
  currentPath?: string
  message: string | null
  error: string | null
  push?: PushOutcome
  pull?: PullOutcome
}

/** 冲突 A 栏改动类型的展示顺序（git status 缩写 → 中文，其余原样显示）。 */
const LOCAL_CHANGE_LABEL: Record<string, string> = {
  M: '修改', A: '新增', '??': '未跟踪', D: '删除', R: '重命名',
}

function ConflictChoice({ conflict, localChanges, onPushLocal, onPullRemote, busy, error }: {
  conflict: CloudBagHeadSummary
  /** 本地改动清单（git status 口径）；null = 无法检测（非 git 项目 / git 不可用） */
  localChanges: Array<{ status: string; path: string }> | null
  onPushLocal: () => void
  onPullRemote: () => void
  busy: boolean
  error: string | null
}) {
  // 后端 headSummary 是对象（versionNo/message/fileCount/totalSize/files[]，契约 §7.1）；
  // 旧声明把它写成扁平数组，读端点会 undefined 崩在这里
  const headFiles = conflict.headSummary?.files ?? []
  const headDetail = conflict.headSummary
  return (
    <div className="cloudbag-conflict" role="group" aria-label="同步冲突选择">
      {/* 契约 §6.7：A（本地变更）/ B（远端 head）双栏文件级差异清单 + 差异文件数摘要 */}
      <div className="cloudbag-conflict-col">
        <div className="community-section-title">A · 本地变更</div>
        {localChanges === null
          ? <div className="local-note">本地改动清单不可用（非 git 项目或 git 不可用）：无法逐文件核对，请以本地工作树的实际内容为准。</div>
          : localChanges.length === 0
            ? <div className="local-note">本地相对基线未检测到修改。</div>
            : <>
              <div className="local-note">本地共 {localChanges.length} 个改动文件（相对锚点基线）。</div>
              <div className="cloudbag-diff-list">{localChanges.slice(0, 50).map((file) => (
                <div className="cloudbag-diff-row" key={`a:${file.status}:${file.path}`}>
                  <span>{file.path}</span>
                  <span className="post-card-meta">{LOCAL_CHANGE_LABEL[file.status] ?? file.status}</span>
                </div>
              ))}</div>
              {localChanges.length > 50 && <div className="local-note">本地清单较长，此处只显示前 50 条。</div>}
            </>}
      </div>
      <div className="cloudbag-conflict-col">
        <div className="community-section-title">B · 远端 head（#{conflict.headVersionNo}）</div>
        {headDetail && <div className="local-note">{headDetail.message || '（无版本说明）'} · {headDetail.fileCount} 文件 · {headDetail.totalSize > 0 ? `${headDetail.totalSize} 字节` : '大小未知'}</div>}
        {/* 摘要缺失 ≠ 远端树为空：本地判定进入冲突而无服务端摘要时，「0 个文件」是误导 */}
        {!headDetail
          ? <div className="local-note">远端版本摘要不可用，无法展示文件级差异（可先拉取该版本再核对）。</div>
          : headFiles.length === 0
            ? <div className="local-note">远端 head 清单为空（0 个文件条目）。</div>
            : <div className="cloudbag-diff-list">{headFiles.slice(0, 50).map((file) => (
              <div className="cloudbag-diff-row" key={`${file.path}:${file.sha256.slice(0, 8)}`}>
                <span>{file.path}</span>
                <span className="post-card-meta">{file.sha256.slice(0, 8)}</span>
              </div>
            ))}</div>}
        {headDetail?.truncated && <div className="local-note">远端清单较长，此处只显示前 {headFiles.length} 条（摘要已截断）。</div>}
      </div>
      {error && <div className="community-warning">{error}</div>}
      <div className="cloudbag-unsupported-row">
        <button className="btn primary" disabled={busy} onClick={onPushLocal}>以本地发布新版本（先核对差异）</button>
        <button className="btn" disabled={busy} onClick={onPullRemote}>放弃本地改动，拉取远端（先自动备份）</button>
      </div>
      <div className="local-note">V1 无自动合并：必须二选一。「放弃本地改动」会把远端 head 恢复到本地项目，被覆盖文件先备份到 .ohmytx/backup/。</div>
    </div>
  )
}

export function CloudBagSyncModal({ api, rootPath, projectName, repo, onClose, onChanged }: {
  api: CloudBagApi
  rootPath: string
  projectName: string
  repo: CloudBagRepo
  onClose: () => void
  onChanged: () => void
}) {
  const bridge = getBridge()
  const [anchor, setAnchor] = useState<CloudBagAnchor | null>(null)
  const [syncState, setSyncState] = useState<SyncStateView | null>(null)
  const [conflict, setConflict] = useState<CloudBagHeadSummary | null>(null)
  /** 本地改动清单（A 栏）：undefined=未加载，null=无法检测（非 git/git 不可用），数组=git status 清单 */
  const [localChanges, setLocalChanges] = useState<Array<{ status: string; path: string }> | null | undefined>(undefined)
  const [localState, setLocalState] = useState<SyncState>('unbound')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notePrompt, setNotePrompt] = useState<{ title: string; initial: string; baseVersionNo: number } | null>(null)
  const abortRef = useRef(false)
  /** 同一次逻辑推送的幂等键：同一 base 的失败重试必须复用同一个 client_op_id，
   * 服务端的幂等重放（响应丢失但版本已落库）才生效，避免重试多建一个重复版本。 */
  const opIdRef = useRef<{ base: number; id: string } | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const loaded = await readCloudBagAnchor(bridge, rootPath).catch(() => null)
      if (!alive) return
      setAnchor(loaded)
      // 一次取数两用：清单（冲突 A 栏）+ 是否有改动（四分态判定）。
      // listLocalChanges 返回 null = 无法检测（非 git 项目 / git 不可用），
      // judgeSyncState 会保守落 local-ahead/conflict，绝不谎报 clean。
      const changes = await listLocalChanges(bridge, rootPath).catch(() => null)
      if (!alive) return
      setLocalChanges(changes)
      // repoSlug 必须参与判定：锚点绑定的是仓库 A 时，用仓库 B 的 head 比较基线会得到
      // clean / remote-ahead 这类假状态，并允许把 B 的树覆盖进绑定 A 的项目（静默改绑）。
      setLocalState(judgeSyncState({ anchor: loaded, repoSlug: repo.slug, remoteHeadVersionNo: repo.headVersionNo, localChanged: changes === null ? null : changes.length > 0 }))
    })()
    return () => { alive = false }
  }, [bridge, rootPath, repo.headVersionNo, repo.slug])

  const runPush = useCallback(async (baseVersionNo: number, text: string) => {
    abortRef.current = false
    setBusy(true)
    setError(null)
    setConflict(null)
    setSyncState({ running: true, phase: 'reading', done: 0, total: 0, message: null, error: null })
    const previous = opIdRef.current
    const clientOpId = previous && previous.base === baseVersionNo ? previous.id : newClientOpId()
    opIdRef.current = { base: baseVersionNo, id: clientOpId }
    const outcome = await pushLocalTree({
      api,
      bridge,
      rootPath,
      repoSlug: repo.slug,
      onProgress: (progress) => setSyncState((current) => ({ ...(current ?? { running: true, message: null, error: null, phase: null, done: 0, total: 0 }), ...progress })),
      isAborted: () => abortRef.current,
    }, { message: text, baseVersionNo, clientOpId })
    setBusy(false)
    setSyncState((current) => ({ ...(current ?? { running: false, phase: null, done: 0, total: 0, message: null, error: null }), running: false, push: outcome }))
    if (outcome.status === 'pushed' && outcome.versionNo) {
      // 提交已确认：下一次推送是新的一次逻辑操作，换新幂等键
      opIdRef.current = null
      const nextAnchor: CloudBagAnchor = {
        repoSlug: repo.slug,
        baselineSeq: outcome.versionNo,
        baselineTreeDigest: '',
        lastSyncedAt: Math.floor(Date.now() / 1000),
      }
      await writeCloudBagAnchor(bridge, rootPath, nextAnchor).then(
        () => {
          setAnchor(nextAnchor)
          setLocalState('clean')
          setMessage(`已发布新版本 #${outcome.versionNo}（${outcome.uploaded.length} 个文件）。`)
          // 成功后必须重取本地清单：基线已推进到新版本，旧清单（可能是提交前的
          // local-ahead 改动，或 null=无法检测）已陈旧，不刷新会与 clean 状态并存。
          void listLocalChanges(bridge, rootPath).then(setLocalChanges).catch(() => setLocalChanges(null))
        },
        (anchorError: unknown) => {
          // 服务端已成功，但本地锚点没落盘：基线丢失，必须显式告知而不是假成功
          setAnchor(null)
          setLocalState('unbound')
          setError(`版本已发布 #${outcome.versionNo}，但本地锚点写入失败（${anchorError instanceof Error ? anchorError.message : String(anchorError)}）：下次打开会显示未绑定，请重试同步以重建基线。`)
        },
      )
      onChanged()
    } else if (outcome.status === 'conflict') {
      setConflict(outcome.conflict ?? { headVersionNo: repo.headVersionNo })
      // 冲突面板出现后不能残留「正在提交版本…」的陈旧进度文案（按钮实际已可用）
      setSyncState((current) => (current ? { ...current, phase: null } : current))
      // A 栏取推送时刻的最新本地清单：判定与推送之间用户可能又改了文件
      void listLocalChanges(bridge, rootPath).then((changes) => setLocalChanges(changes))
    } else if (outcome.status === 'failed') {
      setError(outcome.error ?? '推送失败')
    } else if (outcome.status === 'aborted') {
      setMessage('已取消同步')
    }
  }, [api, bridge, onChanged, repo.headVersionNo, repo.slug, rootPath])

  const runPull = useCallback(async (versionNo: number) => {
    abortRef.current = false
    setBusy(true)
    setError(null)
    setConflict(null)
    setSyncState({ running: true, phase: 'downloading', done: 0, total: 1, message: null, error: null })
    const outcome = await pullRemoteVersion({
      api,
      bridge,
      rootPath,
      repoSlug: repo.slug,
      onProgress: (progress) => setSyncState((current) => ({ ...(current ?? { running: true, message: null, error: null, phase: null, done: 0, total: 0 }), ...progress })),
      isAborted: () => abortRef.current,
    }, { versionNo })
    setBusy(false)
    setSyncState((current) => ({ ...(current ?? { running: false, phase: null, done: 0, total: 0, message: null, error: null }), running: false, pull: outcome }))
    if (outcome.status === 'pulled') {
      const nextAnchor: CloudBagAnchor = {
        repoSlug: repo.slug,
        baselineSeq: outcome.versionNo ?? versionNo,
        baselineTreeDigest: '',
        lastSyncedAt: Math.floor(Date.now() / 1000),
      }
      await writeCloudBagAnchor(bridge, rootPath, nextAnchor).then(
        () => {
          setAnchor(nextAnchor)
          setLocalState('clean')
          // 同推送分支：拉取后本地树已被远端覆盖，重取清单避免陈旧改动/未知态与 clean 并存。
          void listLocalChanges(bridge, rootPath).then(setLocalChanges).catch(() => setLocalChanges(null))
          const backupNote = outcome.backupDir && ((outcome.backedUp ?? 0) > 0 || (outcome.removed ?? 0) > 0)
            ? `备份在 ${outcome.backupDir}/（同一版本重复拉取会落到带时间戳的新目录，不覆盖旧备份）。`
            : ''
          setMessage(`已拉取版本 #${outcome.versionNo}：写入 ${outcome.written ?? 0} 个文件，备份 ${outcome.backedUp ?? 0} 个被覆盖文件，移走 ${outcome.removed ?? 0} 个远端已不含的模版资产文件。${backupNote}`)
        },
        (anchorError: unknown) => {
          setAnchor(null)
          setLocalState('unbound')
          setError(`已拉取版本 #${outcome.versionNo}，但本地锚点写入失败（${anchorError instanceof Error ? anchorError.message : String(anchorError)}）：下次打开会显示未绑定，请重试同步以重建基线。`)
        },
      )
      onChanged()
    } else if (outcome.status === 'failed') {
      setError(outcome.error ?? '拉取失败')
    } else {
      setMessage('已取消拉取')
    }
  }, [api, bridge, onChanged, repo.slug, rootPath])

  const repoHead = repo.headVersionNo
  /** 本地锚点绑定的是**另一个**仓库：四分态一律按未绑定处理，且任何会覆写锚点的动作
   * 都必须先显式确认「改绑 + 重设基线」，绝不静默改绑（否则项目会无声丢失原仓库的基线）。 */
  const foreignAnchor = isForeignAnchor(anchor, repo.slug) ? anchor : null
  const summary = anchor
    ? foreignAnchor
      ? `本项目已绑定仓库「${foreignAnchor.repoSlug}」（基线版本 #${foreignAnchor.baselineSeq}），与当前仓库「${repo.slug}」不是同一个`
      : `绑定仓库 ${anchor.repoSlug} · 基线版本 #${anchor.baselineSeq}`
    : '本地项目尚未绑定云书包仓库（发布第一个版本后自动绑定）'
  const stateLabel: Record<SyncState, string> = {
    unbound: foreignAnchor ? '未绑定到本仓库' : '未绑定',
    clean: '本地与远端一致',
    'local-ahead': '本地有未发布修改',
    'remote-ahead': '远端有新版本可拉取',
    conflict: '双向都有修改（冲突）',
  }
  // 四分态收敛动作（契约 §6.4）：状态不只用于显示，必须约束可点的动作
  const publishAllowed = localState === 'unbound' || localState === 'local-ahead'
  const pullAllowed = localState !== 'clean' && localState !== 'conflict'
  const STATE_HINTS: Record<SyncState, string> = {
    unbound: foreignAnchor
      ? `本项目当前绑定仓库「${foreignAnchor.repoSlug}」（基线 #${foreignAnchor.baselineSeq}），与「${repo.slug}」不同，因此不按本仓库的 head 判定四分态。发布会以本仓库为基线重设绑定；拉取会先用本仓库的版本覆盖项目文件。两者都会把绑定改为「${repo.slug}」并重设基线，点击后需再确认一次。`
      : '本地项目尚未绑定该仓库：可发布首版本，或先拉取远端版本建立基线。',
    clean: '本地与远端一致，无需同步。',
    'local-ahead': '仅本地有修改：建议发布新版本；拉取会覆盖本地修改（先自动备份）。',
    'remote-ahead': '仅远端有新版本：请拉取；发布需先拉取以免乐观锁冲突。',
    conflict: '双向都有修改：请在下方冲突界面二选一（V1 无自动合并）。',
  }
  const stateHint = STATE_HINTS[localState]
  // 冲突既可能来自本次推送返回，也可能是打开弹窗时判定的四分态（无 head 摘要时用版本号占位）
  const conflictView: CloudBagHeadSummary | null = conflict ?? (localState === 'conflict' ? { headVersionNo: repoHead } : null)
  const REBIND_NOTICE = foreignAnchor
    ? `注意：本项目「${projectName}」当前绑定的是仓库「${foreignAnchor.repoSlug}」（基线 #${foreignAnchor.baselineSeq}）。继续会把绑定改为当前仓库「${repo.slug}」并重设基线（原仓库的基线不再保留在本地锚点里）。`
    : ''
  /** 拉取会做的事：覆盖 zip 内文件 + 把本地存在但远端没有的**可表示**文件移入备份。
   * 本地无法被云书包表示的文件（白名单外类型/超限/非 UTF-8）留在本地不动。 */
  const PULL_NOTICE = '拉取会用远端版本覆盖本地项目：被覆盖文件先备份到 .ohmytx/backup/；本地存在但远端版本没有的模版资产文件会被移入同一备份目录（等效删除，可从备份取回）。不在云书包白名单内/超过 50 MiB/非 UTF-8 的本地文件不会被移走。'
  const requestPull = (versionNo: number) => {
    if (foreignAnchor) {
      if (!window.confirm(`${REBIND_NOTICE}\n\n${PULL_NOTICE}\n\n继续？`)) return
    } else if (localState === 'local-ahead') {
      if (!window.confirm('拉取会覆盖本地未发布的修改（被覆盖文件先自动备份到 .ohmytx/backup/）。继续？')) return
    } else if (!window.confirm(PULL_NOTICE)) {
      return
    }
    void runPull(versionNo)
  }
  const requestPush = (versionNo: number, title: string) => {
    if (foreignAnchor && !window.confirm(`${REBIND_NOTICE}\n\n继续？`)) return
    setNotePrompt({ title, initial: '更新模组内容', baseVersionNo: versionNo })
  }

  return (
    <Modal wide title={<span><AppIcon name="cloud" size={15} /> 云书包同步 · {repo.title}</span>} onClose={onClose} footer={<>
      {/* 协作式取消必须随时可点：busy 时禁用会让取消永远无法发出（运行中恰被禁用）。
          语义是「发出取消后完成当前文件即停」（IPC 发出后不可中断），空闲时点击无害
          （下一次 run 会重置标记）。 */}
      <button className="btn" onClick={() => { abortRef.current = true }} title="发出取消：完成当前文件后停止上传/下载（传输中的单个文件不可中断）">取消同步</button>
      <button className="btn" onClick={onClose}>关闭</button>
    </>}>
      <div className="local-note">{summary} · 本地项目：{projectName} · 状态：{stateLabel[localState]}</div>
      {/* 四分态（契约 §6.4）约束动作而不只是显示：仅本地变→引导发布；仅远端新→拉取；
          双向变→二选一；clean→无动作。 */}
      <div className="local-note" role="status">{stateHint}</div>
      {/* 非 git 项目 / git 不可用：改动检测结果未知，四分态按「可能有修改」保守处理，必须明示而不是谎报「一致」。
          clean 例外：刚刚成功的推送/拉取已把基线推进到该版本、本地树即所提交/所拉取的树，
          此时再挂「可能有未发布修改」的保守提示会与 clean 自相矛盾。 */}
      {anchor && !foreignAnchor && localChanges === null && localState !== 'unbound' && localState !== 'clean' && (
        <div className="local-note">本地改动无法自动检测（非 git 项目或 git 不可用）：已按「可能有未发布修改」保守处理，请以本地工作树实际内容为准。</div>
      )}
      {!conflictView && (
        <div className="cloudbag-unsupported-row">
          <button
            className={publishAllowed ? 'btn primary' : 'btn'}
            disabled={busy || !publishAllowed}
            onClick={() => requestPush(repoHead, foreignAnchor ? `以本地项目绑定到「${repo.slug}」并发布` : '从本地发布新版本')}
            title={publishAllowed
              ? '把本地修改上传为新版本（乐观锁 base=head）'
              : localState === 'remote-ahead' ? '远端已有新版本，请先拉取（避免乐观锁冲突）'
              : localState === 'conflict' ? '双向都有修改，请在下方冲突界面二选一'
              : '本地与远端一致，无需发布'}
          >
            <AppIcon name="upload" size={12} /> 发布新版本
          </button>
          <button
            className={localState === 'remote-ahead' ? 'btn primary' : 'btn'}
            disabled={busy || repoHead <= 0 || !pullAllowed}
            onClick={() => requestPull(repoHead)}
            title={repoHead <= 0 ? '仓库还没有版本' : pullAllowed ? '下载远端 head 并恢复到本地项目（先备份）' : '本地与远端一致，无需拉取'}
          >
            拉取版本
          </button>
        </div>
      )}
      {syncState && (
        <div className="cloudbag-sync-progress" role="status">
          {syncState.phase === 'uploading' || syncState.phase === 'hashing' || syncState.phase === 'reading'
            ? <>上传进度：{syncState.done}/{syncState.total} {syncState.currentPath ? `· ${syncState.currentPath}` : ''}</>
            : syncState.phase === 'committing' ? '正在提交版本…'
            : syncState.phase === 'downloading' ? '正在下载 .rwmod…'
            : syncState.phase === 'restoring' ? '正在恢复到本地项目…'
            : syncState.phase === 'done' ? '同步完成' : ''}
          {syncState.running && syncState.phase !== null && <div className="local-note">需要停止时点「取消同步」：完成当前文件后停止（传输中的单个文件不可中断）。</div>}
        </div>
      )}
      {syncState?.push && (syncState.push.skippedBinary.length > 0 || syncState.push.oversized.length > 0 || syncState.push.unsupported.length > 0) && (
        <div className="cloudbag-diff-list">
          {syncState.push.oversized.map((path) => <div className="cloudbag-diff-row" key={`o:${path}`}><span className="badge warning">超过 50 MiB</span><span>{path}</span></div>)}
          {syncState.push.unsupported.map((path) => <div className="cloudbag-diff-row" key={`u:${path}`}><span className="badge warning">类型不支持</span><span>{path}</span></div>)}
          {syncState.push.skippedBinary.map((path) => <div className="cloudbag-diff-row" key={`b:${path}`}><span className="badge">已跳过</span><span>{path}</span></div>)}
        </div>
      )}
      {syncState?.pull && (syncState.pull.skipped?.length ?? 0) > 0 && (
        <div className="cloudbag-diff-list">
          {syncState.pull.skipped?.map((path) => <div className="cloudbag-diff-row" key={`s:${path}`}><span className="badge warning">已跳过（噪声/锚点）</span><span>{path}</span></div>)}
        </div>
      )}
      {/* 被移走的文件逐条回显：只给「移走 N 个」的数字时，用户无法知道哪些文件离开了工作树 */}
      {syncState?.pull && (syncState.pull.movedList?.length ?? 0) > 0 && (
        <div className="cloudbag-diff-list">
          {syncState.pull.movedList?.map((path) => (
            <div className="cloudbag-diff-row" key={`m:${path}`}><span className="badge warning">已移入备份（远端已不含）</span><span>{path}</span></div>
          ))}
        </div>
      )}
      {message && <div className="local-note community-warning" role="status">{message}</div>}
      {/* 「知道了」必须真的关掉错误面板：旧实现清的是 message（此处恒空），按钮点不动 */}
      {error && !conflictView && <PanelState kind="error" title="同步失败" description={error} onRetry={() => setError(null)} retryLabel="知道了" />}
      {conflictView && (
        <ConflictChoice
          conflict={conflictView}
          localChanges={localChanges ?? null}
          busy={busy}
          error={error}
          onPushLocal={() => requestPush(conflictView.headVersionNo, '以远端新版本为基础发布')}
          onPullRemote={() => {
            if (!window.confirm('「放弃本地改动」会把远端 head 覆盖到本地项目，本地未发布的修改会先备份到 .ohmytx/backup/。继续？')) return
            void runPull(conflictView.headVersionNo)
          }}
        />
      )}
      <div className="local-note">
        同步仅手动触发；不做文件监听与自动上传。桌面 V1 单文件与单次导出/拉取上限均为 {formatBytes(50 * 1024 * 1024)}
        （服务端导出上限为 512 MiB，更大的仓库请在社区网页端操作）。非 UTF-8 编码（GBK/ANSI）的文本文件会被跳过而不改写上传。
      </div>
      {notePrompt && (
        <VersionNoteModal
          title={notePrompt.title}
          initial={notePrompt.initial}
          onCancel={() => setNotePrompt(null)}
          onSubmit={(message) => {
            const base = notePrompt.baseVersionNo
            setNotePrompt(null)
            void runPush(base, message)
          }}
        />
      )}
    </Modal>
  )
}
