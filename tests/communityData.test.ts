/**
 * 社区数据层测试（M33-社区）：
 * - 本地数据源：快照结构完整、两次拉取确定一致、返回深拷贝（派生不污染共享数据）
 * - 排行排序各维度、关注流筛选、精选轮换、个人统计、数量格式化
 * 全部是纯函数/契约测试，不依赖 Electron 或网络。
 */
import { describe, expect, it } from 'vitest'
import {
  communityDataSource,
  filterActivitiesByFollowing,
  formatCount,
  localCommunityDataSource,
  profileStats,
  rotateFeatured,
  sortModsByRanking,
  TAB_LABELS,
  RANKING_DIMENSION_LABELS,
  type CommunityActivity,
  type CommunityMod,
} from '../src/features/community/communityData'

describe('localCommunityDataSource（本地快照契约）', () => {
  it('快照各集合非空且字段完整', async () => {
    const snap = await localCommunityDataSource.getSnapshot()
    expect(snap.mods.length).toBeGreaterThanOrEqual(10)
    expect(snap.creators.length).toBeGreaterThanOrEqual(5)
    expect(snap.activities.length).toBeGreaterThanOrEqual(5)
    for (const m of snap.mods) {
      expect(typeof m.id).toBe('string')
      expect(typeof m.name).toBe('string')
      expect(typeof m.authorId).toBe('string')
      expect(m.downloads).toBeGreaterThanOrEqual(0)
      expect(m.favorites).toBeGreaterThanOrEqual(0)
      expect(m.unitCount).toBeGreaterThanOrEqual(1)
    }
    for (const c of snap.creators) expect(typeof c.name).toBe('string')
    // 收藏与动态都引用存在的模组/创作者
    for (const id of snap.profile.favoriteModIds) {
      expect(snap.mods.some((m) => m.id === id)).toBe(true)
    }
    for (const a of snap.activities) {
      expect(snap.creators.some((c) => c.id === a.creatorId)).toBe(true)
      expect(snap.mods.some((m) => m.id === a.modId)).toBe(true)
    }
  })

  it('两次拉取结果完全一致（确定性）', async () => {
    const a = await localCommunityDataSource.getSnapshot()
    const b = await localCommunityDataSource.getSnapshot()
    expect(a).toEqual(b)
  })

  it('返回深拷贝：调用方排序/修改不污染共享数据', async () => {
    const a = await localCommunityDataSource.getSnapshot()
    const b = await localCommunityDataSource.getSnapshot()
    sortModsByRanking(a.mods, 'units')
    a.mods[0].name = '被修改'
    expect(b.mods[0].name).not.toBe('被修改')
    expect((await communityDataSource.getSnapshot()).mods[0].name).not.toBe('被修改')
  })
})

describe('sortModsByRanking（排行各维度）', () => {
  const mods: CommunityMod[] = [
    { id: 'a', name: 'a', description: '', authorId: 'c', version: '1', tags: [], downloads: 100, favorites: 5, unitCount: 2, updatedAt: 10 },
    { id: 'b', name: 'b', description: '', authorId: 'c', version: '1', tags: [], downloads: 300, favorites: 9, unitCount: 1, updatedAt: 30 },
    { id: 'c', name: 'c', description: '', authorId: 'c', version: '1', tags: [], downloads: 200, favorites: 9, unitCount: 3, updatedAt: 20 },
  ]

  it('下载量降序', () => {
    expect(sortModsByRanking(mods, 'downloads').map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })
  it('单位数降序', () => {
    expect(sortModsByRanking(mods, 'units').map((m) => m.id)).toEqual(['c', 'a', 'b'])
  })
  it('最近更新降序', () => {
    expect(sortModsByRanking(mods, 'updated').map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })
  it('热度收藏降序，同值保持原顺序（稳定）', () => {
    expect(sortModsByRanking(mods, 'favorites').map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })
  it('空数组返回空；原数组不被修改', () => {
    expect(sortModsByRanking([], 'downloads')).toEqual([])
    const copy = [...mods]
    sortModsByRanking(mods, 'downloads')
    expect(mods).toEqual(copy)
  })
})

describe('filterActivitiesByFollowing（关注流）', () => {
  const acts: CommunityActivity[] = [
    { id: 'a1', creatorId: 'c1', kind: 'mod_publish', modId: 'm1', text: 'x', at: 1, likes: 1 },
    { id: 'a2', creatorId: 'c2', kind: 'mod_update', modId: 'm2', text: 'y', at: 2, likes: 2 },
    { id: 'a3', creatorId: 'c1', kind: 'mod_update', modId: 'm3', text: 'z', at: 3, likes: 3 },
  ]

  it('只保留已关注创作者的动态', () => {
    expect(filterActivitiesByFollowing(acts, ['c1']).map((a) => a.id)).toEqual(['a1', 'a3'])
  })
  it('关注多个创作者取并集', () => {
    expect(filterActivitiesByFollowing(acts, ['c1', 'c2']).map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })
  it('无关注/无动态返回空数组', () => {
    expect(filterActivitiesByFollowing(acts, [])).toEqual([])
    expect(filterActivitiesByFollowing([], ['c1'])).toEqual([])
  })
})

describe('rotateFeatured（精选轮换）', () => {
  const mods: CommunityMod[] = [
    { id: 'f1', name: 'f1', description: '', authorId: 'c', version: '1', tags: [], downloads: 1, favorites: 1, unitCount: 1, updatedAt: 1, featured: true },
    { id: 'f2', name: 'f2', description: '', authorId: 'c', version: '1', tags: [], downloads: 1, favorites: 1, unitCount: 1, updatedAt: 1, featured: true },
    { id: 'f3', name: 'f3', description: '', authorId: 'c', version: '1', tags: [], downloads: 1, favorites: 1, unitCount: 1, updatedAt: 1, featured: true },
    { id: 'n1', name: 'n1', description: '', authorId: 'c', version: '1', tags: [], downloads: 1, favorites: 1, unitCount: 1, updatedAt: 1 },
  ]

  it('只从精选池轮换，偏移按池大小取模', () => {
    expect(rotateFeatured(mods, 0, 2).map((m) => m.id)).toEqual(['f1', 'f2'])
    expect(rotateFeatured(mods, 1, 2).map((m) => m.id)).toEqual(['f2', 'f3'])
    expect(rotateFeatured(mods, 3, 2).map((m) => m.id)).toEqual(['f1', 'f2'])
  })
  it('数量超过池大小则全部返回', () => {
    expect(rotateFeatured(mods, 0, 99).map((m) => m.id)).toEqual(['f1', 'f2', 'f3'])
  })
  it('无精选时回退全部模组；空数组返回空', () => {
    const noFeatured = mods.map((m) => ({ ...m, featured: false }))
    expect(rotateFeatured(noFeatured, 0, 2).map((m) => m.id)).toEqual(['f1', 'f2'])
    expect(rotateFeatured(noFeatured, 3, 2).map((m) => m.id)).toEqual(['n1', 'f1'])
    expect(rotateFeatured([], 0, 3)).toEqual([])
  })
  it('负偏移不崩溃', () => {
    expect(rotateFeatured(mods, -1, 2).map((m) => m.id)).toEqual(['f3', 'f1'])
  })
})

describe('profileStats（我的统计）', () => {
  it('账号统计来自快照，关注/收藏来自当前会话', async () => {
    const snap = await localCommunityDataSource.getSnapshot()
    const stats = profileStats(snap, ['c1', 'c2'])
    expect(stats.published).toBe(snap.profile.published)
    expect(stats.followers).toBe(snap.profile.followers)
    expect(stats.followingCount).toBe(2)
    expect(stats.favoritesCount).toBe(snap.profile.favoriteModIds.length)
  })
})

describe('formatCount（数量格式化）', () => {
  it('小于 1 万原样显示', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(999)).toBe('999')
    expect(formatCount(9999)).toBe('9999')
  })
  it('≥1 万显示 x.x万', () => {
    expect(formatCount(12345)).toBe('1.2万')
    expect(formatCount(120000)).toBe('12万')
    expect(formatCount(10000)).toBe('1万')
  })
  it('≥1 亿显示 x.x亿；负数/非法回退 0', () => {
    expect(formatCount(123_456_789)).toBe('1.2亿')
    expect(formatCount(-5)).toBe('0')
    expect(formatCount(Number.NaN)).toBe('0')
  })
})

describe('标签常量', () => {
  it('四个页签与排行维度文案齐全', () => {
    expect(Object.keys(TAB_LABELS).sort()).toEqual(['following', 'me', 'ranking', 'recommend'])
    expect(Object.keys(RANKING_DIMENSION_LABELS).sort()).toEqual(['downloads', 'favorites', 'units', 'updated'])
  })
})
