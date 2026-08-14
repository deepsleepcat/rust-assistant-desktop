/**
 * 图标库统一入口：业务组件只传语义名称，不直接写资源路径。
 * 图标资源来自 570+Icons-CN-v1.0.3，已筛选到 assets/icons。
 * 注意：必须用相对路径（base:'./'），绝对路径在打包后的 file:// 协议下会解析到磁盘根目录导致图标全丢。
 */
import type { CSSProperties } from 'react'

export type AppIconName =
  | 'search' | 'settings' | 'refresh' | 'close' | 'save' | 'delete'
  | 'add' | 'file' | 'folder' | 'font' | 'layout' | 'plus' | 'rename' | 'tools'
  | 'palette' | 'text' | 'check' | 'cross' | 'warn' | 'zoom' | 'box' | 'tower'
  | 'sparkle' | 'download' | 'import' | 'archive' | 'star' | 'info'

const ICONS: Record<AppIconName, string> = {
  search: './icons/search.svg',
  settings: './icons/settings.svg',
  refresh: './icons/refresh.svg',
  close: './icons/close.svg',
  save: './icons/save.svg',
  delete: './icons/delete.svg',
  add: './icons/add.svg',
  file: './icons/file.svg',
  folder: './icons/folder.svg',
  font: './icons/font.svg',
  layout: './icons/layout.svg',
  plus: './icons/plus.svg',
  rename: './icons/rename.svg',
  palette: './icons/palette.svg',
  text: './icons/text.svg',
  tools: './icons/tools.svg',
  check: './icons/check.svg',
  cross: './icons/cross.svg',
  warn: './icons/warn.svg',
  zoom: './icons/zoom.svg',
  box: './icons/box.svg',
  tower: './icons/tower.svg',
  sparkle: './icons/sparkle.svg',
  download: './icons/download.svg',
  import: './icons/import.svg',
  archive: './icons/archive.svg',
  star: './icons/star.svg',
  info: './icons/info.svg',
}

export function AppIcon({ name, size = 16, className, title }: { name: AppIconName; size?: number; className?: string; title?: string }) {
  const style: CSSProperties = {
    width: size,
    height: size,
    objectFit: 'contain',
    display: 'block',
    filter: 'var(--icon-filter, brightness(0))',
    opacity: .78,
  }
  return <img src={ICONS[name]} width={size} height={size} className={className} style={style} alt={title ?? ''} title={title} aria-hidden={!title} />
}
