import type { WorkspaceSurface } from '../../stores/types'
import type { AppIconName } from '../AppIcon'

export type DesktopNavId = Exclude<WorkspaceSurface, 'cloudBag'> | 'launchGame'
export interface DesktopNavItem {
  id: DesktopNavId
  /** 中文主标签（显示层在上） */
  label: string
  /** 小号英文提示（决策：中文在上，英文在下） */
  en: string
  icon: AppIconName
}

/** cloudBag belongs to community. Launching the game never creates a surface. */
export const DESKTOP_NAV_ITEMS: readonly DesktopNavItem[] = [
  { id: 'dashboard', label: '仪表盘', en: 'Dashboard', icon: 'layout' },
  { id: 'community', label: '社区', en: 'Community', icon: 'share' },
  { id: 'editor', label: '工作区', en: 'Workspace', icon: 'code' },
  { id: 'settings', label: '设置', en: 'Settings', icon: 'settings' },
  { id: 'launchGame', label: '启动游戏', en: 'Launch game', icon: 'play' },
]

export function navigationSurface(surface: WorkspaceSurface): Exclude<WorkspaceSurface, 'cloudBag'> {
  return surface === 'cloudBag' ? 'community' : surface
}

/** Positive = next page enters from below; negative = previous enters from above. */
export function surfaceDirection(from: WorkspaceSurface, to: WorkspaceSurface): number {
  const order = ['dashboard', 'community', 'editor', 'settings']
  return Math.sign(order.indexOf(navigationSurface(to)) - order.indexOf(navigationSurface(from)))
}

export function needsCommunityAuth(surface: WorkspaceSurface): boolean {
  return surface === 'dashboard' || surface === 'community' || surface === 'cloudBag'
}

export function surfaceLabel(surface: WorkspaceSurface): string {
  return {
    dashboard: '仪表盘',
    community: '社区',
    cloudBag: '云仓库',
    editor: '工作区',
    settings: '设置',
  }[surface]
}
