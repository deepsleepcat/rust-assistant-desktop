import { beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge } from '../src/services/mockBridge'
import { DESKTOP_NAV_ITEMS, navigationSurface, needsCommunityAuth, surfaceDirection, surfaceLabel } from '../src/components/desktop/shellContract'
import { normalizeDesktopPreferences } from '../src/components/desktop/desktopPreferences'

describe('desktop shell contract', () => {
  it('keeps the confirmed five-entry order, game as action', () => {
    expect(DESKTOP_NAV_ITEMS.map((item) => item.id)).toEqual(['dashboard', 'community', 'editor', 'settings', 'launchGame'])
    expect(DESKTOP_NAV_ITEMS.map((item) => item.label)).toEqual(['仪表盘', '社区', '工作区', '设置', '启动游戏'])
    expect(DESKTOP_NAV_ITEMS.map((item) => item.en)).toEqual(['Dashboard', 'Community', 'Workspace', 'Settings', 'Launch game'])
    expect(DESKTOP_NAV_ITEMS.map((item) => item.icon)).toEqual(['layout', 'share', 'code', 'settings', 'play'])
  })

  it('cloudBag has no sixth entry and belongs to community navigation', () => {
    expect((DESKTOP_NAV_ITEMS.map((item) => item.id) as readonly string[]).includes('cloudBag')).toBe(false)
    expect(navigationSurface('cloudBag')).toBe('community')
    expect(navigationSurface('community')).toBe('community')
    expect(surfaceLabel('cloudBag')).toBe('云仓库')
  })

  it('derives directional transitions from navigation order', () => {
    expect(surfaceDirection('dashboard', 'editor')).toBeGreaterThan(0)
    expect(surfaceDirection('editor', 'dashboard')).toBeLessThan(0)
    expect(surfaceDirection('community', 'cloudBag')).toBe(0)
    expect(surfaceDirection('cloudBag', 'community')).toBe(0)
  })

  it('requires the real community session only for online surfaces', () => {
    expect(needsCommunityAuth('dashboard')).toBe(true)
    expect(needsCommunityAuth('community')).toBe(true)
    expect(needsCommunityAuth('cloudBag')).toBe(true)
    expect(needsCommunityAuth('editor')).toBe(false)
    expect(needsCommunityAuth('settings')).toBe(false)
  })

  it('normalizes stored display preferences without touching credentials', () => {
    expect(normalizeDesktopPreferences(null)).toEqual({ lowPerformance: false, reduceMotion: false })
    expect(normalizeDesktopPreferences({ lowPerformance: 'yes', reduceMotion: true })).toEqual({ lowPerformance: false, reduceMotion: true })
    expect(normalizeDesktopPreferences({ lowPerformance: true })).toEqual({ lowPerformance: true, reduceMotion: false })
  })

  describe('surface state transitions', () => {
    let store: ReturnType<typeof createWorkspaceStore>

    beforeEach(() => {
      store = createWorkspaceStore(createMockBridge())
    })

    it('starts without credentials in the editor workspace', () => {
      expect(store.getState().activeSurface).toBe('editor')
    })

    it('records a return surface for the full settings page', () => {
      store.getState().setActiveSurface('community')
      store.getState().openSettings('community')
      expect(store.getState().activeSurface).toBe('settings')
      expect(store.getState().settingsOpen).toBe(true)
      expect(store.getState().settingsTab).toBe('community')
      expect(store.getState().settingsReturnSurface).toBe('community')

      store.getState().setSettingsOpen(false)
      expect(store.getState().activeSurface).toBe('community')
      expect(store.getState().settingsOpen).toBe(false)
    })

    it('cloudBag switches from the community tab and restores the previous tab', () => {
      store.getState().setActiveSurface('community')
      store.getState().setCommunityTab('ranking')
      store.getState().setCommunityTab('cloudBag')
      expect(store.getState().activeSurface).toBe('cloudBag')
      expect(store.getState().communityTab).toBe('cloudBag')

      store.getState().setActiveSurface('community')
      expect(store.getState().activeSurface).toBe('community')
      expect(store.getState().communityTab).toBe('ranking')
    })

    it('keeps the community tab when leaving the surface and returning', () => {
      store.getState().setCommunityTab('me')
      store.getState().setActiveSurface('editor')
      expect(store.getState().communityTab).toBe('me')
      store.getState().setActiveSurface('community')
      expect(store.getState().communityTab).toBe('me')
    })

    it('closing the drawer state never leaks across surfaces', () => {
      store.getState().setActiveSurface('cloudBag')
      expect(store.getState().drawerSide).toBeNull()
      store.getState().setDrawerSide('left')
      store.getState().setActiveSurface('editor')
      expect(store.getState().drawerSide).toBeNull()
    })
  })
})
