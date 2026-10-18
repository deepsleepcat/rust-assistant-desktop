/**
 * 社区板块数据契约（M33-社区 第一阶段：本地示例数据）。
 *
 * 参考 RustAssistant-master 的社区产品结构（推荐 / 关注 / 排行 / 我的 四个页签），
 * 但**不依赖任何线上后端**：当前仓库没有社区服务器，示例数据全部内置于本文件，
 * 不伪造账号、在线下载或发布能力。
 *
 * 未来社区服务器上线时，只需新增一个实现 `CommunityDataSource` 的服务端适配器并替换
 * 底部的 `communityDataSource` 导出（排序/筛选/统计等纯逻辑在 UI 之外，可原样复用）。
 */

import type { CommunityPost, PostFeed } from '../../services/communityApi'

/** 社区页签（与 RustAssistant-master 的 CommunityFragment 四页签结构对应；cloudBag 为云书包第五页签） */
export type CommunityTab = 'recommend' | 'following' | 'ranking' | 'me' | 'cloudBag'

/** 排行维度：下载量 / 热度收藏 / 单位数 / 最近更新 */
export type RankingDimension = 'downloads' | 'favorites' | 'units' | 'updated'

/** 社区模组卡片（列表与详情共用；字段对齐服务器上线后的最小契约） */
export interface CommunityMod {
  id: string
  name: string
  description: string
  /** 创作者 id（关联 CommunityCreator.id） */
  authorId: string
  version: string
  tags: string[]
  downloads: number
  favorites: number
  unitCount: number
  updatedAt: number
  /** 是否进入「推荐」精选位 */
  featured?: boolean
}

/** 社区创作者 */
export interface CommunityCreator {
  id: string
  name: string
  /** 一句话介绍 */
  tagline: string
  followers: number
  published: number
  likesReceived: number
  featured?: boolean
}

/** 动态类型：发布 / 更新 */
export type ActivityKind = 'mod_publish' | 'mod_update'

/** 关注流动态 */
export interface CommunityActivity {
  id: string
  creatorId: string
  kind: ActivityKind
  modId: string
  text: string
  at: number
  likes: number
}

/** 「我的」页签的本地预览身份（未接入账号系统，统计为本地真实值：0 发布 / 0 粉丝） */
export interface CommunityProfile {
  name: string
  tagline: string
  published: number
  followers: number
  likesReceived: number
  /** 本地收藏的模组 id 列表 */
  favoriteModIds: string[]
}

/** 社区完整快照（数据源一次拉取，UI 按页签派生视图） */
export interface CommunitySnapshot {
  mods: CommunityMod[]
  creators: CommunityCreator[]
  activities: CommunityActivity[]
  profile: CommunityProfile
}

/** 数据源契约：第一阶段只有本地实现；服务器上线后替换实现即可，UI 零改动 */
export interface CommunityDataSource {
  getSnapshot(): Promise<CommunitySnapshot>
}

export const TAB_LABELS: Record<CommunityTab, string> = {
  recommend: '推荐',
  following: '关注',
  ranking: '排行',
  me: '我的',
  cloudBag: '云仓库',
}

export const RANKING_DIMENSION_LABELS: Record<RankingDimension, string> = {
  downloads: '下载量',
  favorites: '热度收藏',
  units: '单位数',
  updated: '最近更新',
}

/** 没有真实离线缓存时只返回空态，每次返回独立对象。 */
export const localCommunityDataSource: CommunityDataSource = {
  async getSnapshot(): Promise<CommunitySnapshot> {
    return { mods: [], creators: [], activities: [], profile: { name: '', tagline: '离线状态，尚无社区缓存', published: 0, followers: 0, likesReceived: 0, favoriteModIds: [] } }
  },
}

export const communityDataSource: CommunityDataSource = localCommunityDataSource

/* ── 纯逻辑（可单测；UI 只消费结果，不做排序/筛选） ─────────── */

const RANK_SORTS: Record<RankingDimension, (a: CommunityMod, b: CommunityMod) => number> = {
  downloads: (a, b) => b.downloads - a.downloads,
  favorites: (a, b) => b.favorites - a.favorites,
  units: (a, b) => b.unitCount - a.unitCount,
  updated: (a, b) => b.updatedAt - a.updatedAt,
}

/** 排行排序：返回新数组（不动原数据）；同值保持原顺序（稳定排序） */
export function sortModsByRanking(mods: CommunityMod[], dimension: RankingDimension): CommunityMod[] {
  return [...mods].sort(RANK_SORTS[dimension])
}

/** 关注流筛选：只保留已关注创作者（id 集合）的动态；无关注返回空数组 */
export function filterActivitiesByFollowing(activities: CommunityActivity[], followingIds: string[]): CommunityActivity[] {
  const set = new Set(followingIds)
  return activities.filter((a) => set.has(a.creatorId))
}

/** 精选轮换：从精选池按偏移旋转取 count 个（「换一批」用）；无精选回退全部模组 */
export function rotateFeatured(mods: CommunityMod[], offset: number, count: number): CommunityMod[] {
  const pool = mods.filter((m) => m.featured)
  const source = pool.length > 0 ? pool : mods
  if (source.length === 0) return []
  const n = Math.max(1, count)
  const start = ((offset % source.length) + source.length) % source.length
  return Array.from({ length: Math.min(n, source.length) }, (_, i) => source[(start + i) % source.length])
}

export interface CommunityStats {
  published: number
  followers: number
  likesReceived: number
  followingCount: number
  favoritesCount: number
}

/** 「我的」页签统计：账号相关为本地真实值（未接入服务器），关注/收藏为当前会话状态 */
export function profileStats(snapshot: CommunitySnapshot, followingIds: string[]): CommunityStats {
  return {
    published: snapshot.profile.published,
    followers: snapshot.profile.followers,
    likesReceived: snapshot.profile.likesReceived,
    followingCount: followingIds.length,
    favoritesCount: snapshot.profile.favoriteModIds.length,
  }
}

/** 数量格式化：≥1 亿显示 x.x亿；≥1 万显示 x.x万；其余原样（非数字/负数回退 0） */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 100_000_000) return trimOne(n / 100_000_000) + '亿'
  if (n >= 10_000) return trimOne(n / 10_000) + '万'
  return String(Math.round(n))
}

export interface OfflinePostFilterOptions {
  feed?: PostFeed
  board?: string
  keyword?: string
  tag?: string
  page?: number
  pageSize?: number
}

/** 离线帖子回退：保持与服务端列表相同的筛选条件、排序和分页语义。 */
export function filterOfflinePosts(posts: CommunityPost[], options: OfflinePostFilterOptions = {}): { items: CommunityPost[]; total: number; page: number; page_size: number } {
  const page = Math.max(1, options.page ?? 1)
  const pageSize = Math.max(1, options.pageSize ?? 12)
  const keyword = options.keyword?.trim().toLocaleLowerCase() ?? ''
  const filtered = posts
    .filter((post) => !options.board || post.board === options.board)
    .filter((post) => !options.tag || (post.tags ?? []).includes(options.tag))
    .filter((post) => !keyword || `${post.title}\\n${post.body}\\n${post.author_name}`.toLocaleLowerCase().includes(keyword))
    .filter((post) => {
      if (!options.feed || options.feed === 'all') return true
      if (options.feed === 'featured') return post.featured === true
      if (options.feed === 'dynamic' || options.feed === 'question' || options.feed === 'article') return post.content_type === options.feed
      return true
    })
    .sort((a, b) => {
      if (options.feed === 'hot') return (b.like_count ?? 0) + (b.view_count ?? 0) / 10 + (b.comment_count ?? 0) * 2 - ((a.like_count ?? 0) + (a.view_count ?? 0) / 10 + (a.comment_count ?? 0) * 2)
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      if (a.featured !== b.featured) return a.featured ? -1 : 1
      return b.updated_at - a.updated_at || b.id - a.id
    })
  const start = (page - 1) * pageSize
  return { items: filtered.slice(start, start + pageSize), total: filtered.length, page, page_size: pageSize }
}

function trimOne(x: number): string {
  return x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)
}
