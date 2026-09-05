/**
 * 社区工作区状态测试（M33-社区）：
 * - 初始状态：编辑器工作区、推荐页签、空关注列表
 * - 工作区切换 / 页签切换 / 关注与取关
 * - 切回编辑器后原有标签与项目状态保留
 * - 关注列表为会话内状态：不写入持久化 workspace
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge, MOCK_PROJECT_ROOT } from '../src/services/mockBridge'

describe('社区工作区状态（M33）', () => {
  let store: ReturnType<typeof createWorkspaceStore>
  let bridge: ReturnType<typeof createMockBridge>

  beforeEach(() => {
    const mem = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) },
      clear: () => { mem.clear() },
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size },
    }
    bridge = createMockBridge()
    store = createWorkspaceStore(bridge)
  })

  it('初始状态：编辑器工作区 / 推荐页签 / 空关注', async () => {
    const s = store.getState()
    expect(s.activeSurface).toBe('editor')
    expect(s.communityTab).toBe('recommend')
    expect(s.communityFollowing).toEqual([])
    await s.init()
    expect(store.getState().activeSurface).toBe('editor')
  })

  it('工作区切换与页签切换', async () => {
    const s = store.getState()
    s.setActiveSurface('community')
    expect(store.getState().activeSurface).toBe('community')
    s.setCommunityTab('ranking')
    expect(store.getState().communityTab).toBe('ranking')
    s.setCommunityTab('me')
    s.setActiveSurface('editor')
    expect(store.getState().activeSurface).toBe('editor')
    // 页签状态保留（再次进入社区时停留在上次页签）
    expect(store.getState().communityTab).toBe('me')
  })

  it('关注/取消关注创作者（幂等切换）', async () => {
    const s = store.getState()
    s.toggleCommunityFollow('c1')
    expect(store.getState().communityFollowing).toEqual(['c1'])
    s.toggleCommunityFollow('c2')
    expect(store.getState().communityFollowing).toEqual(['c1', 'c2'])
    // 已关注再点 = 取关
    s.toggleCommunityFollow('c1')
    expect(store.getState().communityFollowing).toEqual(['c2'])
  })

  it('切回编辑器后原有标签与活动标签保留', async () => {
    await store.getState().init()
    await store.getState().openProject()
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\mod.json`)
    const tabId = store.getState().activeTabId!
    expect(store.getState().openTabs.length).toBe(1)

    store.getState().setActiveSurface('community')
    expect(store.getState().openTabs.length).toBe(1)
    store.getState().setActiveSurface('editor')
    expect(store.getState().activeTabId).toBe(tabId)
    expect(store.getState().openTabs[0].path).toBe(`${MOCK_PROJECT_ROOT}\\mod.json`)
  })

  it('从文件树打开文件会切回编辑器工作区', async () => {
    await store.getState().init()
    await store.getState().openProject()
    store.getState().setActiveSurface('community')
    await store.getState().openFile(`${MOCK_PROJECT_ROOT}\\units\\rifle.txt`)
    expect(store.getState().activeSurface).toBe('editor')
    expect(store.getState().activeTabId).not.toBeNull()
  })

  it('关注列表不写入持久化 workspace（会话内状态）', async () => {
    await store.getState().init()
    await store.getState().openProject()
    store.getState().toggleCommunityFollow('c1')
    // 等待 300ms 防抖持久化
    await new Promise((r) => setTimeout(r, 400))
    const saved = (await bridge.store.get('workspace')) as Record<string, unknown>
    expect(saved).not.toHaveProperty('communityFollowing')
    expect(saved).not.toHaveProperty('activeSurface')
    expect(saved).not.toHaveProperty('communityTab')
  })

  it('批准后自动轮询并登录，不需要再次点击检查状态', async () => {
    vi.useFakeTimers()
    try {
      const pollPairing = vi.fn(async () => ({ state: 'signed-in' as const, user: { id: 7, username: 'alice' } }))
      bridge = {
        ...bridge,
        auth: {
          status: async () => ({ state: 'signed-out' as const }),
          startPairing: async () => ({ state: 'pairing' as const, userCode: 'ABCD-1234', expiresAt: Date.now() + 60_000, pollAfterMs: 3_000 }),
          pollPairing,
          cancelPairing: async () => ({ state: 'signed-out' as const }),
          logout: async () => ({ state: 'signed-out' as const }),
        },
      }
      store = createWorkspaceStore(bridge)

      await store.getState().loginCommunity()
      expect(store.getState().communityAuth.status).toBe('loading')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(pollPairing).toHaveBeenCalledTimes(1)
      expect(store.getState().communityAuth).toMatchObject({ status: 'signed_in', user: { username: 'alice' }, pairing: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the main-process retry delay for the next automatic pairing check', async () => {
    vi.useFakeTimers()
    try {
      const pollPairing = vi
        .fn()
        .mockResolvedValueOnce({ state: 'pairing' as const, pollAfterMs: 6_000 })
        .mockResolvedValueOnce({ state: 'signed-in' as const, user: { id: 7, username: 'alice' } })
      bridge = {
        ...bridge,
        auth: {
          status: async () => ({ state: 'signed-out' as const }),
          startPairing: async () => ({ state: 'pairing' as const, userCode: 'ABCD-1234', expiresAt: Date.now() + 60_000, pollAfterMs: 3_000 }),
          pollPairing,
          cancelPairing: async () => ({ state: 'signed-out' as const }),
          logout: async () => ({ state: 'signed-out' as const }),
        },
      }
      store = createWorkspaceStore(bridge)

      await store.getState().loginCommunity()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(pollPairing).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_999)
      expect(pollPairing).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(pollPairing).toHaveBeenCalledTimes(2)
      expect(store.getState().communityAuth.status).toBe('signed_in')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancelling clears a scheduled automatic pairing check', async () => {
    vi.useFakeTimers()
    try {
      const pollPairing = vi.fn(async () => ({ state: 'signed-in' as const, user: { id: 7, username: 'alice' } }))
      bridge = {
        ...bridge,
        auth: {
          status: async () => ({ state: 'signed-out' as const }),
          startPairing: async () => ({ state: 'pairing' as const, userCode: 'ABCD-1234', expiresAt: Date.now() + 60_000, pollAfterMs: 3_000 }),
          pollPairing,
          cancelPairing: async () => ({ state: 'signed-out' as const }),
          logout: async () => ({ state: 'signed-out' as const }),
        },
      }
      store = createWorkspaceStore(bridge)

      await store.getState().loginCommunity()
      await store.getState().cancelCommunityPairing()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(pollPairing).not.toHaveBeenCalled()
      expect(store.getState().communityAuth.status).toBe('signed_out')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('离线使用（v0.3.7 用户需求）', () => {
  let store: ReturnType<typeof createWorkspaceStore>
  let bridge: ReturnType<typeof createMockBridge>
  let cancelPairing: () => Promise<{ state: 'signed-out' }>

  beforeEach(() => {
    const mem = new Map<string, string>()
    ;(globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) },
      clear: () => { mem.clear() },
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() { return mem.size },
    }
    bridge = createMockBridge()
    cancelPairing = vi.fn(async () => ({ state: 'signed-out' as const }))
    bridge = {
      ...bridge,
      auth: {
        status: async () => ({ state: 'signed-out' as const }),
        startPairing: async () => ({ state: 'pairing' as const, userCode: 'ABCD-1234', expiresAt: Date.now() + 60_000, pollAfterMs: 3_000 }),
        pollPairing: async () => ({ state: 'pairing' as const, pollAfterMs: 3_000 }),
        cancelPairing,
        logout: async () => ({ state: 'signed-out' as const }),
      },
    }
    store = createWorkspaceStore(bridge)
  })

  it('进入离线态：取消进行中的配对并进入 offline', async () => {
    await store.getState().loginCommunity()
    expect(store.getState().communityAuth.status).toBe('loading')
    store.getState().enterOfflineMode()
    expect(cancelPairing).toHaveBeenCalledTimes(1)
    expect(store.getState().communityAuth.status).toBe('offline')
    expect(store.getState().communityAuth.pairing).toBeNull()
  })

  it('离线态不被后台会话刷新顶回登录页；「登录社区」显式退出离线态', async () => {
    store.getState().enterOfflineMode()
    await store.getState().refreshCommunityAuth()
    expect(store.getState().communityAuth.status).toBe('offline')
    store.getState().openLoginScreen()
    expect(store.getState().communityAuth.status).toBe('signed_out')
    // 退出离线态后刷新恢复常规行为（无已保存令牌 → signed_out，不再保持 offline）
    await store.getState().refreshCommunityAuth()
    expect(store.getState().communityAuth.status).toBe('signed_out')
  })
})
