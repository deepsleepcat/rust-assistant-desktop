import { useCallback, useEffect, useRef, useState } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import { useWorkspaceStore } from '../../stores/workspace'
import type { CloudBagApi, CloudBagDiffEntry, CloudBagMember, CloudBagRepo, CloudBagTreeEntry, CloudBagVersion } from '../../services/cloudBagApi'
import { buildCloudBagTree, formatBytes, repoDeepLink, summarizeDiff, type CloudBagGate } from './cloudBagData'
import { CloudBagSyncModal } from './CloudBagSyncModal'

/**
 * 云书包仓库详情（GitHub 风格映射）：头部元数据 + 文件树/版本/成员/设置四子页签。
 * V1 文件树只读（网页在线编辑属未支持清单）；同步（发布/拉取）仅手动触发。
 */

const SECTION_LABELS = { files: '文件', versions: '版本', members: '成员', settings: '设置' } as const
type RepoSection = keyof typeof SECTION_LABELS
const VISIBILITY_LABELS: Record<CloudBagRepo['visibility'], string> = { private: '私有', public: '公开', link: '链接可见' }

function TreeNodeRow({ node, depth, onOpenFile, expanded, toggle }: {
  node: ReturnType<typeof buildCloudBagTree>[number]
  depth: number
  onOpenFile: (path: string) => void
  expanded: Set<string>
  toggle: (path: string) => void
}) {
  if (node.isDirectory) {
    const open = expanded.has(node.path)
    return (
      <>
        <button
          type="button"
          className="cloudbag-tree-row"
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => toggle(node.path)}
          aria-expanded={open}
        >
          <AppIcon name={open ? 'expand' : 'folder'} size={12} /> {node.name}
        </button>
        {open && node.children.map((child) => (
          <TreeNodeRow key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} expanded={expanded} toggle={toggle} />
        ))}
      </>
    )
  }
  return (
    <button
      type="button"
      className="cloudbag-tree-row"
      style={{ paddingLeft: 8 + depth * 16 }}
      onClick={() => onOpenFile(node.path)}
      title={`${node.path}（${formatBytes(node.size)}）`}
    >
      <AppIcon name="file" size={12} /> {node.name}
      <span className="grow" />
      <span className="post-card-meta">{formatBytes(node.size)}</span>
    </button>
  )
}

function FilePreviewModal({ api, slug, versionNo, path, onClose }: {
  api: CloudBagApi
  slug: string
  versionNo: number
  path: string
  onClose: () => void
}) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'text'; content: string } | { kind: 'image'; url: string } | { kind: 'error'; message: string }>({ kind: 'loading' })
  useEffect(() => {
    let alive = true
    const objectUrl = { current: '' }
    void api.file(slug, versionNo, path).then(({ bytes, contentType }) => {
      if (!alive) return
      if (contentType.startsWith('image/')) {
        const url = URL.createObjectURL(new Blob([bytes], { type: contentType }))
        objectUrl.current = url
        setState({ kind: 'image', url })
        return
      }
      setState({ kind: 'text', content: new TextDecoder().decode(bytes) })
    }).catch((err) => {
      if (alive) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    })
    return () => {
      alive = false
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current)
    }
  }, [api, slug, versionNo, path])
  return (
    <Modal wide title={<span><AppIcon name="file" size={14} /> {path}</span>} onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
      {state.kind === 'loading' && <PanelState kind="loading" title="读取文件…" />}
      {state.kind === 'error' && <PanelState kind="error" title="文件读取失败" description={state.message} />}
      {state.kind === 'text' && <pre className="cloudbag-file-preview">{state.content.slice(0, 200_000)}</pre>}
      {state.kind === 'image' && <img src={state.url} alt={path} style={{ maxWidth: '100%' }} />}
    </Modal>
  )
}

function DiffModal({ api, slug, versionNo, against, onClose }: {
  api: CloudBagApi
  slug: string
  versionNo: number
  against: number
  onClose: () => void
}) {
  const [entries, setEntries] = useState<CloudBagDiffEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void api.diff(slug, versionNo, against).then((result) => alive && setEntries(result)).catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => { alive = false }
  }, [api, slug, versionNo, against])
  return (
    <Modal wide title={`版本 #${versionNo} 与 #${against} 差异`} onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
      {error && <PanelState kind="error" title="差异读取失败" description={error} />}
      {!error && entries === null && <PanelState kind="loading" title="读取差异…" />}
      {!error && entries !== null && (
        <>
          <div className="local-note">{summarizeDiff(entries)}</div>
          <div className="cloudbag-diff-list">
            {entries.map((entry) => (
              <div className="cloudbag-diff-row" key={`${entry.change}:${entry.path}`}>
                <span className={`badge${entry.change === 'added' ? ' success' : entry.change === 'removed' ? ' warning' : ''}`}>{entry.change === 'added' ? '新增' : entry.change === 'removed' ? '删除' : '修改'}</span>
                <span>{entry.path}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

function VersionsView({ api, repo, canWrite, onChanged }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean; onChanged: () => void }) {
  const [versions, setVersions] = useState<CloudBagVersion[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [diffAgainst, setDiffAgainst] = useState<{ versionNo: number; against: number } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const load = useCallback(async (cursorValue: string | null) => {
    setLoading(true)
    setError(null)
    try {
      const result = await api.versions(repo.slug, cursorValue ?? undefined)
      setVersions((current) => cursorValue ? [...current, ...(result.items ?? [])] : (result.items ?? []))
      setCursor(cursorValue)
      setNextCursor(result.nextCursor ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [api, repo.slug])
  useEffect(() => {
    const timer = setTimeout(() => { void load(null) }, 0)
    return () => clearTimeout(timer)
  }, [load])
  const download = async (versionNo: number) => {
    try {
      const { bytes, filename } = await api.exportRwmod(repo.slug, versionNo)
      const blob = new Blob([bytes], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(`已下载 ${filename}。可经「模组工具 → 导入」导入为本地项目。`)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }
  const rollback = async (versionNo: number) => {
    if (!window.confirm(`回滚会创建一个新版本（复制 #${versionNo} 的文件树），历史不会被改写。继续？`)) return
    try {
      const result = await api.pushVersion(repo.slug, {
        baseVersionNo: repo.headVersionNo,
        message: `revert of #${versionNo}`,
        clientOpId: crypto.randomUUID().replace(/-/g, ''),
        files: [],
        restoreFrom: versionNo,
      })
      setMessage(`已创建回滚版本 #${result.versionNo}`)
      void load(cursor)
      // 回滚会改变 head：不刷新 repo 元数据会让 head 徽标停在旧版本，
      // 下一次回滚/发布还会带过期 baseVersionNo 被服务端乐观锁判为 version_conflict
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="cloudbag-section">
      {message && <div className="local-note community-warning" role="status">{message}</div>}
      {loading && versions.length === 0 ? <PanelState kind="loading" title="加载版本列表…" /> : error
        ? <PanelState kind="error" title="版本列表加载失败" description={error} onRetry={() => void load(null)} />
        : versions.length === 0
          ? <PanelState kind="empty" icon="file" title="还没有版本" description="从当前项目或 .rwmod 导入并提交第一个版本。" />
          : <>
            <div className="cloudbag-version-list">
              {versions.map((version) => (
                <div className="community-card post-card" key={version.id}>
                  <div className="post-card-title"><span>#{version.versionNo} · {version.message}</span>{version.versionNo === repo.headVersionNo && <span className="badge success">head</span>}</div>
                  <div className="post-card-meta">{version.manifest?.title || '未命名模组'} · {version.manifest?.version || '无版本号'} · {version.fileCount} 文件 · {formatBytes(version.totalSize)} · {new Date(version.createdAt * 1000).toLocaleString()}</div>
                  {version.manifest?.brokenRefs?.length > 0 && <div className="local-note">引用缺失警告：{version.manifest.brokenRefs.join('、')}</div>}
                  <div className="post-card-foot">
                    <span className="post-card-meta">{version.parentVersionNo ? `父版本 #${version.parentVersionNo}` : '初始版本'}</span>
                    <span className="grow" />
                    {version.parentVersionNo !== null && <button className="btn-sm" onClick={() => setDiffAgainst({ versionNo: version.versionNo, against: version.parentVersionNo! })}>查看差异</button>}
                    <button className="btn-sm" onClick={() => void download(version.versionNo)}>下载 .rwmod</button>
                    {canWrite && version.versionNo !== repo.headVersionNo && <button className="btn-sm" onClick={() => void rollback(version.versionNo)}>回滚到此版本</button>}
                  </div>
                </div>
              ))}
            </div>
            {nextCursor && <button className="btn" onClick={() => void load(nextCursor)}>加载更多版本</button>}
          </>}
      {diffAgainst && <DiffModal api={api} slug={repo.slug} versionNo={diffAgainst.versionNo} against={diffAgainst.against} onClose={() => setDiffAgainst(null)} />}
    </div>
  )
}

function MembersView({ api, repo, canWrite }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean }) {
  const [members, setMembers] = useState<CloudBagMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteUid, setInviteUid] = useState('')
  const [inviteRole, setInviteRole] = useState<'editor' | 'viewer'>('viewer')
  const [message, setMessage] = useState<string | null>(null)
  const isOwner = repo.myRole === 'owner'
  const load = useCallback(async () => {
    // 服务端成员列表只允许 owner 读取（cloudbag_repo.go 的 CloudBagRoleOwner 档）：
    // 非 owner 不发这次必然 forbidden 的请求，直接给出说明（与网页端 hidden:!isOwner 对齐）。
    if (!isOwner) {
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.members(repo.slug)
      setMembers(result.items ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [api, repo.slug, isOwner])
  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(timer)
  }, [load])
  if (!isOwner) {
    return (
      <div className="cloudbag-section">
        <PanelState kind="empty" title="仅所有者可查看成员" description={`你的角色：${repo.myRole ?? '非成员'}。`} />
      </div>
    )
  }
  const invite = async () => {
    const uid = Number(inviteUid)
    if (!Number.isInteger(uid) || uid <= 0) { setMessage('请输入有效的用户数字 id'); return }
    try {
      await api.addMember(repo.slug, { userId: uid, role: inviteRole })
      setInviteUid('')
      setMessage('已添加成员')
      void load()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }
  const remove = async (userId: number) => {
    try {
      await api.removeMember(repo.slug, userId)
      setMessage('已移除成员')
      void load()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }
  return (
    <div className="cloudbag-section">
      {message && <div className="local-note community-warning" role="status">{message}</div>}
      {loading ? <PanelState kind="loading" title="加载成员…" /> : error
        ? <PanelState kind="error" title="成员加载失败" description={error} onRetry={() => void load()} />
        : <div className="cloudbag-diff-list">
          {members.map((member) => (
            <div className="cloudbag-diff-row" key={member.userId}>
              <span>{member.displayName || member.username || `用户 ${member.userId}`}</span>
              <span className="badge">{member.role === 'owner' ? '所有者' : member.role === 'editor' ? '编辑者' : '查看者'}</span>
              <span className="grow" />
              {isOwner && member.role !== 'owner' && (
                <button
                  className="btn-sm"
                  disabled={!canWrite}
                  title={canWrite ? '移除该成员' : '请先完成邮箱认证后再管理成员'}
                  onClick={() => void remove(member.userId)}
                >
                  移除
                </button>
              )}
            </div>
          ))}
        </div>}
      {isOwner && canWrite && (
        <div className="community-form">
          <input aria-label="被邀请用户 id" value={inviteUid} onChange={(event) => setInviteUid(event.target.value)} placeholder="站内用户数字 id" />
          <select aria-label="成员角色" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'editor' | 'viewer')}>
            <option value="viewer">查看者</option>
            <option value="editor">编辑者</option>
          </select>
          <button className="btn-sm" onClick={() => void invite()}>邀请成员</button>
        </div>
      )}
    </div>
  )
}

function SettingsView({ api, repo, canWrite, onChanged, onDeleted }: { api: CloudBagApi; repo: CloudBagRepo; canWrite: boolean; onChanged: () => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(repo.title)
  const [description, setDescription] = useState(repo.description)
  const [visibility, setVisibility] = useState<CloudBagRepo['visibility']>(repo.visibility)
  const [tags, setTags] = useState((repo.tags ?? []).join(', '))
  const [postId, setPostId] = useState(repo.postId ? String(repo.postId) : '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const isOwner = repo.myRole === 'owner'
  const save = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await api.updateRepo(repo.slug, {
        title: title.trim(),
        description: description.trim(),
        visibility,
        tags: tags.split(/[,，]/).map((item) => item.trim()).filter(Boolean).slice(0, 8),
        postId: postId.trim() ? Number(postId.trim()) : null,
      })
      setMessage('已保存仓库设置')
      onChanged()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const destroy = async () => {
    if (!window.confirm(`确定删除仓库「${repo.title}」吗？仓库将对成员不可见（软删除）。`)) return
    try {
      await api.deleteRepo(repo.slug)
      onChanged()
      // 仓库已软删除：留在详情页只会拿到 not_found。直接回列表并让列表重新取数，
      // 避免「点了删除界面没变化」，也避免列表继续显示已删除仓库。
      onDeleted()
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }
  if (!isOwner) return <PanelState kind="empty" title="仅所有者可修改仓库设置" description={`你的角色：${repo.myRole ?? '无'}。`} />
  const writeTitle = canWrite ? undefined : '请先完成邮箱认证后再管理仓库'
  return (
    <div className="cloudbag-section">
      {!canWrite && <div className="local-note community-warning">请先完成邮箱认证后再管理仓库（保存设置 / 删除仓库在认证前不可用）。</div>}
      <div className="community-form">
        <input aria-label="仓库名称" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={128} />
        <input aria-label="仓库简介" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        <select aria-label="可见性" value={visibility} onChange={(event) => setVisibility(event.target.value as CloudBagRepo['visibility'])}>
          <option value="private">私有</option>
          <option value="public">公开</option>
          <option value="link">链接可见</option>
        </select>
        <input aria-label="标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签（逗号分隔，最多 8 个）" />
        <input aria-label="关联社区帖子 id" value={postId} onChange={(event) => setPostId(event.target.value)} placeholder="关联社区帖子 id（可选，单向弱关联）" />
        <div className="cloudbag-unsupported-row">
          {/* V1 未支持的能力：保留按钮以表达「曾经/将来会有」，但用 aria-disabled（而非
              disabled）——disabled 元素不可聚焦，键盘与读屏用户既取不到 title 也无法触发，
              触屏用户同样拿不到悬停提示。可聚焦 + 可读的说明行覆盖三类用户。 */}
          <button className="btn-sm" aria-disabled="true" title="未支持：网页端在线编辑仓库文件">在线编辑</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：Issue / PR 评审">Issue / PR</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：Star / Fork 社交图谱">Star / Fork</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：Wiki">Wiki</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：CI 构建">CI 构建</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：实时多人协同编辑">协同编辑</button>
          <button className="btn-sm" aria-disabled="true" title="未支持：超过 50 MiB 的两阶段大文件上传">大文件直传</button>
        </div>
        <div className="local-note">以上 7 个入口 V1 均未支持（在线编辑 / Issue-PR / Star-Fork / Wiki / CI 构建 / 协同编辑 / 大文件直传）：按钮已停用，鼠标悬停或键盘聚焦可看到具体说明。</div>
        <div className="local-note">V1 云书包内容在服务器上为明文存储（加密属后续版本）。</div>
      </div>
      {message && <div className="local-note community-warning" role="status">{message}</div>}
      <div className="cloudbag-unsupported-row">
        <button className="btn primary" disabled={busy || !canWrite} title={writeTitle} onClick={() => void save()}>{busy ? '保存中…' : '保存设置'}</button>
        <button className="btn-danger" disabled={busy || !canWrite} title={writeTitle} onClick={() => void destroy()}>删除仓库</button>
      </div>
    </div>
  )
}

export function CloudBagRepoView({ api, slug, gate, onBack }: {
  api: CloudBagApi
  slug: string
  gate: CloudBagGate
  onBack: () => void
}) {
  const endpoint = useWorkspaceStore((s) => s.settings.ai.communityEndpoint)
  const activeProject = useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId) ?? null)
  const section = useWorkspaceStore((s) => s.cloudBagSection)
  const setCloudBagView = useWorkspaceStore((s) => s.setCloudBagView)
  const [repo, setRepo] = useState<CloudBagRepo | null>(null)
  const [tree, setTree] = useState<CloudBagTreeEntry[] | null>(null)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeNextCursor, setTreeNextCursor] = useState<string | null>(null)
  const [treeLoadingMore, setTreeLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const loadGeneration = useRef(0)
  const treeGeneration = useRef(0)

  /**
   * 文件树游标分页：服务端默认每页 200 条（上限 500），nextCursor 非空即表示还有
   * 后续页。此前只取首页且丢弃 nextCursor，>200 文件的仓库会静默只显示前 200 条。
   */
  const loadTreePage = useCallback(async (versionNo: number, cursor: string | null, append: boolean) => {
    const generation = ++treeGeneration.current
    if (append) setTreeLoadingMore(true)
    try {
      const result = await api.tree(slug, versionNo, cursor ?? undefined, 500)
      if (generation !== treeGeneration.current) return
      setTree((current) => append ? [...(current ?? []), ...(result.items ?? [])] : (result.items ?? []))
      setTreeNextCursor(result.nextCursor ?? null)
      setTreeError(null)
    } catch (treeErr) {
      if (generation !== treeGeneration.current) return
      if (!append) setTree([])
      setTreeNextCursor(null)
      setTreeError(treeErr instanceof Error ? treeErr.message : String(treeErr))
    } finally {
      if (generation === treeGeneration.current) setTreeLoadingMore(false)
    }
  }, [api, slug])

  const loadRepo = useCallback(async () => {
    const generation = ++loadGeneration.current
    setError(null)
    try {
      const detail = await api.repo(slug)
      if (generation !== loadGeneration.current) return
      setRepo(detail)
      if (!(detail.headVersionNo > 0)) {
        // 仓库还没有版本：不存在可读版本树，直接置空（api.tree(slug, 0) 必失败，
        // 否则错误会被 repo 已成功的分支吞掉，页签永远停在 loading）
        treeGeneration.current++
        setTree([])
        setTreeNextCursor(null)
        setTreeError(null)
        return
      }
      await loadTreePage(detail.headVersionNo, null, false)
    } catch (err) {
      if (generation === loadGeneration.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [api, slug, loadTreePage])

  useEffect(() => {
    const timer = setTimeout(() => { void loadRepo() }, 0)
    return () => clearTimeout(timer)
  }, [loadRepo])

  if (error && !repo) {
    return (
      <PanelState
        kind="error"
        title="仓库加载失败"
        description={error}
        action={<button className="btn" onClick={onBack}>返回仓库列表</button>}
        onRetry={() => void loadRepo()}
      />
    )
  }
  if (!repo) return <PanelState kind="loading" title="加载仓库详情…" />

  const deepLink = repoDeepLink(endpoint, repo.slug)
  // 仓库级角色门控：与网页端 isEditor 对齐——非成员/查看者即使邮箱已验证也无写权限，
  // 服务端（cloudbag_object.go / cloudbag_version.go 的 editor 档）必然拒绝。
  const canEditRepo = repo.myRole === 'owner' || repo.myRole === 'editor'
  const canSync = gate.canWrite && canEditRepo && Boolean(activeProject)
  const syncTitle = !gate.canWrite
    ? '请先登录并完成邮箱认证（离线/未验证状态下不可同步）'
    : !canEditRepo
      ? `你在该仓库没有编辑权限（当前角色：${repo.myRole ?? '非成员'}）`
      : !activeProject
        ? '先打开一个本地项目，再同步云书包'
        : `与本地项目「${activeProject.name}」手动同步`

  return (
    <div className="cloudbag-body">
      {/* repo 已加载后仍可能出错（删除仓库后刷新、树加载失败、权限被撤）：必须如实渲染，
          否则界面停在旧数据上，用户以为操作没生效 */}
      {error && <div className="local-note community-warning" role="status">{error}</div>}
      <div className="community-card post-card cloudbag-repo-head">
        <div className="post-card-title">
          <button className="btn-sm" onClick={onBack} title="返回仓库列表">← 返回</button>
          <span>{repo.title}</span>
          <span className="badge">{VISIBILITY_LABELS[repo.visibility] ?? repo.visibility}</span>
          {repo.myRole && <span className="badge info">{repo.myRole === 'owner' ? '所有者' : repo.myRole === 'editor' ? '编辑者' : '查看者'}</span>}
        </div>
        <div className="post-card-meta">
          {repo.visibility === 'link' ? (
            // link 可见性必须携带一次性分享 token 才能被他人读取；桌面 V1 未支持创建分享，
            // 这里显式停用并说明，而不是复制一条对接收者无效的深链
            <button className="btn-sm" aria-disabled="true" title="链接可见仓库需要一次性分享 token（桌面端 V1 未支持创建分享，请在社区网页创建）">
              <AppIcon name="link" size={12} /> {repo.slug}
            </button>
          ) : (
            <button className="btn-sm" title={deepLink} onClick={() => { void navigator.clipboard?.writeText(deepLink).then(() => setCopied(true)).catch(() => undefined) }}>
              <AppIcon name="link" size={12} /> {copied ? '已复制深链' : repo.slug}
            </button>
          )}
          {' · '}{repo.versionCount} 版本 · {repo.fileCount} 文件 · {formatBytes(repo.totalSize)} · 配额 {formatBytes(repo.quota?.usedBytes ?? 0)}/{formatBytes(repo.quota?.limitBytes ?? 0)}
        </div>
        {repo.visibility === 'link' && <div className="local-note">链接可见仓库的分享链接需要一次性 token；桌面 V1 未支持创建分享，请到社区网页创建后再分发。</div>}
        {repo.description && <p>{repo.description}</p>}
        <div className="mod-tags">{(repo.tags ?? []).map((tag) => <span className="badge" key={tag}>{tag}</span>)}</div>
        <div className="cloudbag-unsupported-row">
          <button className="btn primary" disabled={!canSync} title={syncTitle} onClick={() => setSyncOpen(true)}>
            <AppIcon name="upload" size={12} /> 发布新版本 / 拉取
          </button>
          {/* 未支持入口同样用 aria-disabled：键盘/读屏/触屏用户都能取到原因文字 */}
          <button className="btn-sm" aria-disabled="true" title="未支持：自动同步与文件监听（V1 仅手动同步）">自动同步</button>
          {/* V1 降级（契约 §1.1）：发布（releases）/分享仅网页端可用。可聚焦 + 说明行
              指路，避免只想「发布 release」的桌面用户在应用内找不到任何线索。 */}
          <button className="btn-sm" aria-disabled="true" title={`未支持：发布（releases）与分享链接请在社区网页操作 ${deepLink}`}>发布 / 分享（网页端）</button>
        </div>
        <div className="local-note">桌面 V1 未支持：自动同步与文件监听；发布（releases）与分享链接请到社区网页操作 {deepLink}</div>
      </div>
      <div className="community-tabs" role="tablist" aria-label="仓库内容页签" onKeyDown={(event) => {
        // 与社区主页签条同一键盘约定：roving tabindex + ←/→ 跳转焦点
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const keys = Object.keys(SECTION_LABELS) as RepoSection[]
        const index = keys.indexOf(section)
        const next = keys[(index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length]
        event.preventDefault()
        setCloudBagView({ section: next })
        document.getElementById(`cloudbag-tab-${next}`)?.focus()
      }}>
        {(Object.keys(SECTION_LABELS) as RepoSection[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`cloudbag-tab-${key}`}
            aria-controls={`cloudbag-tabpanel-${key}`}
            aria-selected={section === key}
            tabIndex={section === key ? 0 : -1}
            className={`community-tab${section === key ? ' active' : ''}`}
            onClick={() => setCloudBagView({ section: key })}
          >
            {SECTION_LABELS[key]}
          </button>
        ))}
      </div>
      <div
        id={`cloudbag-tabpanel-${section}`}
        role="tabpanel"
        aria-labelledby={`cloudbag-tab-${section}`}
        tabIndex={0}
      >
      {section === 'files' && (treeError
        ? <PanelState kind="error" title="文件树加载失败" description={treeError} onRetry={() => void loadRepo()} />
        : tree === null
          ? <PanelState kind="loading" title="加载文件树…" />
          : tree.length === 0
            ? <PanelState kind="empty" icon="folder" title="仓库还没有文件" description="提交第一个版本后这里会显示文件树。" />
            : <>
              {treeNextCursor && (
                <div className="local-note community-warning" role="status">
                  仓库文件较多，已加载 {tree.length} 个（仓库共 {repo.fileCount} 个），仍有后续文件未显示。
                </div>
              )}
              <div className="cloudbag-tree">{buildCloudBagTree(tree).map((node) => (
                <TreeNodeRow key={node.path} node={node} depth={0} expanded={expanded} toggle={(path) => setExpanded((current) => {
                  const next = new Set(current)
                  if (next.has(path)) next.delete(path)
                  else next.add(path)
                  return next
                })} onOpenFile={(path) => setPreviewPath(path)} />
              ))}</div>
              {treeNextCursor && (
                <button className="btn" disabled={treeLoadingMore} onClick={() => void loadTreePage(repo.headVersionNo, treeNextCursor, true)}>
                  {treeLoadingMore ? '加载中…' : `加载更多文件（已 ${tree.length} / ${repo.fileCount}）`}
                </button>
              )}
            </>)}
      {section === 'files' && <div className="local-note">文件树为只读（网页在线编辑属未支持项）；本地编辑请在工作台修改后手动发布新版本。</div>}
      {section === 'versions' && <VersionsView api={api} repo={repo} canWrite={gate.canWrite && canEditRepo} onChanged={() => void loadRepo()} />}
      {section === 'members' && <MembersView api={api} repo={repo} canWrite={gate.canWrite} />}
      {section === 'settings' && <SettingsView api={api} repo={repo} canWrite={gate.canWrite} onChanged={() => void loadRepo()} onDeleted={onBack} />}
      </div>
      {previewPath && repo.headVersionNo > 0 && (
        <FilePreviewModal api={api} slug={repo.slug} versionNo={repo.headVersionNo} path={previewPath} onClose={() => setPreviewPath(null)} />
      )}
      {syncOpen && activeProject && (
        <CloudBagSyncModal
          api={api}
          rootPath={activeProject.rootPath}
          projectName={activeProject.name}
          repo={repo}
          onClose={() => setSyncOpen(false)}
          onChanged={() => void loadRepo()}
        />
      )}
    </div>
  )
}
