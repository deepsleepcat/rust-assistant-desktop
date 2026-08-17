/**
 * 社区中心工作区（M33-社区 第一阶段：本地示例数据）。
 * 参考 RustAssistant-master 的四页签结构：推荐 / 关注 / 排行 / 我的。
 * 数据来自 communityData 的本地数据源（确定性示例数据，无网络请求）；
 * 服务器上线后只需替换 communityDataSource 实现，本组件零改动。
 * 在线能力（下载/发布/登录）在 UI 上明确禁用并标注「等待社区服务器上线」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace'
import { AppIcon } from '../../components/AppIcon'
import { PanelState } from '../../components/PanelState'
import { Modal } from '../../components/Modal'
import { formatRelativeTime } from '../../utils/conversation'
import {
  communityDataSource,
  filterActivitiesByFollowing,
  formatCount,
  profileStats,
  RANKING_DIMENSION_LABELS,
  rotateFeatured,
  sortModsByRanking,
  TAB_LABELS,
  type CommunityActivity,
  type CommunityCreator,
  type CommunityMod,
  type CommunitySnapshot,
  type CommunityTab,
  type RankingDimension,
} from './communityData'

/** 创作者头像底色：按 id 确定性取色（无外部图片依赖） */
const AVATAR_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#a142f4', '#12b5cb']
function avatarColor(id: string): string {
  let n = 0
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

function creatorName(snapshot: CommunitySnapshot, id: string): string {
  return snapshot.creators.find((c) => c.id === id)?.name ?? '未知创作者'
}

export function CommunityPanel() {
  const tab = useWorkspaceStore((s) => s.communityTab)
  const setTab = useWorkspaceStore((s) => s.setCommunityTab)
  const following = useWorkspaceStore((s) => s.communityFollowing)
  const toggleFollow = useWorkspaceStore((s) => s.toggleCommunityFollow)

  const [snapshot, setSnapshot] = useState<CommunitySnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [featuredOffset, setFeaturedOffset] = useState(0)
  const [dimension, setDimension] = useState<RankingDimension>('downloads')
  const [detail, setDetail] = useState<CommunityMod | null>(null)

  // 挂载守卫：卸载后不再写状态（挂载效果与手动刷新共用）
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  // 挂载拉取：状态只在 Promise 回调里写（StrictMode 双挂载由 alive 守卫兜底）
  useEffect(() => {
    let alive = true
    communityDataSource
      .getSnapshot()
      .then((s) => { if (alive) setSnapshot(s) })
      .catch((err: unknown) => { if (alive) setLoadError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])
  // 手动刷新（工具栏按钮）：先置 loading 与清错误，再重新拉取
  const reload = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    void communityDataSource
      .getSnapshot()
      .then((s) => { if (mountedRef.current) setSnapshot(s) })
      .catch((err: unknown) => { if (mountedRef.current) setLoadError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (mountedRef.current) setLoading(false) })
  }, [])

  const followingSet = useMemo(() => new Set(following), [following])
  const openDetail = useCallback((m: CommunityMod) => setDetail(m), [])

  return (
    <section className="community-panel panel">
      <div className="panel-header">
        <AppIcon name="share" size={13} />
        社区
        <span className="badge info" title="未接入社区服务器，展示内置示例数据">本地示例</span>
        <span className="grow" />
        <button className="icon-btn" title="刷新社区数据" aria-label="刷新社区数据" onClick={reload}>
          <AppIcon name="refresh" size={13} />
        </button>
      </div>
      <div
        className="community-tabs"
        role="tablist"
        aria-label="社区页签"
        onKeyDown={(e) => {
          // 与编辑器标签栏一致的 ARIA tabs 键盘模式：←/→ 在页签间移动（循环）
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          const keys = Object.keys(TAB_LABELS) as CommunityTab[]
          const idx = keys.indexOf(tab)
          if (idx < 0) return
          e.preventDefault()
          const dir = e.key === 'ArrowRight' ? 1 : -1
          const next = keys[(idx + dir + keys.length) % keys.length]
          setTab(next)
          // 焦点跟随到新页签（roving tabindex：避免焦点停在被移出 tab 序的旧按钮上）
          document.getElementById(`community-tab-${next}`)?.focus()
        }}
      >
        {(Object.keys(TAB_LABELS) as CommunityTab[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`community-tab-${key}`}
            aria-selected={tab === key}
            aria-controls="community-tabpanel"
            tabIndex={tab === key ? 0 : -1}
            className={`community-tab${tab === key ? ' active' : ''}`}
            onClick={() => setTab(key)}
          >
            {TAB_LABELS[key]}
            {key === 'following' && following.length > 0 && <span className="count">{following.length}</span>}
          </button>
        ))}
      </div>

      {/* tabpanel 常驻渲染（加载/错误态也在其内）：aria-controls 始终有效，
          键盘用户可聚焦后滚动内容区 */}
      <div className="community-body" role="tabpanel" id="community-tabpanel" aria-label="社区内容" tabIndex={0}>
        {loading ? (
          <PanelState kind="loading" title="加载社区数据…" />
        ) : loadError ? (
          <PanelState kind="error" title="社区数据加载失败" description={loadError} onRetry={reload} />
        ) : snapshot ? (
          <>
            {tab === 'recommend' && (
              <RecommendTab
                snapshot={snapshot}
                featuredOffset={featuredOffset}
                onRotate={() => setFeaturedOffset((o) => o + 1)}
                followingSet={followingSet}
                onToggleFollow={toggleFollow}
                onOpenDetail={openDetail}
              />
            )}
            {tab === 'following' && (
              <FollowingTab
                snapshot={snapshot}
                following={following}
                onGoRecommend={() => setTab('recommend')}
                onOpenDetail={openDetail}
              />
            )}
            {tab === 'ranking' && (
              <RankingTab
                snapshot={snapshot}
                dimension={dimension}
                onDimension={setDimension}
                onOpenDetail={openDetail}
              />
            )}
            {tab === 'me' && (
              <MeTab
                snapshot={snapshot}
                following={following}
                followingSet={followingSet}
                onToggleFollow={toggleFollow}
                onOpenDetail={openDetail}
              />
            )}
          </>
        ) : null}
      </div>

      {detail && snapshot && (
        <ModDetailModal
          mod={detail}
          snapshot={snapshot}
          isFollowing={followingSet.has(detail.authorId)}
          onToggleFollow={() => toggleFollow(detail.authorId)}
          onClose={() => setDetail(null)}
        />
      )}
    </section>
  )
}

/* ── 推荐：精选轮换 + 推荐创作者 + 最新发布 ────────────── */

function RecommendTab({
  snapshot,
  featuredOffset,
  onRotate,
  followingSet,
  onToggleFollow,
  onOpenDetail,
}: {
  snapshot: CommunitySnapshot
  featuredOffset: number
  onRotate: () => void
  followingSet: Set<string>
  onToggleFollow: (creatorId: string) => void
  onOpenDetail: (mod: CommunityMod) => void
}) {
  const featured = rotateFeatured(snapshot.mods, featuredOffset, 4)
  const creators = snapshot.creators.filter((c) => c.featured)
  const latest = sortModsByRanking(snapshot.mods, 'updated').slice(0, 8)

  return (
    <>
      <div className="community-section">
        <div className="community-section-title">
          精选
          <span className="grow" />
          <button type="button" className="btn-sm" onClick={onRotate} title="换一批精选模组">换一批</button>
        </div>
        <div className="featured-scroll">
          {featured.map((m) => (
            <ModCard key={m.id} mod={m} creatorName={creatorName(snapshot, m.authorId)} onOpenDetail={() => onOpenDetail(m)} />
          ))}
        </div>
      </div>

      <div className="community-section">
        <div className="community-section-title">推荐创作者</div>
        <div className="creator-grid">
          {creators.map((c) => (
            <CreatorCard key={c.id} creator={c} isFollowing={followingSet.has(c.id)} onToggle={() => onToggleFollow(c.id)} />
          ))}
        </div>
      </div>

      <div className="community-section">
        <div className="community-section-title">最新发布</div>
        <div className="mod-grid">
          {latest.map((m) => (
            <ModCard key={m.id} mod={m} creatorName={creatorName(snapshot, m.authorId)} onOpenDetail={() => onOpenDetail(m)} />
          ))}
        </div>
      </div>
    </>
  )
}

/* ── 关注：已关注创作者的动态流 ───────────────────────── */

function FollowingTab({
  snapshot,
  following,
  onGoRecommend,
  onOpenDetail,
}: {
  snapshot: CommunitySnapshot
  following: string[]
  onGoRecommend: () => void
  onOpenDetail: (mod: CommunityMod) => void
}) {
  const activities = filterActivitiesByFollowing(snapshot.activities, following)

  if (activities.length === 0) {
    return (
      <PanelState
        kind="empty"
        icon="search"
        title="还没有关注动态"
        description={
          following.length === 0
            ? '在「推荐」页关注喜欢的创作者，他们的发布与更新会汇总到这里'
            : '关注的创作者暂时没有新动态'
        }
        action={
          <button type="button" className="btn" onClick={onGoRecommend}>
            去推荐页找创作者
          </button>
        }
      />
    )
  }
  return (
    <div className="community-section">
      <div className="community-section-title">已关注动态（{activities.length}）</div>
      <div className="activity-list">
        {activities.map((a) => (
          <ActivityItem
            key={a.id}
            activity={a}
            creatorName={creatorName(snapshot, a.creatorId)}
            onOpenDetail={() => {
              // 动态引用的模组在数据里找不到时静默跳过（不打开失效详情）
              const mod = snapshot.mods.find((m) => m.id === a.modId)
              if (mod) onOpenDetail(mod)
            }}
          />
        ))}
      </div>
    </div>
  )
}

/* ── 排行：维度切换 + 名次列表 ────────────────────────── */

function RankingTab({
  snapshot,
  dimension,
  onDimension,
  onOpenDetail,
}: {
  snapshot: CommunitySnapshot
  dimension: RankingDimension
  onDimension: (d: RankingDimension) => void
  onOpenDetail: (mod: CommunityMod) => void
}) {
  const ranked = sortModsByRanking(snapshot.mods, dimension)
  return (
    <>
      <div className="community-section">
        <div className="community-section-title">排行维度</div>
        <div className="rank-filter">
          {(Object.keys(RANKING_DIMENSION_LABELS) as RankingDimension[]).map((d) => (
            <button
              key={d}
              type="button"
              className={`rank-chip${dimension === d ? ' active' : ''}`}
              aria-pressed={dimension === d}
              onClick={() => onDimension(d)}
            >
              {RANKING_DIMENSION_LABELS[d]}
            </button>
          ))}
        </div>
      </div>
      <div className="community-section">
        <div className="rank-list">
          {ranked.map((m, i) => (
            <RankRow key={m.id} mod={m} rank={i + 1} creatorName={creatorName(snapshot, m.authorId)} onOpenDetail={() => onOpenDetail(m)} />
          ))}
        </div>
      </div>
    </>
  )
}

/* ── 我的：本地预览身份 + 统计 + 关注 + 收藏 ───────────── */

function MeTab({
  snapshot,
  following,
  followingSet,
  onToggleFollow,
  onOpenDetail,
}: {
  snapshot: CommunitySnapshot
  following: string[]
  followingSet: Set<string>
  onToggleFollow: (creatorId: string) => void
  onOpenDetail: (mod: CommunityMod) => void
}) {
  const stats = profileStats(snapshot, following)
  const followedCreators = snapshot.creators.filter((c) => followingSet.has(c.id))
  const favoriteMods = snapshot.mods.filter((m) => snapshot.profile.favoriteModIds.includes(m.id))

  return (
    <>
      <div className="community-card me-profile">
        <span className="creator-avatar me-avatar" style={{ background: avatarColor('me') }} aria-hidden="true">
          {snapshot.profile.name.slice(0, 1)}
        </span>
        <div className="creator-info">
          <div className="creator-name">{snapshot.profile.name}</div>
          <div className="creator-tagline">{snapshot.profile.tagline}</div>
        </div>
        <span className="badge info">本地示例</span>
      </div>

      <div className="me-stats">
        <div className="me-stat"><div className="me-stat-value">{stats.published}</div><div className="me-stat-label">发布</div></div>
        <div className="me-stat"><div className="me-stat-value">{stats.followers}</div><div className="me-stat-label">粉丝</div></div>
        <div className="me-stat"><div className="me-stat-value">{stats.likesReceived}</div><div className="me-stat-label">获赞</div></div>
        <div className="me-stat"><div className="me-stat-value">{stats.followingCount}</div><div className="me-stat-label">关注</div></div>
        <div className="me-stat"><div className="me-stat-value">{stats.favoritesCount}</div><div className="me-stat-label">收藏</div></div>
      </div>

      <div className="local-note">
        当前为<strong>本地示例数据</strong>：尚未接入社区账号系统，发布 / 粉丝 / 获赞均为 0。
        登录、在线发布、模组分享与下载将在社区服务器上线后接入（见设置 →「计划中」）。
      </div>
      <div className="disabled-row">
        <span title="登录社区账号等待服务器上线">
          <button type="button" className="btn" disabled>登录社区账号</button>
        </span>
        <span title="在线发布模组等待服务器上线">
          <button type="button" className="btn" disabled>发布模组</button>
        </span>
      </div>

      <div className="community-section">
        <div className="community-section-title">我关注的创作者（{followedCreators.length}）</div>
        {followedCreators.length === 0 ? (
          <div className="local-note">还没有关注创作者。去「推荐」页点「关注」试试。</div>
        ) : (
          <div className="creator-grid">
            {followedCreators.map((c) => (
              <CreatorCard key={c.id} creator={c} isFollowing onToggle={() => onToggleFollow(c.id)} />
            ))}
          </div>
        )}
      </div>

      <div className="community-section">
        <div className="community-section-title">我的收藏（本地）</div>
        {favoriteMods.length === 0 ? (
          <div className="local-note">暂无收藏。</div>
        ) : (
          <div className="mod-grid">
            {favoriteMods.map((m) => (
              <ModCard key={m.id} mod={m} creatorName={creatorName(snapshot, m.authorId)} onOpenDetail={() => onOpenDetail(m)} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ── 详情弹窗：本地浏览；在线动作禁用 ──────────────────── */

function ModDetailModal({
  mod,
  snapshot,
  isFollowing,
  onToggleFollow,
  onClose,
}: {
  mod: CommunityMod
  snapshot: CommunitySnapshot
  isFollowing: boolean
  onToggleFollow: () => void
  onClose: () => void
}) {
  const author = snapshot.creators.find((c) => c.id === mod.authorId)
  return (
    <Modal
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AppIcon name="box" size={15} />
          {mod.name}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <span title="在线下载 .rwmod 等待社区服务器上线">
            <button type="button" className="btn" disabled>下载 .rwmod</button>
          </span>
          <button type="button" className="btn" onClick={onToggleFollow}>
            {isFollowing ? '已关注（点击取关）' : '关注作者'}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>关闭</button>
        </>
      }
    >
      <div className="community-detail-body">
        <div className="mod-tags">{mod.tags.map((t) => <span key={t} className="badge">{t}</span>)}</div>
        <p className="community-detail-desc">{mod.description}</p>
        <div className="detail-meta">
          作者：{author?.name ?? '未知创作者'} · 版本 {mod.version} · 更新于 {formatRelativeTime(mod.updatedAt)}
        </div>
        <div className="me-stats">
          <div className="me-stat"><div className="me-stat-value">{formatCount(mod.downloads)}</div><div className="me-stat-label">下载</div></div>
          <div className="me-stat"><div className="me-stat-value">{formatCount(mod.favorites)}</div><div className="me-stat-label">收藏</div></div>
          <div className="me-stat"><div className="me-stat-value">{mod.unitCount}</div><div className="me-stat-label">单位</div></div>
        </div>
        <div className="local-note">在线下载、安装与评论等待社区服务器上线后接入；当前仅本地浏览示例数据。</div>
      </div>
    </Modal>
  )
}

/* ── 共享卡片 ─────────────────────────────────────────── */

function ModCard({ mod, creatorName, onOpenDetail }: { mod: CommunityMod; creatorName: string; onOpenDetail: () => void }) {
  return (
    <div className="community-card mod-card">
      <div className="mod-card-title">
        <span className="mod-name" title={mod.name}>{mod.name}</span>
        <span className="mod-version">{mod.version}</span>
      </div>
      <div className="mod-desc">{mod.description}</div>
      <div className="mod-tags">{mod.tags.map((t) => <span key={t} className="badge">{t}</span>)}</div>
      <div className="mod-stats">
        <span className="mod-stat" title="下载量"><AppIcon name="download" size={11} />{formatCount(mod.downloads)}</span>
        <span className="mod-stat" title="收藏数"><AppIcon name="star" size={11} />{formatCount(mod.favorites)}</span>
        <span className="mod-stat" title="单位数"><AppIcon name="tower" size={11} />{mod.unitCount}</span>
        <span className="mod-stat" title="最近更新"><AppIcon name="clock" size={11} />{formatRelativeTime(mod.updatedAt)}</span>
      </div>
      <div className="mod-card-foot">
        <span className="mod-author" title={creatorName}>{creatorName}</span>
        <span className="grow" />
        <button type="button" className="btn-sm" onClick={onOpenDetail}>详情</button>
        <span title="在线下载等待社区服务器上线">
          <button type="button" className="btn-sm" disabled>下载</button>
        </span>
      </div>
    </div>
  )
}

function CreatorCard({ creator, isFollowing, onToggle }: { creator: CommunityCreator; isFollowing: boolean; onToggle: () => void }) {
  return (
    <div className="community-card creator-card">
      <span className="creator-avatar" style={{ background: avatarColor(creator.id) }} aria-hidden="true">
        {creator.name.slice(0, 1)}
      </span>
      <div className="creator-info">
        <div className="creator-name">
          {creator.name}
          {creator.featured && <AppIcon name="star" size={11} className="creator-star" />}
        </div>
        <div className="creator-tagline">{creator.tagline}</div>
        <div className="creator-meta">
          {formatCount(creator.followers)} 粉丝 · 发布 {creator.published} · 获赞 {formatCount(creator.likesReceived)}
        </div>
      </div>
      <button type="button" className={`btn-sm follow-btn${isFollowing ? ' following' : ''}`} aria-pressed={isFollowing} onClick={onToggle}>
        {isFollowing ? '已关注' : '关注'}
      </button>
    </div>
  )
}

function ActivityItem({
  activity,
  creatorName,
  onOpenDetail,
}: {
  activity: CommunityActivity
  creatorName: string
  onOpenDetail: () => void
}) {
  return (
    <div className="activity-item">
      <span className="activity-icon" aria-hidden="true">
        <AppIcon name={activity.kind === 'mod_publish' ? 'upload' : 'refresh'} size={13} />
      </span>
      <div className="activity-main">
        <span className="activity-creator">{creatorName}</span>
        <span className="activity-text">{activity.text}</span>
        <button type="button" className="btn-sm" onClick={onOpenDetail}>查看模组</button>
      </div>
      <span className="activity-meta">{formatRelativeTime(activity.at)} · {formatCount(activity.likes)} 赞</span>
    </div>
  )
}

function RankRow({ mod, rank, creatorName, onOpenDetail }: { mod: CommunityMod; rank: number; creatorName: string; onOpenDetail: () => void }) {
  return (
    <div className="rank-item" aria-label={`第 ${rank} 名：${mod.name}`}>
      <span className={`rank-no${rank <= 3 ? ' top' : ''}`} aria-hidden="true">{rank}</span>
      <div className="rank-info">
        <div className="rank-name">
          {mod.name}
          <span className="mod-version">{mod.version}</span>
        </div>
        <div className="rank-meta">{creatorName} · {formatCount(mod.downloads)} 下载 · {mod.unitCount} 单位</div>
      </div>
      <span className="grow" />
      <button type="button" className="btn-sm" onClick={onOpenDetail}>详情</button>
    </div>
  )
}
