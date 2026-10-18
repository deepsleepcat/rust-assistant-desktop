import { ImportToCloudModal } from './CloudBagPanel'
import { CloudBagRepoHeader } from './CloudBagRepoHeader'
import { CloudBagReadme } from './CloudBagReadme'
import { CloudBagIssues } from './CloudBagIssues'
import { CloudBagPublish } from './CloudBagPublish'
import { autoSyncKey, configureAutoSync, useCloudBagAutoSync } from '../../services/cloudBagAutoSync'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PanelState } from '../../components/PanelState'
import { useWorkspaceStore } from '../../stores/workspace'
import type { CloudBagApi, CloudBagRepo, CloudBagTreeEntry } from '../../services/cloudBagApi'
import { buildCloudBagTree, formatBytes, repoDeepLink, type CloudBagGate } from './cloudBagData'
import { CloudBagSyncModal } from './CloudBagSyncModal'
import { CloudBagPublicationHistory } from './CloudBagPublicationHistory'
import { TreeNodeRow, FilePreviewModal } from './CloudBagRepoFiles'
import { VersionsView } from './CloudBagRepoVersions'
import { MembersView } from './CloudBagRepoMembers'
import { SettingsView } from './CloudBagRepoSettings'

/**
 * 云书包仓库详情（GitHub 风格映射）：头部元数据 + 文件树/版本/成员/设置四子页签。
 * V1 文件树只读（网页在线编辑属未支持清单）；同步（发布/拉取）仅手动触发。
 */

const SECTION_LABELS = { files: '文件', issues: 'Issues', versions: '版本与发布', members: '成员', settings: '设置' } as const
type RepoSection = keyof typeof SECTION_LABELS

export function CloudBagRepoView({ api, slug, gate, onBack }: {
  api: CloudBagApi
  slug: string
  gate: CloudBagGate
  onBack: () => void
}) {
  const endpoint = useWorkspaceStore((s) => s.settings.ai.communityEndpoint)
  const userId = useWorkspaceStore((s) => s.communityAuth.user?.id)
  const autoBindings = useCloudBagAutoSync((s) => s.bindings)
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
  const [importOpen, setImportOpen] = useState(false)
  const [syncHint, setSyncHint] = useState('')
  const [copied, setCopied] = useState(false)
  const [starBusy, setStarBusy] = useState(false)
  const [publicationRevision, setPublicationRevision] = useState(0)
  const starLock = useRef(false)
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
      if (generation === loadGeneration.current) {
        setRepo(null)
        setTree(null)
        setPreviewPath(null)
        setSyncOpen(false)
        setError(err instanceof Error ? err.message : String(err))
      }
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
  const autoBinding = userId && activeProject ? autoBindings[autoSyncKey(endpoint, userId, activeProject.rootPath, repo.slug)] : undefined
  const configure = (action: 'enable' | 'pause' | 'disable') => {
    if (!activeProject) {
      setSyncHint('请先选择用于同步的本地项目，再开启自动同步。首次使用需先完成一次手动同步。')
      void useWorkspaceStore.getState().openProject()
      return
    }
    setSyncHint('')
    if (userId && activeProject) configureAutoSync({ endpoint, userId, rootPath: activeProject.rootPath, projectId: activeProject.id, repoSlug: repo.slug }, action)
  }
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
      <CloudBagRepoHeader repo={repo} onBack={onBack} onShare={() => setCloudBagView({ section: 'versions' })} deepLink={deepLink} copied={copied} onCopy={() => { void navigator.clipboard?.writeText(deepLink).then(() => setCopied(true)).catch(() => undefined) }} canSync={canSync} syncTitle={syncTitle} onSync={() => setSyncOpen(true)} canStar={gate.canWrite} starBusy={starBusy} onStar={() => {
        if (starLock.current) return
        starLock.current = true; setStarBusy(true)
        void api.setStar(repo.slug, !repo.starred).then((result) => setRepo((current) => current ? { ...current, ...result } : null)).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => { starLock.current = false; setStarBusy(false) })
      }} />
      <div className="cloudbag-actions"><button className="btn primary" disabled={!gate.canWrite || !canEditRepo} onClick={() => setImportOpen(true)}>上传文件 / 导入模组</button><button className="btn" disabled={!gate.canWrite || !canEditRepo} onClick={() => configure(autoBinding?.enabled && !autoBinding.paused ? 'pause' : 'enable')}>{autoBinding?.enabled && !autoBinding.paused ? '暂停自动同步' : '开启自动同步'}</button>{autoBinding?.enabled && <button className="btn" onClick={() => configure('disable')}>关闭自动同步</button>}<span className="local-note" role="status">{autoBinding?.message ?? '自动同步已关闭'}{autoBinding?.progress ? ` · ${autoBinding.progress.done}/${autoBinding.progress.total}` : ''}</span><button className="btn" disabled={!canEditRepo || !gate.canWrite} onClick={() => setCloudBagView({ section: 'versions' })}>发布 / 分享</button></div>
      {syncHint && <p className="local-note" role="status">{syncHint}</p>}
      {importOpen && <ImportToCloudModal api={api} initialTarget={repo.slug} activeProjectName={activeProject?.name ?? null} activeProjectPath={activeProject?.rootPath ?? null} onClose={() => setImportOpen(false)} onImported={() => { setImportOpen(false); void loadRepo() }} onRepoCreated={() => void loadRepo()} />}
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
      {section === 'files' && <div className="cloudbag-repository-layout"><main className="cloudbag-repository-main">
      <div className="cloudbag-file-toolbar"><strong>{repo.headVersionNo > 0 ? `当前版本 #${repo.headVersionNo}` : '尚无版本'}</strong><span>{repo.fileCount} 个文件</span><button className="btn-sm" onClick={() => setCloudBagView({ section: 'versions' })}>查看版本与下载</button></div>
      {treeError
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
            </>}
      {tree && <CloudBagReadme key={`${slug}:${repo.headVersionNo}`} api={api} slug={slug} versionNo={repo.headVersionNo} files={tree} />}
      </main><aside className="cloudbag-repository-about" aria-label="仓库信息">
        <section><h3>关于仓库</h3><p>{repo.description || '仓库尚未填写简介。'}</p><div className="mod-tags">{(repo.tags ?? []).map((tag) => <span className="badge" key={tag}>{tag}</span>)}</div></section>
        <section><h3>仓库数据</h3><dl><div><dt>文件大小</dt><dd>{formatBytes(repo.totalSize)}</dd></div><div><dt>版本</dt><dd>{repo.versionCount}</dd></div>{repo.starCount !== undefined && <div><dt>Star</dt><dd>{repo.starCount}</dd></div>}{repo.openIssueCount !== undefined && <div><dt>未关闭 Issues</dt><dd>{repo.openIssueCount}</dd></div>}</dl>{repo.quota && <p className="local-note">配额 {formatBytes(repo.quota.usedBytes)} / {formatBytes(repo.quota.limitBytes)}</p>}</section>
        <section><h3>发布与协作</h3><button className="btn" onClick={() => setCloudBagView({ section: 'versions' })}>查看发布与分享</button>{repo.myRole && <button className="btn" onClick={() => setCloudBagView({ section: 'members' })}>查看仓库成员</button>}</section>
      </aside></div>}
      {section === 'issues' && <CloudBagIssues api={api} repo={repo} canWrite={gate.canWrite} onChanged={() => void loadRepo()} />}
      {section === 'versions' && <>
        {canEditRepo && <CloudBagPublish api={api} repo={repo} canWrite={gate.canWrite && canEditRepo} onChanged={() => { setPublicationRevision((value) => value + 1); void loadRepo() }} />}
        <VersionsView api={api} repo={repo} canWrite={gate.canWrite && canEditRepo} onChanged={() => void loadRepo()} />
        <CloudBagPublicationHistory api={api} slug={repo.slug} isEditor={canEditRepo} canWrite={gate.canWrite && canEditRepo} revision={publicationRevision} />
      </>}
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
