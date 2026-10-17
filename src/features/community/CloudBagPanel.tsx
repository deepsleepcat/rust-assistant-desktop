import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import { useWorkspaceStore } from '../../stores/workspace'
import { createCloudBagApi, type CloudBagApi, type CloudBagRepo, type CloudBagRepoType } from '../../services/cloudBagApi'
import { importTreeToNewRepo, pushLocalTree, writeCloudBagAnchor, type SyncProgress } from '../../services/cloudBagSync'
import { getBridge } from '../../services/bridge'
import { scanLocalTree } from '../../services/cloudBagTreeState'
import type { CloudBagTreeEntry } from '../../services/cloudBagApi'
import { cloudBagGate, cloudBagPathKey, formatBytes, repoDeepLink } from './cloudBagData'
import { CloudBagRepoView } from './CloudBagRepoView'

/**
 * 云书包页签（社区面板第 5 页签）：模组仓库列表 / 创建 / 详情入口。
 * 状态机沿用社区同一套 communityAuth（不建第二状态机）：
 * offline → 真实状态说明 + 重试（真实请求），不渲染任何本地示例仓库；
 * 未登录 → 引导登录；已登录未邮箱验证 → 引导设置认证；写操作全部走 canWrite 门控。
 */

const VISIBILITY_LABELS: Record<CloudBagRepo['visibility'], string> = {
  private: '私有',
  public: '公开',
  link: '链接可见',
}
const REPO_TYPE_LABELS: Record<CloudBagRepoType, string> = {
  mod: '单模组仓',
  collection: '模组集合仓',
  asset: '素材仓',
}

function RepoCard({ repo, endpoint, onOpen }: { repo: CloudBagRepo; endpoint: string; onOpen: () => void }) {
  return (
    <article className="community-card post-card">
      <button className="post-card-main" onClick={onOpen}>
        <div className="post-card-title">
          <span>{repo.title}</span>
          <span className="badge info">{REPO_TYPE_LABELS[repo.repoType ?? 'mod'] ?? repo.repoType}</span>
          <span className="badge">{VISIBILITY_LABELS[repo.visibility] ?? repo.visibility}</span>
        </div>
        <div className="post-card-meta">
          {repo.slug} · {repo.versionCount} 版本 · {repo.fileCount} 文件 · {formatBytes(repo.totalSize)}
        </div>
        {repo.description && <p>{repo.description}</p>}
        <div className="mod-tags">{(repo.tags ?? []).map((tag) => <span className="badge" key={tag}>{tag}</span>)}</div>
      </button>
      <div className="post-card-foot">
        <span>配额 {formatBytes(repo.quota?.usedBytes ?? 0)} / {formatBytes(repo.quota?.limitBytes ?? 0)}</span>
        <span className="grow" />
        {repo.visibility === 'link'
          // aria-disabled 而非 disabled：disabled 不可聚焦，键盘/读屏/触屏用户都取不到原因
          ? <button className="btn-sm" aria-disabled="true" title="未支持：链接可见仓库需要一次性分享 token（请在社区网页创建分享）">复制链接</button>
          : <button className="btn-sm" onClick={(event) => { event.stopPropagation(); void navigator.clipboard?.writeText(repoDeepLink(endpoint, repo.slug)).catch(() => undefined) }} title={repoDeepLink(endpoint, repo.slug)}>
              复制链接
            </button>}
        <button className="btn-sm" onClick={onOpen}>打开仓库</button>
      </div>
      {repo.visibility === 'link' && <div className="local-note">链接可见仓库需要一次性分享 token 才能被他人读取；桌面 V1 未支持创建分享，请在社区网页创建。</div>}
    </article>
  )
}

function CreateRepoModal({ api, onClose, onCreated }: { api: CloudBagApi; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [slugSuggestion, setSlugSuggestion] = useState('')
  const [description, setDescription] = useState('')
  const [repoType, setRepoType] = useState<CloudBagRepoType>('mod')
  const [visibility, setVisibility] = useState<CloudBagRepo['visibility']>('private')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (!title.trim()) { setError('仓库名称不能为空'); return }
    setBusy(true)
    setError(null)
    try {
      await api.createRepo({
        title: title.trim(),
        repoType,
        slugSuggestion: slugSuggestion.trim() || undefined,
        description: description.trim(),
        visibility,
        tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 8),
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="创建模组仓库" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={busy} onClick={() => void submit()}>{busy ? '创建中…' : '创建'}</button>
    </>}>
      <div className="community-form">
        <input aria-label="仓库名称" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="名称（最多 128 字）" maxLength={128} />
        <input aria-label="仓库标识建议" value={slugSuggestion} onChange={(event) => setSlugSuggestion(event.target.value)} placeholder="标识建议（可留空，最终以服务端生成为准）" maxLength={64} />
        <input aria-label="仓库简介" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="简介（最多 500 字）" maxLength={500} />
        <select aria-label="仓库类型" value={repoType} onChange={(event) => setRepoType(event.target.value as CloudBagRepoType)}>
          <option value="mod">单模组仓（兼容旧流程）</option>
          <option value="collection">模组集合仓（整套或单个模组下载）</option>
          <option value="asset">素材仓（素材、模板、地图）</option>
        </select>
        <select aria-label="可见性" value={visibility} onChange={(event) => setVisibility(event.target.value as CloudBagRepo['visibility'])}>
          <option value="private">私有（仅成员）</option>
          <option value="public">公开（广场可见）</option>
          <option value="link">链接可见（持分享链接可读）</option>
        </select>
        <input aria-label="仓库标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签（逗号分隔，最多 8 个）" />
        {error && <div className="community-warning">{error}</div>}
      </div>
    </Modal>
  )
}

/**
 * 空态导入入口（桌面契约 §1.1/§6.1）：建仓库 → 把源目录作为初始文件树提交首版本。
 * 源目录两条路：
 * a) 当前项目目录（已在工作台打开的项目）；
 * b) 选择 .rwmod / .zip → 复用主进程 `mod:import`（内部即 importModBuffer 的全量防护：
 *    zip-slip / 20000 条目 / 128MB 单文件 / 512MB 总量 / 设备名 / 失败回滚）解包出的目录。
 * 两条路都走同一条推送链路（pushLocalTree），不新增第二条上传通道。
 */
export function ImportToCloudModal({ api, activeProjectName, activeProjectPath, onClose, onImported, onRepoCreated, initialTarget = 'new' }: {
  api: CloudBagApi
  activeProjectName: string | null
  activeProjectPath: string | null
  initialTarget?: string
  onClose: () => void
  onImported: (slug: string) => void
  /** 导入中途取消/失败但仓库已在服务端建成：仓库列表必须立即重取（否则关窗后仍见旧列表） */
  onRepoCreated: () => void
}) {
  const bridge = getBridge()
  const [source, setSource] = useState<'project' | 'rwmod' | 'folder'>(activeProjectPath ? 'project' : 'folder')
  const [title, setTitle] = useState(activeProjectName ?? '')
  const [slugSuggestion, setSlugSuggestion] = useState('')
  const [description, setDescription] = useState('')
  const [repoType, setRepoType] = useState<CloudBagRepoType>('mod')
  const [visibility, setVisibility] = useState<CloudBagRepo['visibility']>('private')
  const [tags, setTags] = useState('')
  const [note, setNote] = useState('从本地项目导入')
  const [pickedRoot, setPickedRoot] = useState<string | null>(null)
  const [target, setTarget] = useState(initialTarget)
  const [targets, setTargets] = useState<CloudBagRepo[]>([])
  const [targetsError, setTargetsError] = useState('')
  const [prefix, setPrefix] = useState('')
  const [importedSlug, setImportedSlug] = useState<string | null>(null)
  const [mergePlan, setMergePlan] = useState<{ repo: CloudBagRepo; files: CloudBagTreeEntry[]; digest: string; root: string; prefix: string; overlaps: string[] } | null>(null)
  useEffect(() => {
    let active = true
    void (async () => {
      const all: CloudBagRepo[] = []
      const seen = new Set<string>()
      for (let page = 1; ; page++) {
        if (page > 1000) throw new Error('仓库数量过多，请缩小范围后重试')
        const result = await api.repos({ mine: true, page, pageSize: 50 })
        if (!active) return
        const fresh = result.items.filter((repo) => !seen.has(repo.slug))
        if (result.items.length && !fresh.length) throw new Error('仓库列表分页未前进，请刷新后重试')
        for (const repo of fresh) seen.add(repo.slug)
        all.push(...fresh.filter((repo) => repo.myRole === 'owner' || repo.myRole === 'editor'))
        if (result.items.length < 50 || page * 50 >= (result.total ?? Infinity)) break
      }
      if (active) setTargets(all)
    })().catch((err: unknown) => { if (active) setTargetsError(err instanceof Error ? err.message : String(err)) })
    return () => { active = false }
  }, [api])
  const chooseSource = async (kind: 'project' | 'folder' | 'rwmod') => {
    if (busy) return
    if (kind === 'project') { setSource(kind); setMergePlan(null); return }
    setBusy(true); setError(null)
    try {
      const picked = kind === 'folder' ? await bridge.project.openFolderDialog() : await bridge.mod.import('archive')
      if (picked) { setSource(kind); setPickedRoot(picked.rootPath); setMergePlan(null) }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef(false)

  const submit = async () => {
    if (target === 'new' && !title.trim()) { setError('仓库名称不能为空'); return }
    if (!note.trim()) { setError('版本说明不能为空'); return }
    const rootPath = source === 'project' ? activeProjectPath : pickedRoot
    if (!rootPath) { setError('请先打开一个本地项目，或选择 .rwmod 文件'); setBusy(false); return }
    setBusy(true)
    setError(null)
    abortRef.current = false
    if (target !== 'new') {
      try {
        const repo = await api.repo(target)
        if (repo.myRole !== 'owner' && repo.myRole !== 'editor') throw new Error('你已没有目标仓库的编辑权限')
        const scan = await scanLocalTree(bridge, rootPath, { onProgress: setProgress, isCancelled: () => abortRef.current })
        if (!scan) return
        const normalizedPrefix = prefix.trim().replace(/\/$/, '')
        let plan = mergePlan
        if (!plan || plan.repo.slug !== repo.slug || plan.repo.headVersionNo !== repo.headVersionNo || plan.digest !== scan.digest || plan.root !== rootPath || plan.prefix !== normalizedPrefix) {
          const files: CloudBagTreeEntry[] = []
          if (repo.headVersionNo > 0) {
            let cursor: string | undefined
            const seen = new Set<string>()
            do {
              const result = await api.tree(repo.slug, repo.headVersionNo, cursor, 500)
              files.push(...result.items)
              cursor = result.nextCursor ?? undefined
              if (cursor && seen.has(cursor)) throw new Error('远端文件树分页异常，请重试')
              if (cursor) seen.add(cursor)
              if (abortRef.current) return
            } while (cursor)
          }
          const local = new Set(scan.entries.map((file) => (normalizedPrefix ? normalizedPrefix + '/' : '') + file.path).map(cloudBagPathKey))
          const overlaps = files.filter((file) => local.has(cloudBagPathKey(file.path))).map((file) => file.path)
          plan = { repo, files, digest: scan.digest, root: rootPath, prefix: normalizedPrefix, overlaps }
          setMergePlan(plan)
          if (overlaps.length) return
        }
        const result = await pushLocalTree({ api, bridge, rootPath, repoSlug: repo.slug, onProgress: setProgress, isAborted: () => abortRef.current }, { message: note.trim(), baseVersionNo: repo.headVersionNo, retainedFiles: plan.files, pathPrefix: plan.prefix, strict: true, expectedDigest: plan.digest })
        if (result.status !== 'pushed') throw new Error(result.status === 'conflict' ? '远端已更新，请重新比较后导入' : result.error ?? '导入已取消')
        setMergePlan(null)
        onRepoCreated()
        // 合并后的整仓可能包含来源目录没有的文件，因此不把子集绑定为整仓基线。
        onImported(repo.slug)
      } catch (err) { setMergePlan(null); setError(err instanceof Error ? err.message : String(err)) }
      finally { setBusy(false) }
      return
    }
    const outcome = await importTreeToNewRepo({
      api,
      bridge,
      rootPath,
      repoSlug: '',
      onProgress: setProgress,
      isAborted: () => abortRef.current,
    }, {
      repo: {
        title: title.trim(),
        repoType,
        slugSuggestion: slugSuggestion.trim() || undefined,
        description: description.trim(),
        visibility,
        tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 8),
      },
      message: note.trim().slice(0, 600),
    })
    setBusy(false)
    if (outcome.status === 'imported' && outcome.repo) {
      // 尽力写本地锚点（与同步弹窗同一结构）：写失败不阻断导入（服务端已成功），
      // 后果只是下次打开同步弹窗显示「未绑定」——那里有显式文案告知，不是假成功。
      let anchorFailed = false
      await writeCloudBagAnchor(bridge, rootPath, {
        repoSlug: outcome.repo.slug,
        baselineSeq: outcome.versionNo ?? 0,
        // 首版本实际提交树摘要：写入后同步弹窗可直接比较，无需再从服务端补基线
        baselineTreeDigest: outcome.treeDigest ?? '',
        lastSyncedAt: Math.floor(Date.now() / 1000),
      }).catch((err: unknown) => {
        anchorFailed = true
        setImportedSlug(outcome.repo!.slug)
        setError(`服务器已导入成功，但本地同步绑定保存失败：${err instanceof Error ? err.message : String(err)}`)
      })
      onRepoCreated()
      if (anchorFailed) return
      onImported(outcome.repo.slug)
      return
    }
    const created = outcome.repo ? `（仓库「${outcome.repo.title}」已创建，可在仓库列表打开后重试「发布新版本」）` : ''
    // 仓库已建成即刷新列表：文案说「可在仓库列表打开」，列表就不得停留在取数前的空/旧快照
    // （onClose 只关弹窗，不会触发 CloudBagPanel 的重取 effect）。
    if (outcome.repo) onRepoCreated()
    setError(`${outcome.status === 'aborted' ? '已取消导入' : (outcome.error ?? '导入失败')}${created}`)
  }

  const phaseLabel = progress?.phase === 'uploading' || progress?.phase === 'hashing' || progress?.phase === 'reading'
    ? `上传进度：${progress.done}/${progress.total} ${progress.currentPath ? `· ${progress.currentPath}` : ''}`
    : progress?.phase === 'committing' ? '正在创建首个版本…' : progress?.phase === 'done' ? '导入完成' : ''

  return (
    <Modal spacious title="导入到云仓库" onClose={busy ? () => undefined : onClose} footer={<>
      {/* busy 期间必须保留一个协作式取消出口（与同步弹窗同一语义）：大文件树导入
          只能等它跑完且无法取消是死路。发出取消后完成当前文件即停（IPC 不可中断）；
          仓库已创建时会如实提示（服务端不回滚）。 */}
      {busy
        ? <button className="btn" onClick={() => { abortRef.current = true }} title="发出取消：完成当前文件后停止上传（传输中的单个文件不可中断）">取消导入</button>
        : <button className="btn" onClick={onClose}>取消</button>}
      <button className="btn primary" disabled={busy} onClick={() => importedSlug ? onImported(importedSlug) : void submit()}>{importedSlug ? '查看已导入仓库' : busy ? '导入中…' : target === 'new' ? '创建仓库并导入' : mergePlan?.overlaps.length ? '确认替换同名文件并导入' : '比较并导入目标仓库'}</button>
    </>}>
      <div className="community-form">
        <div className="rank-filter">
          <button type="button" className={`rank-chip${source === 'project' ? ' active' : ''}`} aria-pressed={source === 'project'} disabled={!activeProjectPath} title={activeProjectPath ? '以当前打开的项目目录作为初始文件树' : '先在工作台打开一个本地项目'} onClick={() => void chooseSource('project')}>
            从当前项目导入
          </button>
          <button type="button" className={`rank-chip${source === 'folder' ? ' active' : ''}`} aria-pressed={source === 'folder'} onClick={() => void chooseSource('folder')}>选择本地目录</button>
          <button type="button" className={`rank-chip${source === 'rwmod' ? ' active' : ''}`} aria-pressed={source === 'rwmod'} disabled={busy} onClick={() => void chooseSource('rwmod')}>
            导入 .rwmod 文件
          </button>
        </div>
        <div className="local-note">
          {source === 'project'
            ? `源目录：${activeProjectPath ?? '（未打开项目）'}`
            : `源目录：${pickedRoot ?? '尚未选择，请点击上方来源按钮'}`}
        </div>
        <label>目标仓库<select value={target} disabled={busy} onChange={(event) => { setTarget(event.target.value); setMergePlan(null) }}><option value="new">新建仓库</option>{targets.map((repo) => <option key={repo.slug} value={repo.slug}>{repo.title} · {repo.slug}</option>)}</select></label>
        {targetsError && <div className="community-warning">目标仓库列表加载失败：{targetsError}</div>}
        {target !== 'new' && <label>目标子目录（可留空）<input value={prefix} disabled={busy} onChange={(event) => { setPrefix(event.target.value); setMergePlan(null) }} placeholder="例如 mods/my-mod" /></label>}
        {mergePlan && mergePlan.overlaps.length > 0 && <div className="local-note"><strong>以下 {mergePlan.overlaps.length} 个同名文件将被替换，其余远端文件保留：</strong><div style={{ maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{mergePlan.overlaps.join('\n')}</div></div>}
        {target === 'new' && <>
        <label>仓库名称<input aria-label="仓库名称" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="名称（最多 128 字）" maxLength={128} /></label>
        <input aria-label="仓库标识建议" value={slugSuggestion} onChange={(event) => setSlugSuggestion(event.target.value)} placeholder="标识建议（可留空，最终以服务端生成为准）" maxLength={64} />
        <input aria-label="仓库简介" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="简介（最多 500 字）" maxLength={500} />
        <select aria-label="仓库类型" value={repoType} onChange={(event) => setRepoType(event.target.value as CloudBagRepoType)}>
          <option value="mod">单模组仓（兼容旧流程）</option>
          <option value="collection">模组集合仓（整套或单个模组下载）</option>
          <option value="asset">素材仓（素材、模板、地图）</option>
        </select>
        <select aria-label="可见性" value={visibility} onChange={(event) => setVisibility(event.target.value as CloudBagRepo['visibility'])}>
          <option value="private">私有（仅成员）</option>
          <option value="public">公开（广场可见）</option>
          <option value="link">链接可见（持分享链接可读）</option>
        </select>
        <label>标签<input aria-label="仓库标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签（逗号分隔，最多 8 个）" /></label>
        </>}
        <input aria-label="版本说明" value={note} onChange={(event) => setNote(event.target.value)} placeholder="版本说明（必填，最多 600 字）" maxLength={600} />
        {phaseLabel && <div className="local-note" role="status">{phaseLabel}</div>}
        {error && <div className="community-warning" role="status">{error}</div>}
      </div>
    </Modal>
  )
}

export function CloudBagPanel() {
  const openLogin = useWorkspaceStore((s) => s.openLoginScreen)
  const openSettings = useWorkspaceStore((s) => s.openSettings)
  const refreshAuth = useWorkspaceStore((s) => s.refreshCommunityAuth)
  const [refreshKey, setRefreshKey] = useState(0)
  const [reachable, setReachable] = useState<boolean | null>(null)
  const onSettings = useCallback(() => openSettings('community'), [openSettings])
  const onUnauthorized = useCallback(() => {
    void refreshAuth().catch(() => setReachable(false))
  }, [refreshAuth])
  return <section className="community-panel panel" aria-label="云仓库">
    <header className="panel-header">
      <AppIcon name="cloud" size={13} /> 云仓库
      <span className={`badge ${reachable === null ? 'info' : reachable ? 'success' : 'warning'}`} role="status">{reachable === null ? '等待连接' : reachable ? '在线' : '连接失败'}</span>
      <span className="grow" />
      <button type="button" className="icon-btn" title="刷新云仓库" aria-label="刷新云仓库" onClick={() => setRefreshKey((value) => value + 1)}><AppIcon name="refresh" size={13} /></button>
    </header>
    <CloudBagContent onOpenLogin={openLogin} onOpenSettings={onSettings} onUnauthorized={onUnauthorized} refreshKey={refreshKey} onReachabilityChange={setReachable} />
  </section>
}

export function CloudBagContent({ onOpenLogin, onOpenSettings, onUnauthorized, refreshKey = 0, onReachabilityChange }: {
  onOpenLogin: () => void
  onOpenSettings: () => void
  onUnauthorized: () => void
  /** 社区面板头部「刷新社区数据」的计数器：该页签必须随之重新取数，否则按钮是死交互 */
  refreshKey?: number
  /** 本次真实请求的可达性回报（true/false；未发请求或结论未定时为 null）：
   * 头部徽标必须反映本页签的真实可达性，而不是 communityAuth 缓存里的 signed_in
   * （否则会出现「徽标在线 / 正文加载失败」的自相矛盾状态）。 */
  onReachabilityChange?: (reachable: boolean | null) => void
}) {
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const endpoint = useWorkspaceStore((s) => s.settings.ai.communityEndpoint)
  const cloudBagSlug = useWorkspaceStore((s) => s.cloudBagSlug)
  const setCloudBagView = useWorkspaceStore((s) => s.setCloudBagView)
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const gate = cloudBagGate(communityAuth.status, communityAuth.user)

  // api 只依赖端点：身份凭据由主进程注入，渲染层不持 token；端点无效时为 null（UI 显式降级）
  const api = useMemo(() => {
    try {
      return createCloudBagApi(endpoint, undefined, onUnauthorized)
    } catch {
      return null
    }
  }, [endpoint, onUnauthorized])
  const [repos, setRepos] = useState<CloudBagRepo[]>([])
  const [total, setTotal] = useState(0)
  const [mine, setMine] = useState(true)
  const [starred, setStarred] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [searchKeyword, setSearchKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  /** 离线态「重试」真的在发请求：只有它为 true 时才渲染「正在重试连接社区服务器…」。
   * 旧实现复用 loading（初值恒 true），离线首帧必然显示一次与事实不符的「正在重试」。 */
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [listRefreshKey, setListRefreshKey] = useState(0)
  const loadGeneration = useRef(0)

  const load = useCallback(async (retry = false) => {
    if (!api) {
      setLoading(false)
      setRetrying(false)
      onReachabilityChange?.(null)
      setError('社区服务器地址无效，请在设置中检查社区服务器地址')
      return
    }
    // 离线/未登录时不自动发请求（避免把必然失败的 404/网络错误与空态同时呈现）；
    // 离线态的「重试」按钮仍走真实请求，如实反映结果。
    if (!gate.canBrowse && !retry) {
      setLoading(false)
      setRetrying(false)
      // 本页签没有发出请求：可达性无结论，交回 communityAuth 的门控文案
      onReachabilityChange?.(null)
      setError(null)
      return
    }
    const generation = ++loadGeneration.current
    const isCurrent = () => generation === loadGeneration.current
    setLoading(true)
    setRetrying(retry)
    setError(null)
    try {
      // 真实请求：离线重试按钮同样走这里（离线时该请求会以网络错误失败并如实展示）
      const result = await api.repos({ mine: mine && !starred, starred, q: searchKeyword || undefined, page })
      if (!isCurrent()) return
      setRepos(result.items ?? [])
      setTotal(result.total ?? result.items?.length ?? 0)
      onReachabilityChange?.(true)
      void retry
    } catch (err) {
      if (!isCurrent()) return
      setRepos([])
      setTotal(0)
      // 请求失败：页签正文会如实展示错误，头部徽标不得再声称「已连接社区服务器」
      onReachabilityChange?.(false)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrent()) {
        setLoading(false)
        setRetrying(false)
      }
    }
  }, [api, mine, starred, page, searchKeyword, gate.canBrowse, onReachabilityChange])

  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(timer)
  }, [load, refreshKey, listRefreshKey])

  // 门控先于「仓库详情」分支：离线/未登录时若 store 里残留 cloudBagSlug，绝不能直接
  // 渲染详情并发出必然失败的请求——先给出状态说明与登录入口。
  if (!gate.canBrowse) {
    const offline = communityAuth.status === 'offline'
    const errored = communityAuth.status === 'error'
    const checking = communityAuth.status === 'checking' || communityAuth.status === 'loading'
    // 离线重试期间渲染进行中反馈（旧实现复用 loading，离线首帧会假报「正在重试」）
    if (offline && retrying) return <PanelState kind="loading" title="正在重试连接社区服务器…" />
    // 标题必须与真实状态一致：认证失败/检查中若仍写「尚未登录社区账号」，会与头部
    // 徽标（连接异常/检查中）和 gate.notice（网络失败文案）三者互相矛盾。
    const title = offline ? '离线模式' : errored ? '连接社区服务器失败' : checking ? '正在检查社区登录状态…' : '尚未登录社区账号'
    return (
      <div className="cloudbag-body">
        <PanelState
          kind="empty"
          icon="cloud"
          title={title}
          description={gate.notice}
          // 离线/连接失败态同样给「登录社区」：否则用户只剩可能失败的「重试」，陷入软死路
          // （离线态粘滞，后台复检被 workspace 跳过）。
          action={<button className="btn primary" onClick={onOpenLogin}>登录社区</button>}
          // 网络层失败（§8:245）与离线都必须有真实重试出口
          onRetry={offline || errored ? () => void load(true) : undefined}
          retryLabel={retrying ? '重试中…' : '重试'}
        />
        {error && <div className="local-note community-warning">{error}</div>}
      </div>
    )
  }

  if (cloudBagSlug) {
    return api
      // 返回列表时让列表重新取数：删除仓库/新发布后列表不能停在旧快照上。
      // key 带上 refreshKey：头部「刷新社区数据」在仓库详情页同样必须真的重新取数。
      ? <CloudBagRepoView key={`${cloudBagSlug}:${refreshKey}`} api={api} slug={cloudBagSlug} gate={gate} onBack={() => { setCloudBagView({ slug: null }); setListRefreshKey((n) => n + 1) }} />
      : <PanelState kind="error" title="社区服务器地址无效" description="请在设置中检查社区服务器地址" />
  }

  return (
    <div className="cloudbag-body">
      {!gate.canWrite && (
        <div className="local-note community-warning">
          {gate.notice}
          <button className="btn-sm" onClick={onOpenSettings}>去设置认证</button>
        </div>
      )}
      <div className="community-section community-toolbar">
        <div className="rank-filter">
          <button type="button" className={`rank-chip${mine && !starred ? ' active' : ''}`} aria-pressed={mine && !starred} onClick={() => { setMine(true); setStarred(false); setPage(1) }}>我的仓库</button>
          <button type="button" className={`rank-chip${!mine && !starred ? ' active' : ''}`} aria-pressed={!mine && !starred} onClick={() => { setMine(false); setStarred(false); setPage(1) }}>广场</button>
          <button type="button" className={`rank-chip${starred ? ' active' : ''}`} aria-pressed={starred} onClick={() => { setMine(false); setStarred(true); setPage(1) }}>我 Star 的仓库</button>
        </div>
        <input
          aria-label="搜索仓库"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { setSearchKeyword(keyword); setPage(1) } }}
          placeholder="搜索仓库"
        />
        <button className="btn-sm" onClick={() => { setSearchKeyword(keyword); setPage(1) }}>搜索</button>
        <span className="grow" />
        <button className="btn-sm" disabled={!gate.canWrite} title={gate.canWrite ? '创建新的模组仓库' : '请先完成邮箱认证后再创建仓库'} onClick={() => setCreateOpen(true)}>
          创建仓库
        </button>
        <button className="btn-sm" disabled={!gate.canWrite} onClick={() => setImportOpen(true)}>从本地目录导入</button>
      </div>
      {loading ? <PanelState kind="loading" title="加载云书包仓库…" /> : error
        ? <PanelState kind="error" title="云书包加载失败" description={error} onRetry={() => void load(true)} />
        : repos.length === 0
          ? (
            // 契约 §6.1：空态两个主按钮必须真实可用（创建模组仓库 / 从当前项目或 .rwmod 导入）
            <PanelState
              kind="empty"
              icon="cloud"
              title={mine ? '还没有云书包仓库' : '暂无公开仓库'}
              description={mine ? '创建仓库，或从当前项目 / .rwmod 导入你的第一个模组。' : '换个关键词试试。'}
              action={mine ? <>
                <button className="btn primary" disabled={!gate.canWrite} title={gate.canWrite ? '创建新的模组仓库' : '请先完成邮箱认证后再创建仓库'} onClick={() => setCreateOpen(true)}>
                  <AppIcon name="plus" size={12} /> 创建模组仓库
                </button>
                <button
                  className="btn"
                  disabled={!gate.canWrite}
                  title={gate.canWrite ? '建仓库并把本地项目或 .rwmod 作为初始文件树' : '请先完成邮箱认证后再导入'}
                  onClick={() => setImportOpen(true)}
                >
                  <AppIcon name="upload" size={12} /> 从当前项目导入
                </button>
              </> : undefined}
            />
          )
          : <div className="post-list">{repos.map((repo) => <RepoCard key={repo.id} repo={repo} endpoint={endpoint} onOpen={() => setCloudBagView({ slug: repo.slug, section: 'files' })} />)}</div>}
      {!loading && !error && total > 0 && (
        <div className="community-pagination">
          <span>共 {total} 个仓库</span>
          <span className="grow" />
          <button className="btn-sm" disabled={page <= 1} onClick={() => setPage((n) => Math.max(1, n - 1))}>上一页</button>
          <span>第 {page} 页</span>
          <button className="btn-sm" disabled={page * 12 >= total} onClick={() => setPage((n) => n + 1)}>下一页</button>
        </div>
      )}
      {createOpen && api && <CreateRepoModal api={api} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void load() }} />}
      {importOpen && api && (
        <ImportToCloudModal
          api={api}
          activeProjectName={activeProject?.name ?? null}
          activeProjectPath={activeProject?.rootPath ?? null}
          onClose={() => setImportOpen(false)}
          onRepoCreated={() => setListRefreshKey((n) => n + 1)}
          onImported={(slug) => { setImportOpen(false); setCloudBagView({ slug, section: 'versions' }) }}
        />
      )}
    </div>
  )
}
