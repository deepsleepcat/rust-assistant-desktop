import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import { useWorkspaceStore } from '../../stores/workspace'
import { createCloudBagApi, type CloudBagApi, type CloudBagRepo } from '../../services/cloudBagApi'
import { importTreeToNewRepo, writeCloudBagAnchor, type SyncProgress } from '../../services/cloudBagSync'
import { getBridge } from '../../services/bridge'
import { cloudBagGate, formatBytes, repoDeepLink } from './cloudBagData'
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

function RepoCard({ repo, endpoint, onOpen }: { repo: CloudBagRepo; endpoint: string; onOpen: () => void }) {
  return (
    <article className="community-card post-card">
      <button className="post-card-main" onClick={onOpen}>
        <div className="post-card-title">
          <span>{repo.title}</span>
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
        <select aria-label="可见性" value={visibility} onChange={(event) => setVisibility(event.target.value as CloudBagRepo['visibility'])}>
          <option value="private">私有（仅成员）</option>
          <option value="public">公开（广场可见）</option>
          <option value="link">链接可见（持分享链接可读）</option>
        </select>
        <input aria-label="仓库标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签（逗号分隔，最多 8 个）" />
        <div className="local-note">V1 云书包内容在服务器上为明文存储（加密属后续版本），请勿上传敏感内容。</div>
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
function ImportToCloudModal({ api, activeProjectName, activeProjectPath, onClose, onImported, onRepoCreated }: {
  api: CloudBagApi
  activeProjectName: string | null
  activeProjectPath: string | null
  onClose: () => void
  onImported: (slug: string) => void
  /** 导入中途取消/失败但仓库已在服务端建成：仓库列表必须立即重取（否则关窗后仍见旧列表） */
  onRepoCreated: () => void
}) {
  const bridge = getBridge()
  const [source, setSource] = useState<'project' | 'rwmod'>(activeProjectPath ? 'project' : 'rwmod')
  const [title, setTitle] = useState(activeProjectName ?? '')
  const [slugSuggestion, setSlugSuggestion] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<CloudBagRepo['visibility']>('private')
  const [tags, setTags] = useState('')
  const [note, setNote] = useState('从本地项目导入的初始版本')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef(false)

  const submit = async () => {
    if (!title.trim()) { setError('仓库名称不能为空'); return }
    if (!note.trim()) { setError('版本说明不能为空'); return }
    let rootPath = activeProjectPath
    if (source === 'rwmod') {
      setBusy(true)
      setError(null)
      try {
        // 取消返回 null：保持弹窗打开，不产生任何请求
        const picked = await bridge.mod.import('archive')
        if (!picked) { setBusy(false); return }
        rootPath = picked.rootPath
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
        return
      }
    }
    if (!rootPath) { setError('请先打开一个本地项目，或选择 .rwmod 文件'); setBusy(false); return }
    setBusy(true)
    setError(null)
    abortRef.current = false
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
      await writeCloudBagAnchor(bridge, rootPath, {
        repoSlug: outcome.repo.slug,
        baselineSeq: outcome.versionNo ?? 0,
        // 首版本实际提交树摘要：写入后同步弹窗可直接比较，无需再从服务端补基线
        baselineTreeDigest: outcome.treeDigest ?? '',
        lastSyncedAt: Math.floor(Date.now() / 1000),
      }).catch(() => undefined)
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
    <Modal title="导入到云书包" onClose={busy ? () => undefined : onClose} footer={<>
      {/* busy 期间必须保留一个协作式取消出口（与同步弹窗同一语义）：大文件树导入
          只能等它跑完且无法取消是死路。发出取消后完成当前文件即停（IPC 不可中断）；
          仓库已创建时会如实提示（服务端不回滚）。 */}
      {busy
        ? <button className="btn" onClick={() => { abortRef.current = true }} title="发出取消：完成当前文件后停止上传（传输中的单个文件不可中断）">取消导入</button>
        : <button className="btn" onClick={onClose}>取消</button>}
      <button className="btn primary" disabled={busy} onClick={() => void submit()}>{busy ? '导入中…' : '创建仓库并导入'}</button>
    </>}>
      <div className="community-form">
        <div className="rank-filter">
          <button type="button" className={`rank-chip${source === 'project' ? ' active' : ''}`} aria-pressed={source === 'project'} disabled={!activeProjectPath} title={activeProjectPath ? '以当前打开的项目目录作为初始文件树' : '先在工作台打开一个本地项目'} onClick={() => setSource('project')}>
            从当前项目导入
          </button>
          <button type="button" className={`rank-chip${source === 'rwmod' ? ' active' : ''}`} aria-pressed={source === 'rwmod'} onClick={() => setSource('rwmod')}>
            导入 .rwmod 文件
          </button>
        </div>
        <div className="local-note">
          {source === 'project'
            ? `源目录：${activeProjectPath ?? '（未打开项目）'}`
            : '点击「创建仓库并导入」后会依次弹出「选择模组文件（.rwmod / .zip）」与「选择导入位置」；解压走 importModBuffer 的全量校验（zip-slip / 条目数 / 单文件与总量上限）。'}
        </div>
        <input aria-label="仓库名称" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="名称（最多 128 字）" maxLength={128} />
        <input aria-label="仓库标识建议" value={slugSuggestion} onChange={(event) => setSlugSuggestion(event.target.value)} placeholder="标识建议（可留空，最终以服务端生成为准）" maxLength={64} />
        <input aria-label="仓库简介" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="简介（最多 500 字）" maxLength={500} />
        <select aria-label="可见性" value={visibility} onChange={(event) => setVisibility(event.target.value as CloudBagRepo['visibility'])}>
          <option value="private">私有（仅成员）</option>
          <option value="public">公开（广场可见）</option>
          <option value="link">链接可见（持分享链接可读）</option>
        </select>
        <input aria-label="仓库标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签（逗号分隔，最多 8 个）" />
        <input aria-label="版本说明" value={note} onChange={(event) => setNote(event.target.value)} placeholder="版本说明（必填，最多 600 字）" maxLength={600} />
        {phaseLabel && <div className="local-note" role="status">{phaseLabel}</div>}
        <div className="local-note">V1 云书包内容在服务器上为明文存储（加密属后续版本），请勿上传敏感内容。</div>
        {error && <div className="community-warning" role="status">{error}</div>}
      </div>
    </Modal>
  )
}

export function CloudBagPanel({ onOpenLogin, onOpenSettings, onUnauthorized, refreshKey = 0, onReachabilityChange }: {
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
      const result = await api.repos({ mine, q: searchKeyword || undefined, page })
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
  }, [api, mine, page, searchKeyword, gate.canBrowse, onReachabilityChange])

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
          <button type="button" className={`rank-chip${mine ? ' active' : ''}`} aria-pressed={mine} onClick={() => { setMine(true); setPage(1) }}>我的仓库</button>
          <button type="button" className={`rank-chip${!mine ? ' active' : ''}`} aria-pressed={!mine} onClick={() => { setMine(false); setPage(1) }}>广场</button>
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
          <AppIcon name="plus" size={12} /> 创建仓库
        </button>
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
