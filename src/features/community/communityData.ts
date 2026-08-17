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

/** 社区页签（与 RustAssistant-master 的 CommunityFragment 四页签结构对应） */
export type CommunityTab = 'recommend' | 'following' | 'ranking' | 'me'

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
}

export const RANKING_DIMENSION_LABELS: Record<RankingDimension, string> = {
  downloads: '下载量',
  favorites: '热度收藏',
  units: '单位数',
  updated: '最近更新',
}

/* ── 本地示例数据（确定性：固定时间基座 + 固定偏移，两次拉取结果完全一致） ── */

const T0 = Date.UTC(2026, 7, 16) // 2026-08-16 00:00 UTC
const DAY = 86_400_000

const CREATORS: CommunityCreator[] = [
  { id: 'c1', name: '战场工坊', tagline: '专注单位平衡与数值细节', followers: 12800, published: 32, likesReceived: 46000, featured: true },
  { id: 'c2', name: '星河模组组', tagline: '太空题材单位合集', followers: 9200, published: 21, likesReceived: 31000, featured: true },
  { id: 'c3', name: '老猫的仓库', tagline: '像素画风小单位与道具', followers: 5600, published: 15, likesReceived: 12000 },
  { id: 'c4', name: '钢铁防线', tagline: '防守图配套建筑与单位', followers: 4100, published: 9, likesReceived: 9800, featured: true },
  { id: 'c5', name: '东方工厂', tagline: '东方风格步兵与建筑', followers: 3300, published: 12, likesReceived: 7600 },
  { id: 'c6', name: '蓝湾实验室', tagline: '实验性机制与技能单位', followers: 2100, published: 7, likesReceived: 5400 },
]

const MODS: CommunityMod[] = [
  { id: 'm1', name: '铁幕重坦', description: '重型主力坦克，高血量高造价，适合正面推进；含 6 个变体与两级升级。', authorId: 'c1', version: '1.4.0', tags: ['陆军', '坦克', '重型'], downloads: 152340, favorites: 8930, unitCount: 6, updatedAt: T0 - 2 * DAY, featured: true },
  { id: 'm2', name: '侦察无人机', description: '低成本空中侦察单位，视野开阔，加入自动回航逻辑。', authorId: 'c1', version: '1.1.0', tags: ['空军', '侦察'], downloads: 76300, favorites: 4120, unitCount: 3, updatedAt: T0 - 9 * DAY },
  { id: 'm3', name: '轨道突击队', description: '太空题材步兵小队，空投落地后进入战斗状态。', authorId: 'c2', version: '0.9.0', tags: ['步兵', '太空'], downloads: 45800, favorites: 2330, unitCount: 4, updatedAt: T0 - 15 * DAY },
  { id: 'm4', name: '星舰护卫舰', description: '多功能太空护卫舰：对空对地两用，2.0 版重做武器组。', authorId: 'c2', version: '2.0.0', tags: ['海军', '太空', '舰船'], downloads: 129800, favorites: 7640, unitCount: 5, updatedAt: T0 - 1 * DAY, featured: true },
  { id: 'm5', name: '像素补给箱', description: '可破坏的随机资源补给箱，掉落金币或维修包。', authorId: 'c3', version: '1.0.0', tags: ['道具', '建筑'], downloads: 32100, favorites: 1980, unitCount: 2, updatedAt: T0 - 6 * DAY },
  { id: 'm6', name: '短尾猫侦察车', description: '高机动轮式侦察车，隐蔽开视野，售价低廉。', authorId: 'c3', version: '0.8.0', tags: ['陆军', '侦察'], downloads: 27600, favorites: 1410, unitCount: 1, updatedAt: T0 - 20 * DAY },
  { id: 'm7', name: '钢铁防线·城墙套件', description: '防守图城墙体系：四向连接、城门与箭塔一体。', authorId: 'c4', version: '1.6.0', tags: ['建筑', '防守'], downloads: 98400, favorites: 5210, unitCount: 8, updatedAt: T0 - 3 * DAY, featured: true },
  { id: 'm8', name: '磁暴塔', description: '范围电弧防御塔，对密集步兵群效果拔群。', authorId: 'c4', version: '1.2.0', tags: ['建筑', '防御塔'], downloads: 51200, favorites: 3100, unitCount: 1, updatedAt: T0 - 12 * DAY },
  { id: 'm9', name: '东方武士', description: '近战步兵单位，冲刺技能可突进到目标背后。', authorId: 'c5', version: '1.3.0', tags: ['步兵', '近战'], downloads: 38800, favorites: 2260, unitCount: 2, updatedAt: T0 - 7 * DAY },
  { id: 'm10', name: '樱花炮塔', description: '春季限定配色的快速炮塔，攻速高、射程短。', authorId: 'c5', version: '1.0.0', tags: ['建筑', '防御塔'], downloads: 66100, favorites: 3740, unitCount: 1, updatedAt: T0 - 4 * DAY, featured: true },
  { id: 'm11', name: '量子传送门', description: '实验性传送建筑：可把单位传送到另一座传送门。', authorId: 'c6', version: '0.7.0', tags: ['建筑', '实验'], downloads: 21700, favorites: 1650, unitCount: 3, updatedAt: T0 - 18 * DAY },
  { id: 'm12', name: '相位隐身发生器', description: '大范围友军隐身光环，被攻击时短暂失效。', authorId: 'c6', version: '0.6.0', tags: ['实验', '技能'], downloads: 18900, favorites: 1290, unitCount: 2, updatedAt: T0 - 25 * DAY },
]

const ACTIVITIES: CommunityActivity[] = [
  { id: 'a1', creatorId: 'c1', kind: 'mod_publish', modId: 'm1', text: '发布了新单位包：铁幕重坦系列', at: T0 - 2 * DAY, likes: 432 },
  { id: 'a2', creatorId: 'c2', kind: 'mod_publish', modId: 'm4', text: '星舰护卫舰 v2.0 正式发布', at: T0 - 1 * DAY, likes: 618 },
  { id: 'a3', creatorId: 'c3', kind: 'mod_update', modId: 'm5', text: '补给箱：新增两种随机资源', at: T0 - 6 * DAY, likes: 121 },
  { id: 'a4', creatorId: 'c4', kind: 'mod_update', modId: 'm7', text: '城墙套件更新：支持四向连接', at: T0 - 3 * DAY, likes: 254 },
  { id: 'a5', creatorId: 'c1', kind: 'mod_update', modId: 'm2', text: '侦察无人机加入自动回航逻辑', at: T0 - 9 * DAY, likes: 88 },
  { id: 'a6', creatorId: 'c5', kind: 'mod_publish', modId: 'm10', text: '樱花炮塔：春季限定配色上线', at: T0 - 4 * DAY, likes: 176 },
  { id: 'a7', creatorId: 'c6', kind: 'mod_update', modId: 'm12', text: '相位隐身发生器修复冷却显示', at: T0 - 25 * DAY, likes: 34 },
  { id: 'a8', creatorId: 'c2', kind: 'mod_update', modId: 'm3', text: '轨道突击队平衡性调整', at: T0 - 15 * DAY, likes: 97 },
]

const LOCAL_SNAPSHOT: CommunitySnapshot = {
  mods: MODS,
  creators: CREATORS,
  activities: ACTIVITIES,
  profile: {
    name: '本地创作者',
    tagline: '尚未接入社区账号；以下统计均为本地示例数据',
    published: 0,
    followers: 0,
    likesReceived: 0,
    favoriteModIds: ['m1', 'm4', 'm7'],
  },
}

/**
 * 本地数据源：每次返回全新深拷贝，调用方随意派生/排序不会污染共享数据；
 * 两次调用结果完全一致（确定性，测试与刷新行为可预期）。
 */
export const localCommunityDataSource: CommunityDataSource = {
  async getSnapshot(): Promise<CommunitySnapshot> {
    return structuredClone(LOCAL_SNAPSHOT)
  },
}

/** 应用实际使用的数据源（服务器上线后替换此导出即可，UI 零改动） */
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

function trimOne(x: number): string {
  return x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10)
}
