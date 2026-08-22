import { useCallback, useEffect, useRef, useState } from 'react'
import { AppIcon } from '../../components/AppIcon'
import { Modal } from '../../components/Modal'
import { PanelState } from '../../components/PanelState'
import { useWorkspaceStore } from '../../stores/workspace'
import { createCommunityApi, resolveCommunityUrl, type CommunityApi, type CommunityComment, type CommunityPost, type CommunityPostDetail, type CommunityRankingItem, type CommunityResource, type PostFeed } from '../../services/communityApi'
import { localCommunityDataSource, TAB_LABELS, type CommunitySnapshot, type CommunityTab } from './communityData'

const FEEDS: Array<{ value: PostFeed; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'hot', label: '热门' },
  { value: 'featured', label: '精选' },
  { value: 'dynamic', label: '动态' },
  { value: 'question', label: '问答' },
  { value: 'article', label: '文章' },
]
const BOARD_OPTIONS = [
  { value: '', label: '全部板块' },
  { value: 'discussion', label: '讨论' },
  { value: 'help', label: '求助' },
  { value: 'showcase', label: '展示' },
  { value: 'tutorial', label: '教程' },
  { value: 'resource', label: '资源' },
]

type LocalPost = CommunityPost & { local: true }
type DisplayPost = CommunityPost | LocalPost

function isLocal(post: DisplayPost): post is LocalPost {
  return 'local' in post && post.local === true
}

function localPosts(snapshot: CommunitySnapshot): LocalPost[] {
  return snapshot.mods.map((mod, index) => ({
    id: index + 1,
    board: 'showcase',
    title: mod.name,
    body: mod.description,
    author_user_id: 0,
    author_name: snapshot.creators.find((c) => c.id === mod.authorId)?.name ?? '本地创作者',
    status: 'visible',
    resource_count: 0,
    comment_count: 0,
    created_at: Math.floor(mod.updatedAt / 1000),
    updated_at: Math.floor(mod.updatedAt / 1000),
    content_type: 'dynamic',
    tags: mod.tags,
    view_count: mod.downloads,
    like_count: mod.favorites,
    featured: mod.featured,
    pinned: false,
    local: true,
  }))
}

function formatTime(seconds: number): string {
  const time = seconds > 10_000_000_000 ? seconds : seconds * 1000
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(time).toLocaleDateString()
}

function safeMarkdown(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]+)\]\((?:javascript:|data:)[^)]+\)/gi, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, '$1 ($2)')
}

export function CommunityPanel() {
  const tab = useWorkspaceStore((s) => s.communityTab)
  const setTab = useWorkspaceStore((s) => s.setCommunityTab)
  const settings = useWorkspaceStore((s) => s.settings)
  const following = useWorkspaceStore((s) => s.communityFollowing)
  const toggleFollow = useWorkspaceStore((s) => s.toggleCommunityFollow)
  const loginCommunity = useWorkspaceStore((s) => s.loginCommunity)
  const refreshCommunityAuth = useWorkspaceStore((s) => s.refreshCommunityAuth)
  const communityAuth = useWorkspaceStore((s) => s.communityAuth)
  const signedIn = communityAuth.status === 'signed_in'
  const [api, setApi] = useState<CommunityApi | null>(null)
  const [posts, setPosts] = useState<DisplayPost[]>([])
  const [localMode, setLocalMode] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [feed, setFeed] = useState<PostFeed>('all')
  const [board, setBoard] = useState('')
  const [keyword, setKeyword] = useState('')
  const [tag, setTag] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [detail, setDetail] = useState<CommunityPostDetail | null>(null)
  const [detailLocal, setDetailLocal] = useState<DisplayPost | null>(null)
  const [currentUserId, setCurrentUserId] = useState<number | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [formOpen, setFormOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const openCommunityLogin = () => void loginCommunity()
  const handleUnauthorized = useCallback(() => {
    setCurrentUserId(null)
    setMessage('社区登录已失效，请重新登录')
    void refreshCommunityAuth().catch(() => undefined)
  }, [refreshCommunityAuth])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const endpoint = settings.ai.communityEndpoint
    try {
      const client = createCommunityApi(endpoint, undefined, undefined, handleUnauthorized)
      setApi(client)
      if (signedIn) void client.me().then((user) => setCurrentUserId(user.id)).catch(() => setCurrentUserId(null))
      else setCurrentUserId(null)
      if (tab === 'following') {
        if (!signedIn) throw new Error('请先在登录界面登录社区账号')
        const result = await client.following(page)
        setPosts(result.items)
        setTotal(result.total)
      } else {
        const result = await client.posts({ board: board || undefined, keyword: keyword || undefined, feed, tag: tag || undefined, page })
        setPosts(result.items)
        setTotal(result.total)
      }
      setLocalMode(false)
    } catch (err) {
      try {
        const snapshot = await localCommunityDataSource.getSnapshot()
        const fallback = localPosts(snapshot)
        setPosts(fallback)
        setTotal(fallback.length)
        setLocalMode(true)
        setApi(null)
        setCurrentUserId(null)
        setError(err instanceof Error ? err.message : String(err))
      } catch (fallbackError) {
        setError(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
      }
    } finally {
      setLoading(false)
    }
  }, [board, handleUnauthorized, feed, keyword, page, settings.ai.communityEndpoint, signedIn, tab, tag])

  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(timer)
  }, [load, refreshKey])

  const openPost = async (post: DisplayPost) => {
    if (isLocal(post) || !api) {
      setDetailLocal(post)
      setDetail(null)
      return
    }
    try {
      setDetail(await api.post(post.id))
      setDetailLocal(null)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const onFollow = async (authorId: number) => {
    if (!api || localMode || !signedIn) {
      setMessage('请先登录社区账号，再关注作者')
      openCommunityLogin()
      return
    }
    const key = String(authorId)
    try {
      if (following.includes(key)) await api.unfollow(authorId)
      else await api.follow(authorId)
      toggleFollow(key)
      setMessage(following.includes(key) ? '已取消关注' : '已关注作者')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const onLike = async (post: CommunityPost) => {
    if (!api || localMode || !signedIn) {
      setMessage('请先登录社区账号，再点赞')
      openCommunityLogin()
      return
    }
    try {
      if (post.liked) await api.unlike(post.id)
      else await api.like(post.id)
      setPosts((current) => current.map((item) => item.id === post.id ? { ...item, liked: !post.liked, like_count: Math.max(0, (item.like_count ?? 0) + (post.liked ? -1 : 1)) } : item))
      setDetail((current) => current && current.id === post.id ? { ...current, liked: !post.liked, like_count: Math.max(0, (current.like_count ?? 0) + (post.liked ? -1 : 1)) } : current)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="community-panel panel">
      <div className="panel-header">
        <AppIcon name="share" size={13} /> 社区
        <span className={`badge ${localMode ? 'info' : 'success'}`} title={localMode ? '服务器不可用时展示内置示例数据' : '已连接社区服务器'}>{localMode ? '本地示例' : '在线'}</span>
        <span className="grow" />
        <button className="icon-btn" title="刷新社区数据" aria-label="刷新社区数据" onClick={() => setRefreshKey((n) => n + 1)}><AppIcon name="refresh" size={13} /></button>
      </div>
      <div className="community-tabs" role="tablist" aria-label="社区页签" onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        const keys = Object.keys(TAB_LABELS) as CommunityTab[]
        const index = keys.indexOf(tab)
        const next = keys[(index + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length]
        event.preventDefault()
        setTab(next)
        document.getElementById(`community-tab-${next}`)?.focus()
      }}>
        {(Object.keys(TAB_LABELS) as CommunityTab[]).map((key) => (
          <button key={key} type="button" role="tab" id={`community-tab-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} className={`community-tab${tab === key ? ' active' : ''}`} onClick={() => { setPage(1); setTab(key) }}>
            {TAB_LABELS[key]}{key === 'following' && following.length > 0 && <span className="count">{following.length}</span>}
          </button>
        ))}
      </div>
      <div className="community-body" role="tabpanel" tabIndex={0}>
        {loading ? <PanelState kind="loading" title="加载社区内容…" /> : (
          <>
            {error && <div className="local-note community-warning">{error}。当前保留本地示例浏览。</div>}
            {tab === 'recommend' && <RecommendView feed={feed} setFeed={(value) => { setFeed(value); setPage(1) }} board={board} setBoard={(value) => { setBoard(value); setPage(1) }} keyword={keyword} setKeyword={(value) => { setKeyword(value); setPage(1) }} tag={tag} setTag={(value) => { setTag(value); setPage(1) }} onSearch={() => setRefreshKey((n) => n + 1)} posts={posts} onOpen={openPost} onLike={onLike} />}
            {tab === 'following' && <FollowingView posts={posts} localMode={localMode} onOpen={openPost} onLike={onLike} />}
            {tab === 'ranking' && <RankingView api={api} localMode={localMode} onOpen={openPost} />}
            {tab === 'me' && <MeView api={api} signedIn={signedIn} following={following} onOpenLogin={openCommunityLogin} onCreate={() => setFormOpen(true)} />}
            <div className="community-pagination">
              <span>{total > 0 ? `共 ${total} 条` : '暂无内容'}</span>
              <span className="grow" />
              <button className="btn-sm" disabled={page <= 1} onClick={() => setPage((n) => Math.max(1, n - 1))}>上一页</button>
              <span>第 {page} 页</span>
              <button className="btn-sm" disabled={page * 12 >= total || total === 0} onClick={() => setPage((n) => n + 1)}>下一页</button>
            </div>
          </>
        )}
      </div>
      {(detail || detailLocal) && <PostDetailModal key={(detail ?? detailLocal!).id} api={api} post={detail ?? detailLocal!} signedIn={signedIn} currentUserId={currentUserId} following={following} onClose={() => { setDetail(null); setDetailLocal(null) }} onLike={onLike} onFollow={onFollow} onChanged={() => setRefreshKey((n) => n + 1)} />}
      {formOpen && <CreatePostModal api={api} signedIn={signedIn} onClose={() => setFormOpen(false)} onCreated={() => { setFormOpen(false); setRefreshKey((n) => n + 1) }} />}
      {message && <div className="community-toast" role="status" onClick={() => setMessage(null)}>{message}</div>}
    </section>
  )
}

function RecommendView({ feed, setFeed, board, setBoard, keyword, setKeyword, tag, setTag, onSearch, posts, onOpen, onLike }: { feed: PostFeed; setFeed: (value: PostFeed) => void; board: string; setBoard: (value: string) => void; keyword: string; setKeyword: (value: string) => void; tag: string; setTag: (value: string) => void; onSearch: () => void; posts: DisplayPost[]; onOpen: (post: DisplayPost) => void; onLike: (post: CommunityPost) => void }) {
  return <>
    <div className="community-section community-toolbar">
      <div className="rank-filter">{FEEDS.map((item) => <button key={item.value} type="button" className={`rank-chip${feed === item.value ? ' active' : ''}`} aria-pressed={feed === item.value} onClick={() => setFeed(item.value)}>{item.label}</button>)}</div>
      <select aria-label="社区板块" value={board} onChange={(event) => setBoard(event.target.value)}>{BOARD_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
      <input aria-label="搜索帖子" value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSearch() }} placeholder="搜索帖子" />
      <input aria-label="按标签筛选" value={tag} onChange={(event) => setTag(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSearch() }} placeholder="标签" />
      <button className="btn-sm" onClick={onSearch}>搜索</button>
    </div>
    {posts.length === 0 ? <PanelState kind="empty" icon="search" title="没有找到帖子" description="换一个关键词或筛选条件试试。" /> : <div className="post-list">{posts.map((post) => <PostCard key={post.id} post={post} onOpen={() => onOpen(post)} onLike={() => onLike(post)} />)}</div>}
  </>
}

function FollowingView({ posts, localMode, onOpen, onLike }: { posts: DisplayPost[]; localMode: boolean; onOpen: (post: DisplayPost) => void; onLike: (post: CommunityPost) => void }) {
  if (localMode) return <PanelState kind="empty" icon="search" title="登录后查看关注流" description="在设置中登录社区账号，关注作者后这里会显示他们的内容。" />
  if (posts.length === 0) return <PanelState kind="empty" icon="search" title="还没有关注动态" description="去推荐页关注喜欢的作者。" />
  return <div className="post-list">{posts.map((post) => <PostCard key={post.id} post={post} onOpen={() => onOpen(post)} onLike={() => onLike(post)} />)}</div>
}

function RankingView({ api, localMode, onOpen }: { api: CommunityApi | null; localMode: boolean; onOpen: (post: DisplayPost) => void }) {
  const [kind, setKind] = useState<'posts' | 'authors'>('posts')
  const [items, setItems] = useState<CommunityRankingItem[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!api || localMode) return
    let alive = true
    void api.rankings(kind).then((result) => alive && setItems(result)).catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => { alive = false }
  }, [api, kind, localMode])
  if (localMode) return <PanelState kind="empty" title="排行暂不可用" description="连接社区服务器后可查看热门帖子和活跃作者排行。" />
  return <>
    <div className="rank-filter">{(['posts', 'authors'] as const).map((value) => <button key={value} className={`rank-chip${kind === value ? ' active' : ''}`} aria-pressed={kind === value} onClick={() => setKind(value)}>{value === 'posts' ? '热门帖子' : '活跃作者'}</button>)}</div>
    {error ? <PanelState kind="error" title="排行加载失败" description={error} /> : items.length === 0 ? <PanelState kind="empty" title="暂无排行数据" /> : <div className="rank-list">{items.map((item, index) => <div className="rank-item" key={`${item.id ?? item.post_id ?? item.author_user_id}-${index}`}><span className={`rank-no${index < 3 ? ' top' : ''}`}>{index + 1}</span><div className="rank-info"><div className="rank-name">{item.title ?? item.author_name ?? '未知对象'}</div><div className="rank-meta">{item.score ?? item.like_count ?? item.post_count ?? item.count ?? 0} 热度</div></div>{kind === 'posts' && item.post_id && api && <button className="btn-sm" onClick={() => void api.post(item.post_id!).then((post) => onOpen(post)).catch(() => undefined)}>详情</button>}</div>)}</div>}
  </>
}

function MeView({ api, signedIn, following, onOpenLogin, onCreate }: { api: CommunityApi | null; signedIn: boolean; following: string[]; onOpenLogin: () => void; onCreate: () => void }) {
  const [user, setUser] = useState<{ username: string; display_name?: string; email?: string; avatar_url?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!api || !signedIn) return
    let alive = true
    void api.me().then((value) => alive && setUser(value)).catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => { alive = false }
  }, [api, signedIn])
  if (!signedIn) return <PanelState kind="empty" icon="search" title="尚未登录社区账号" description="登录后可以发帖、评论、点赞、关注作者和上传资源。" action={<button className="btn primary" onClick={onOpenLogin}>在浏览器中登录</button>} />
  return <>
    <div className="community-card me-profile">{resolveCommunityAvatar(api, user?.avatar_url) ? <img className="creator-avatar me-avatar" src={resolveCommunityAvatar(api, user?.avatar_url)!} alt="社区头像" /> : <span className="creator-avatar me-avatar" style={{ background: '#4285f4' }}>{(user?.display_name ?? user?.username ?? '我').slice(0, 1)}</span>}<div className="creator-info"><div className="creator-name">{user?.display_name ?? user?.username ?? '已登录'}</div><div className="creator-tagline">{user?.email || '社区账号'}</div></div><span className="badge success">已登录</span></div>
    {error && <div className="local-note community-warning">{error}</div>}
    <div className="disabled-row"><button className="btn primary" onClick={onCreate}>发布帖子</button><span className="local-note">已关注作者：{following.length} 人</span></div>
  </>
}

function resolveCommunityAvatar(api: CommunityApi | null, avatarUrl: string | undefined): string | null {
  return api ? resolveCommunityUrl(api.endpoint, avatarUrl) : null
}

function PostCard({ post, onOpen, onLike }: { post: DisplayPost; onOpen: () => void; onLike: () => void }) {
  return <article className="community-card post-card"><button className="post-card-main" onClick={onOpen}><div className="post-card-title"><span>{post.pinned && '置顶 · '}{post.title}</span>{post.featured && <span className="badge info">精选</span>}</div><div className="post-card-meta">{post.author_name} · {post.board} · {formatTime(post.updated_at)}</div><p>{safeMarkdown(post.body).slice(0, 240)}</p><div className="mod-tags">{(post.tags ?? []).map((item) => <span className="badge" key={item}>{item}</span>)}</div></button><div className="post-card-foot"><span>{post.comment_count ?? 0} 评论 · {post.view_count ?? 0} 浏览</span><span className="grow" /><button className="btn-sm" onClick={(event) => { event.stopPropagation(); onLike() }}>{post.liked ? '已赞' : '点赞'} {post.like_count ?? 0}</button><button className="btn-sm" onClick={onOpen}>查看详情</button></div></article>
}

function PostDetailModal({ api, post, signedIn, currentUserId, following, onClose, onLike, onFollow, onChanged }: { api: CommunityApi | null; post: DisplayPost; signedIn: boolean; currentUserId: number | null; following: string[]; onClose: () => void; onLike: (post: CommunityPost) => void; onFollow: (id: number) => void; onChanged: () => void }) {
  const [comments, setComments] = useState<CommunityComment[]>([])
  const [comment, setComment] = useState('')
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null)
  const [editingCommentBody, setEditingCommentBody] = useState('')
  const [editingPost, setEditingPost] = useState(false)
  const [editingTitle, setEditingTitle] = useState(post.title)
  const [editingBody, setEditingBody] = useState(post.body)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resourceItems, setResourceItems] = useState<CommunityResource[]>(!isLocal(post) ? ((post as CommunityPostDetail).resources ?? []) : [])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resources = resourceItems
  useEffect(() => {
    if (!api || isLocal(post)) return
    void api.comments(post.id).then((result) => setComments(result.items)).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [api, post])
  const uploadResource = async (file: File) => {
    if (!api || isLocal(post) || !signedIn) return
    if (file.size > 50 * 1024 * 1024) {
      setError('附件超过 50 MiB 限制')
      return
    }
    setBusy(true)
    try {
      const resource = await api.uploadResource(post.id, file)
      setResourceItems((items) => [...items, resource])
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const savePost = async () => {
    if (!api || isLocal(post) || !signedIn || !editingTitle.trim() || !editingBody.trim()) return
    setBusy(true)
    try {
      await api.updatePost(post.id, { board: post.board, title: editingTitle.trim(), body: editingBody.trim(), content_type: post.content_type, tags: post.tags })
      setEditingPost(false)
      setEditingTitle(editingTitle.trim())
      setEditingBody(editingBody.trim())
      onChanged()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const deletePost = async () => {
    if (!api || isLocal(post) || !signedIn || !window.confirm('确定删除这篇帖子及其关联内容吗？')) return
    setBusy(true)
    try {
      await api.deletePost(post.id)
      onChanged()
      onClose()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const saveComment = async (id: number) => {
    if (!api || !editingCommentBody.trim()) return
    setBusy(true)
    try {
      const updated = await api.updateComment(id, editingCommentBody.trim())
      setComments((items) => items.map((item) => item.id === id ? updated : item))
      setEditingCommentId(null)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const deleteComment = async (id: number) => {
    if (!api || !window.confirm('确定删除这条评论吗？')) return
    setBusy(true)
    try {
      await api.deleteComment(id)
      setComments((items) => items.filter((item) => item.id !== id))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const submitComment = async () => {
    if (!api || isLocal(post) || !signedIn || !comment.trim()) return
    setBusy(true)
    try {
      const created = await api.createComment(post.id, comment.trim())
      setComments((items) => [...items, created])
      setComment('')
      onChanged()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  const isOwner = !isLocal(post) && currentUserId !== null && post.author_user_id === currentUserId
  return <Modal wide title={<span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><AppIcon name="share" size={15} />{editingPost ? '编辑帖子' : editingTitle}</span>} onClose={onClose} footer={<><button className="btn" onClick={() => onLike(post)} disabled={isLocal(post)}>{post.liked ? '取消点赞' : '点赞'} {post.like_count ?? 0}</button><button className="btn" onClick={() => onFollow(post.author_user_id)} disabled={isLocal(post) || !signedIn}>{following.includes(String(post.author_user_id)) ? '取消关注作者' : '关注作者'}</button>{isOwner && !editingPost && <><button className="btn" onClick={() => setEditingPost(true)}>编辑帖子</button><button className="btn-danger" onClick={() => void deletePost()}>删除帖子</button></>}{editingPost && <button className="btn primary" disabled={busy} onClick={() => void savePost()}>保存修改</button>}<button className="btn" onClick={onClose}>关闭</button></>}>
    <div className="community-detail-body"><div className="post-card-meta">{post.author_name} · {post.board} · {formatTime(post.created_at)}</div>{editingPost ? <div className="community-form"><input aria-label="编辑帖子标题" value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} maxLength={160} /><textarea aria-label="编辑帖子正文" value={editingBody} onChange={(event) => setEditingBody(event.target.value)} maxLength={256 * 1024} rows={12} /></div> : <><div className="mod-tags">{(post.tags ?? []).map((item) => <span className="badge" key={item}>{item}</span>)}</div><p className="community-detail-desc post-body">{safeMarkdown(editingBody)}</p></>}<div className="detail-meta">{post.view_count ?? 0} 浏览 · {post.comment_count ?? comments.length} 评论 · {post.featured ? '精选' : ''}</div>{(resources.length > 0 || (!isLocal(post) && signedIn)) && <div className="community-section"><div className="community-section-title">附件</div>{resources.map((resource) => <div className="resource-row" key={resource.id}><span>{resource.display_name}</span><span className="grow" /><button className="btn-sm" onClick={() => api?.download(resource.id).then(({ blob, filename }) => { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000) }).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>下载</button></div>)}{!isLocal(post) && signedIn && <><input ref={fileInputRef} type="file" hidden accept=".png,.jpg,.jpeg,.webp,.gif,.txt,.json,.zip,.rwmod" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadResource(file) }} /><button className="btn-sm" disabled={busy} onClick={() => fileInputRef.current?.click()}>{busy ? '上传中…' : '上传附件'}</button></>}</div>}<div className="community-section"><div className="community-section-title">评论（{comments.length}）</div>{comments.map((item) => <div className="comment-row" key={item.id}><strong>{item.author_name}</strong><span className="post-card-meta">{formatTime(item.created_at)}</span>{editingCommentId === item.id ? <div className="comment-compose"><input value={editingCommentBody} onChange={(event) => setEditingCommentBody(event.target.value)} maxLength={32_000} /><button className="btn-sm" disabled={busy} onClick={() => void saveComment(item.id)}>保存</button><button className="btn-sm" onClick={() => setEditingCommentId(null)}>取消</button></div> : <><p>{safeMarkdown(item.body)}</p>{currentUserId !== null && item.author_user_id === currentUserId && <div className="comment-actions"><button className="btn-sm" onClick={() => { setEditingCommentId(item.id); setEditingCommentBody(item.body) }}>编辑</button><button className="btn-sm" onClick={() => void deleteComment(item.id)}>删除</button></div>}</>}</div>)}{!isLocal(post) && signedIn && <div className="comment-compose"><input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="写下评论" maxLength={32_000} /><button className="btn-sm" disabled={busy || !comment.trim()} onClick={() => void submitComment()}>发表评论</button></div>}{error && <div className="community-warning">{error}</div>}</div></div>
  </Modal>
}

function CreatePostModal({ api, signedIn, onClose, onCreated }: { api: CommunityApi | null; signedIn: boolean; onClose: () => void; onCreated: () => void }) {
  const [board, setBoard] = useState('discussion')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!api || !signedIn) { setError('请先登录社区账号'); return }
    if (!title.trim() || !body.trim()) { setError('标题和正文不能为空'); return }
    if (title.trim().length > 160) { setError('标题最多 160 个字符'); return }
    setBusy(true)
    try {
      await api.createPost({ board, title: title.trim(), body: body.trim(), tags: tags.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 8) })
      onCreated()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }
  return <Modal title="发布帖子" onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={() => void submit()}>{busy ? '发布中…' : '发布'}</button></>}><div className="community-form"><select aria-label="帖子板块" value={board} onChange={(event) => setBoard(event.target.value)}>{BOARD_OPTIONS.filter((item) => item.value).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><input aria-label="帖子标题" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="标题（最多 160 字符）" maxLength={160} /><input aria-label="帖子标签" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，用逗号分隔" /><textarea aria-label="帖子正文" value={body} onChange={(event) => setBody(event.target.value)} placeholder="正文（支持 Markdown 文本）" maxLength={256 * 1024} rows={12} />{error && <div className="community-warning">{error}</div>}</div></Modal>
}
