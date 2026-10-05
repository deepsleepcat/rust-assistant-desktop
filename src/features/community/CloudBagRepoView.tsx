import { CloudBagRepoHeader } from './CloudBagRepoHeader'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PanelState } from '../../components/PanelState'
import { useWorkspaceStore } from '../../stores/workspace'
import type { CloudBagApi, CloudBagRepo, CloudBagTreeEntry } from '../../services/cloudBagApi'
import { buildCloudBagTree, repoDeepLink, type CloudBagGate } from './cloudBagData'
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

const SECTION_LABELS = { files: '文件', versions: '版本', members: '成员', settings: '设置' } as const
type RepoSection = keyof typeof SECTION_LABELS

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
      <CloudBagRepoHeader repo={repo} onBack={onBack} deepLink={deepLink} copied={copied} onCopy={() => { void navigator.clipboard?.writeText(deepLink).then(() => setCopied(true)).catch(() => undefined) }} canSync={canSync} syncTitle={syncTitle} onSync={() => setSyncOpen(true)} />
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
      {section === 'versions' && <>
        <VersionsView api={api} repo={repo} canWrite={gate.canWrite && canEditRepo} onChanged={() => void loadRepo()} />
        <CloudBagPublicationHistory api={api} slug={repo.slug} isEditor={canEditRepo} />
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
