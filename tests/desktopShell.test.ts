import { beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceStore } from '../src/stores/workspace'
import { createMockBridge } from '../src/services/mockBridge'
import { DESKTOP_NAV_ITEMS, needsCommunityAuth, surfaceDirection, surfaceLabel } from '../src/components/desktop/shellContract'
import { normalizeDesktopPreferences } from '../src/components/desktop/desktopPreferences'

describe('desktop shell contract', () => {
  it('keeps the confirmed five-entry order, game as action', () => {
    expect(DESKTOP_NAV_ITEMS.map((item) => item.id)).toEqual(['dashboard', 'cloudBag', 'editor', 'settings', 'launchGame'])
    expect(DESKTOP_NAV_ITEMS.map((item) => item.label)).toEqual(['仪表盘', '云仓库', '工作区', '设置', '启动游戏'])
    expect(DESKTOP_NAV_ITEMS.map((item) => item.en)).toEqual(['Dashboard', 'Cloud Repo', 'Workspace', 'Settings', 'Launch game'])
    expect(DESKTOP_NAV_ITEMS.map((item) => item.icon)).toEqual(['layout', 'share', 'code', 'settings', 'play'])
  })

  it('cloud repo is the only online content surface and community content is gone', () => {
    expect(surfaceLabel('cloudBag')).toBe('云仓库')
    expect((DESKTOP_NAV_ITEMS.map((item) => item.id) as readonly string[]).includes('community')).toBe(false)
  })

  it('derives directional transitions from navigation order', () => {
    expect(surfaceDirection('dashboard', 'editor')).toBeGreaterThan(0)
    expect(surfaceDirection('editor', 'dashboard')).toBeLessThan(0)
    expect(surfaceDirection('dashboard', 'cloudBag')).toBeGreaterThan(0)
    expect(surfaceDirection('cloudBag', 'dashboard')).toBeLessThan(0)
  })

  it('requires the real community session only for online surfaces', () => {
    expect(needsCommunityAuth('dashboard')).toBe(true)
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
      store.getState().setActiveSurface('cloudBag')
      store.getState().openSettings('community')
      expect(store.getState().activeSurface).toBe('settings')
      expect(store.getState().settingsOpen).toBe(true)
      expect(store.getState().settingsTab).toBe('community')
      expect(store.getState().settingsReturnSurface).toBe('cloudBag')

      store.getState().setSettingsOpen(false)
      expect(store.getState().activeSurface).toBe('cloudBag')
      expect(store.getState().settingsOpen).toBe(false)
    })

    it('keeps the cloud bag session state when leaving the surface and returning', () => {
      store.getState().setCloudBagView({ slug: 'demo-repo', section: 'issues' })
      store.getState().setActiveSurface('editor')
      store.getState().setActiveSurface('cloudBag')
      expect(store.getState().cloudBagSlug).toBe('demo-repo')
      expect(store.getState().cloudBagSection).toBe('issues')
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
