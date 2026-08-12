/**
 * 图标库统一入口：业务组件只传语义名称，不直接写资源路径。
 * 图标资源来自 570+Icons-CN-v1.0.3，已筛选到 assets/icons。
 */
import type { CSSProperties } from 'react'

export type AppIconName =
  | 'search' | 'settings' | 'refresh' | 'close' | 'save' | 'delete'
  | 'add' | 'file' | 'folder' | 'font' | 'layout' | 'plus' | 'rename' | 'tools'
  | 'palette' | 'text' | 'tools'

const ICONS: Record<AppIconName, string> = {
  search: '/icons/search.svg',
  settings: '/icons/settings.svg',
  refresh: '/icons/refresh.svg',
  close: '/icons/close.svg',
  save: '/icons/save.svg',
  delete: '/icons/delete.svg',
  add: '/icons/add.svg',
  file: '/icons/file.svg',
  folder: '/icons/folder.svg',
  font: '/icons/font.svg',
  layout: '/icons/layout.svg',
  plus: '/icons/plus.svg',
  rename: '/icons/rename.svg',
  palette: '/icons/palette.svg',
  text: '/icons/text.svg',
  tools: '/icons/tools.svg',
}

export function AppIcon({ name, size = 16, className, title }: { name: AppIconName; size?: number; className?: string; title?: string }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    objectFit: 'contain',
    display: 'block',
    filter: 'brightness(0)',
    opacity: .72,
  }
  return <img src={ICONS[name]} width={size} height={size} className={className} style={style} alt={title ?? ''} title={title} aria-hidden={!title} />
}
