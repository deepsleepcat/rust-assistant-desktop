/**
 * 社区工作区状态测试（M33-社区）：
 * - 初始状态：编辑器工作区、推荐页签、空关注列表
 * - 工作区切换 / 页签切换 / 关注与取关
 * - 切回编辑器后原有标签与项目状态保留
 * - 关注列表为会话内状态：不写入持久化 workspace
 */
import { beforeEach, describe, expect, it } from 'vitest'
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
})
